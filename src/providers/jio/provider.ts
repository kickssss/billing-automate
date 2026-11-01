/**
 * Jio Mobility recharge, transcribed from the recording at
 * .data/recordings/jio-mobility/2026-11-01T11-22-59-044Z
 *
 * Flow:
 *   1  /selfcare/recharge/mobility/                       enter number
 *   2  /selfcare/recharge/mobility/plans/?serviceId=...   plan list (accordion)
 *   3  /api/jio-common-servlet/jiocommon/redirect
 *   4  pay.jio.com/JpgWebApp/home?paramx1=...             JioPay, data via XHR
 *   5  pay.jio.com/JpgWebApp/add-new-card/                card entry
 *   6  securegw.paytmpayments.in/...                     Paytm processing
 *   7  callback -> /selfcare/recharge/status/             result
 *
 * APIs this adapter leans on:
 *   GET  /api/jio-recharge-service/recharge/mobility/number/<num>
 *   GET  /api/jio-recharge-service/recharge/plans/serviceId/<num>
 *   POST /api/jio-recharge-service/recharge/buy
 *   GET  pay.jio.com/jiopg/v1/payment-dashboard?paramx1=...
 *   POST pay.jio.com/jiopg/v1/authorize-card-operation
 *
 * No captcha anywhere in the recorded flow.
 */
import type { Locator, Page } from "playwright";
import { capture, dumpDom } from "../../core/evidence.ts";
import { formatMoney, sameMoney } from "../../core/money.ts";
import type { Bill, BillingProvider, Card, PaymentOutcome, RunContext } from "../../core/types.ts";

const ID = "jio-mobility";
const VERSION = "2026.11.3";
const RECHARGE = "https://www.jio.com/selfcare/recharge/mobility/";
const PLANS_API = /recharge\/plans\/serviceId\//;
const NUMBER_API = /recharge\/mobility\/number\//;
const DASHBOARD_API = /jiopg\/v1\/payment-dashboard/;
const JIOPAY = /pay\.jio\.com/;
const PAYTM = /paytm/i;

interface JioPlan {
  id: string;
  name: string;
  amount: string;
  description: string;
  /** What /recharge/buy expects verbatim, e.g. "1019036#1Z0002#Z0003#Z0006RECHARGE1g2" */
  key: string;
  planName: string;
  categoryLabel: string;
}

interface PlansPayload {
  planCategories?: Array<{ subCategories?: Array<{ plans?: JioPlan[] }> }>;
}

const flattenPlans = (p: PlansPayload): JioPlan[] =>
  (p.planCategories ?? []).flatMap((c) => (c.subCategories ?? []).flatMap((s) => s.plans ?? []));

const validityOf = (plan: JioPlan): string | null =>
  /Validity\s*-\s*([^.]{1,24})/i.exec(plan.description)?.[1]?.trim() ?? null;

/** Rupees from the plan string amount, without touching floats. */
function rupeesToMinor(amount: string): number {
  const [whole = "0", frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

const rupeeLabel = (minor: number): string => "\u20b9" + Math.round(minor / 100);

/**
 * Enter the number, then wait for the two API responses that prove it is a Jio
 * number and hand over the plan catalogue.
 *
 * Waiting on the response rather than a selector is deliberate: the grid is
 * virtualised and its CSS-module class names change on every deploy.
 */
async function openPlans(ctx: RunContext, customerNumber: string): Promise<JioPlan[]> {
  const { page, log } = ctx;
  await page.goto(RECHARGE, { waitUntil: "domcontentloaded" });

  const plansDone = page.waitForResponse((r) => PLANS_API.test(r.url()) && r.status() === 200, { timeout: 60_000 });
  const numberDone = page.waitForResponse((r) => NUMBER_API.test(r.url()) && r.status() === 200, { timeout: 60_000 });

  await page.getByLabel("Jio Number", { exact: true }).fill(customerNumber);
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();

  const numberRes = await numberDone.catch(() => null);
  if (numberRes) {
    const body = (await numberRes.json().catch(() => ({}))) as { primaryService?: { serviceId?: string } };
    if (!body.primaryService?.serviceId) throw new Error(customerNumber + " is not a Jio number");
  }

  const plans = flattenPlans((await (await plansDone).json()) as PlansPayload);
  if (plans.length === 0) throw new Error("plans API returned no plans");
  log.info({ plans: plans.length }, "plan catalogue loaded");
  return plans;
}

/** Exact amount match. Several plans can share a price (data/OTT variants). */
function pickPlan(plans: JioPlan[], targetAmountMinor: number): JioPlan {
  const matches = plans.filter((p) => rupeesToMinor(p.amount) === targetAmountMinor);
  if (matches.length === 0) {
    const seen = [...new Set(plans.map((p) => p.amount))].slice(0, 20).join(", ");
    throw new Error("no plan at " + formatMoney({ amountMinor: targetAmountMinor, currency: "INR" }) + "; available: " + seen);
  }
  return matches.find((p) => p.categoryLabel.toLowerCase().includes("popular")) ?? matches[0]!;
}

/**
 * Click Buy on the plan card priced for this plan.
 *
 * The grid is 6 collapsible sections and only one is open at a time, so most
 * plans are not in the DOM when the page settles. Look in what is rendered,
 * then open each section in turn until the card appears.
 */
async function clickBuy(ctx: RunContext, plan: JioPlan): Promise<void> {
  const { page } = ctx;
  const price = rupeeLabel(rupeesToMinor(plan.amount));
  const wanted = page.getByText(new RegExp("^" + price + "$"));

  const clickIfPresent = async (): Promise<boolean> => {
    const card = page.locator('[class*="planCard"]').filter({ has: wanted });
    if ((await card.count()) === 0) return false;
    const buy = card.first().getByRole("button", { name: /buy/i }).or(card.first().getByText(/^Buy$/)).first();
    await buy.click();
    return true;
  };

  if (await clickIfPresent()) return;

  const triggers = page.locator(".j-accordion-panel__header-trigger");
  const total = await triggers.count();
  const seen: string[] = [];
  for (let i = 0; i < total; i++) {
    const trigger = triggers.nth(i);
    const label = (await trigger.innerText().catch(() => "")).trim();
    const active = (await trigger.getAttribute("class").catch(() => ""))?.includes("active");
    seen.push(label + (active ? " [open]" : ""));
    if (!active) {
      await trigger.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
    }
    if (await clickIfPresent()) return;
  }
  throw new Error("plan " + price + " not found in any section. Sections seen: " + seen.join(" | "));
}

/** Every frame's locator: card fields may live inside the gateway iframe. */
async function findInFrames(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
  }
  return null;
}

const CARD_FIELDS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="cardNumber" i]',
    'input[id*="cardNumber" i]',
    'input[placeholder*="card number" i]',
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[name*="expiry" i]',
    'input[id*="expiry" i]',
    'input[placeholder*="mm" i]',
  ],
  cvv: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvv" i]',
    'input[id*="cvv" i]',
    'input[placeholder*="cvv" i]',
  ],
  name: [
    'input[autocomplete="cc-name"]',
    'input[name*="cardHolder" i]',
    'input[id*="cardName" i]',
    'input[placeholder*="name on card" i]',
  ],
} as const;

/**
 * JioPay is a single-page app that paints a skeleton first and fills it from
 * /jiopg/v1/payment-dashboard. The first live run's screenshot shows nothing but
 * grey placeholder bars, so anything looking for a card field before that call
 * returns is guaranteed to miss.
 *
 * Ready = the amount is on screen. The skeleton has no amount.
 */
async function waitForGateway(ctx: RunContext, amountMinor: number): Promise<boolean> {
  const { page, log } = ctx;
  await page.waitForURL(JIOPAY, { timeout: 90_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);

  const amount = new RegExp("\u20b9\\s?" + Math.round(amountMinor / 100));
  const shown = await page
    .getByText(amount)
    .first()
    .waitFor({ state: "visible", timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  log.info({ ready: shown, url: page.url() }, "gateway readiness");
  return shown;
}

/** The gateway lists payment modes first; open the card one. */
const CARD_OPTION = /debit card|credit card|cards?|add new card|add card/i;

async function chooseCardOption(ctx: RunContext): Promise<boolean> {
  const { page, log } = ctx;

  if (await findInFrames(page, CARD_FIELDS.number)) return true;

  const groups = [
    page.getByRole("button", { name: CARD_OPTION }),
    page.getByRole("link", { name: CARD_OPTION }),
    page.getByRole("radio", { name: CARD_OPTION }),
    page.getByText(CARD_OPTION),
  ];

  for (const group of groups) {
    if ((await group.count().catch(() => 0)) === 0) continue;
    await group.first().click().catch(() => undefined);
    if (await findInFrames(page, CARD_FIELDS.number)) {
      log.info({ url: page.url() }, "card option opened");
      return true;
    }
  }
  return false;
}

async function fillCard(ctx: RunContext, card: Card): Promise<boolean> {
  const { page } = ctx;
  const values: Record<keyof typeof CARD_FIELDS, string> = {
    number: card.number,
    expiry: card.expiry,
    cvv: card.cvv,
    name: card.nameOnCard,
  };

  let filled = 0;
  for (const field of Object.keys(CARD_FIELDS) as Array<keyof typeof CARD_FIELDS>) {
    const loc = await findInFrames(page, CARD_FIELDS[field]);
    if (!loc) continue;
    await loc.fill(values[field]).catch(() => undefined);
    filled++;
  }
  return filled >= 3;
}

/** Submit the card and read whatever the gateway and the biller say next. */
async function submitCard(ctx: RunContext): Promise<boolean> {
  const { page } = ctx;
  const button = page
    .getByRole("button", { name: /pay now|make payment|pay|proceed|confirm|continue|add card/i })
    .first();
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click().catch(() => undefined);
  return true;
}

const SUCCESS = /payment successful|recharge successful|successful|thank you|receipt|transaction complete/i;
const REFUSED = /declined|not successful|failed|unable to process|invalid card|rejected|transaction failed/i;
const REFUSED_CODE = /(?:declin\w*|fail\w*)[^0-9]{0,20}(\d{2,3})/i;
const RECEIPT = /(?:transaction|order|reference|receipt)\s*(?:id|no|number)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]{5,})/i;

/**
 * After the card is submitted the run leaves JioPay for the Paytm gateway and
 * comes back to Jio. There is no recorded trace of this leg, so instead of
 * guessing a URL we poll for the one thing that matters: does the page say the
 * payment worked, or that it did not.
 *
 * No human state: if neither appears before the deadline, that is a failure.
 */
async function observeOutcome(ctx: RunContext, bill: Bill): Promise<PaymentOutcome> {
  const { page, log } = ctx;
  const deadline = Date.now() + 150_000;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    lastUrl = page.url();
    const text = await page.locator("body").innerText().catch(() => "");

    if (SUCCESS.test(text) && !REFUSED.test(text)) {
      const receiptId = RECEIPT.exec(text)?.[1] ?? "JIO-" + bill.customerNumber + "-" + Date.now();
      log.info({ receiptId, url: lastUrl }, "payment reported successful");
      return {
        status: "paid",
        receiptId,
        paidAt: new Date().toISOString(),
        amount: bill.amount,
        evidence: await capture(ctx, "paid"),
      };
    }

    if (REFUSED.test(text)) {
      const code = REFUSED_CODE.exec(text)?.[1] ?? null;
      log.info({ code, url: lastUrl }, "payment refused");
      return {
        status: "declined",
        code,
        message: (text.match(REFUSED)?.[0] ?? "declined").slice(0, 120),
        evidence: await capture(ctx, "declined"),
      };
    }

    // A 3-D Secure challenge cannot be answered by this tool and must not hang
    // the run forever; treat it as a plain failure with the page captured.
    if (/3d secure|one.?time password|enter otp|verify with your bank/i.test(text)) {
      log.warn({ url: lastUrl }, "bank challenge appeared");
      return {
        status: "failed",
        reason: "bank challenge (OTP/3-D Secure) at " + lastUrl,
        evidence: await capture(ctx, "bank-challenge"),
      };
    }

    await page.waitForTimeout(2500);
  }

  return {
    status: "failed",
    reason: "no success or failure marker within 150s; last url " + lastUrl,
    evidence: await capture(ctx, "no-outcome"),
  };
}

export function createJioProvider(): BillingProvider {
  return {
    id: ID,
    displayName: "Jio Mobility recharge",
    version: VERSION,

    /**
     * Reads the plan catalogue and returns the plan worth targetAmountMinor.
     * Verified live: 198-216 plans per number, no captcha, no login.
     */
    async lookupBill(ctx: RunContext, q): Promise<Bill> {
      if (!q.targetAmountMinor) throw new Error("jio-mobility needs --amount (the plan price in rupees)");
      const plans = await openPlans(ctx, q.customerNumber);
      const plan = pickPlan(plans, q.targetAmountMinor);

      return {
        providerId: ID,
        customerNumber: q.customerNumber,
        period: validityOf(plan),
        amount: { amountMinor: rupeesToMinor(plan.amount), currency: "INR" },
        billReference: "JIO-" + q.customerNumber + "-" + plan.id,
        raw: {
          planId: plan.id,
          planKey: plan.key,
          planName: plan.planName,
          description: plan.description,
        },
      };
    },

    async payBill(ctx, req): Promise<PaymentOutcome> {
      const { page } = ctx;
      const bill = req.bill;

      // ---- pre-submit: any failure here charged nothing, so it is retryable.
      let plan: JioPlan;
      try {
        const plans = await openPlans(ctx, bill.customerNumber);
        const found = plans.find((p) => p.id === bill.raw.planId);
        if (!found) {
          return { status: "aborted", reason: "plan " + bill.raw.planId + " is no longer offered", evidence: await capture(ctx, "plan-gone") };
        }
        if (!sameMoney(bill.amount, { amountMinor: rupeesToMinor(found.amount), currency: "INR" })) {
          return {
            status: "aborted",
            reason: "price changed: quoted " + formatMoney(bill.amount) + ", page shows " + found.amount,
            evidence: await capture(ctx, "price-changed"),
          };
        }
        await clickBuy(ctx, found);
        plan = found;
      } catch (err) {
        return {
          status: "retry",
          reason: "pre-submit step failed: " + (err as Error).message,
          evidence: await capture(ctx, "pre-submit-error"),
        };
      }

      // ---- gateway: wait for the SPA to finish loading before touching it.
      if (!(await waitForGateway(ctx, bill.amount.amountMinor))) {
        const dom = await dumpDom(ctx, "gateway-not-ready");
        return {
          status: "failed",
          reason: "gateway never painted the amount" + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "gateway-not-ready"),
        };
      }

      if (!(await chooseCardOption(ctx))) {
        const dom = await dumpDom(ctx, "no-card-option");
        const labels = await page.getByRole("button").allInnerTexts().catch(() => [] as string[]);
        return {
          status: "failed",
          reason: "no card payment option found. buttons: " + labels.slice(0, 15).join(" | ") + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "no-card-option"),
        };
      }

      if (!(await fillCard(ctx, req.card))) {
        const dom = await dumpDom(ctx, "card-form-unknown");
        return {
          status: "failed",
          reason: "card form not recognised on " + page.url() + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "card-form-unknown"),
        };
      }

      if (!(await submitCard(ctx))) {
        const dom = await dumpDom(ctx, "no-submit-button");
        return {
          status: "failed",
          reason: "no submit button on the card form" + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "no-submit-button"),
        };
      }

      // ---- post-submit: from here on the card may be charged.
      return observeOutcome(ctx, bill);
    },
  };
}
