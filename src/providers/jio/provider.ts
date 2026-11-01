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

/** Same search, by accessible label: the card inputs have no attributes to match. */
async function findByLabel(page: Page, label: RegExp): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const loc = frame.getByLabel(label).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** CSS first, then the visible label. */
async function findCardField(page: Page, field: CardFieldName): Promise<Locator | null> {
  return (await findInFrames(page, CARD_FIELDS[field].css)) ?? (await findByLabel(page, CARD_FIELDS[field].label));
}

/**
 * Card form fields, from the live add-new-card screenshot:
 *
 *   Pay via new card
 *     Card number      [4111 1111 1111 1111]  (VISA logo appears once valid)
 *     Expiry (MM/YY)   [12/30]     CVV [•••]
 *     Name on the card [__________]
 *     [ Proceed ]  <- disabled until every field is valid
 *
 * The inputs carry no autocomplete or placeholder, so labels are the reliable
 * handle. Each field is tried by CSS, then by its visible label.
 */
/**
 * Card form fields, read off the captured add-new-card markup. JioPay puts the
 * human label in the name attribute, uses no autocomplete, and gives only the
 * first input an id:
 *
 *   <input id="cardNumber" name="Card number">
 *   <input name="Expiry (MM/YY)">
 *   <input name="CVV" type="password">
 *   <input name="Name on the card">
 *
 * Exact name matches first; the loose patterns stay as a fallback for the day
 * they rename something. Verified offline against the saved page with
 * scripts/verify-selectors.ts.
 */
export const CARD_FIELDS = {
  number: {
    css: [
      "#cardNumber",
      'input[name="Card number"]',
      'input[name*="card number" i]',
      'input[autocomplete="cc-number"]',
      'input[id*="cardNumber" i]',
    ],
    label: /card number/i,
  },
  expiry: {
    css: [
      'input[name="Expiry (MM/YY)"]',
      'input[name*="expiry" i]',
      'input[autocomplete="cc-exp"]',
      "input[id*='expiry' i]",
      'input[placeholder*="mm" i]',
    ],
    label: /expiry|mm\s*\/\s*yy/i,
  },
  cvv: {
    css: [
      'input[name="CVV"]',
      'input[name*="cvv" i]',
      'input[autocomplete="cc-csc"]',
      "input[id*='cvv' i]",
      'input[placeholder*="cvv" i]',
    ],
    label: /cvv|cvc|security code/i,
  },
  name: {
    css: [
      'input[name="Name on the card"]',
      'input[name*="name on the card" i]',
      'input[name*="name on card" i]',
      'input[autocomplete="cc-name"]',
      'input[name*="cardHolder" i]',
    ],
    label: /name on the card|name on card|cardholder/i,
  },
} as const;

type CardFieldName = keyof typeof CARD_FIELDS;

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

/**
 * The gateway's payment-picker. Captured markup from the live run shows the
 * options as design-system list rows, not buttons:
 *
 *   "How would you want to pay?"
 *     UPI · Pay via QR · CRED pay · Credit/Debit/ATM Card · Wallets
 *     Pay With Rewards · Netbanking · Pay With Store credit · [Proceed]
 *
 * The label is "Credit/Debit/ATM Card". Each row is
 * <div class="j-listBlock"> ... <div class="j-listBlock__block-text">label</div>
 * and clicking the row navigates to /JpgWebApp/add-new-card/.
 */
const CARD_OPTION = /credit\s*\/\s*debit|debit\s*\/\s*credit|credit\s*debit|debit\s*card|credit\s*card|atm\s*card|^card$/i;
const CARD_ROUTE = /add-new-card/i;

/** Poll for the card form. The route change and the field mount are separate events. */
async function waitForCardForm(ctx: RunContext, timeoutMs = 30_000): Promise<boolean> {
  const { page } = ctx;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findCardField(page, "number")) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function chooseCardOption(ctx: RunContext): Promise<boolean> {
  const { page, log } = ctx;

  if (await findCardField(page, "number")) return true;

  // 1. The list row, matched on its stable design-system container.
  const row = page.locator(".j-listBlock").filter({ hasText: CARD_OPTION }).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click().catch(() => undefined);
    if (await waitForCardForm(ctx)) {
      log.info({ url: page.url() }, "card option opened");
      return true;
    }
  }

  // 2. Fall back to whatever carries the label, but click the row around it.
  const labelled = page.getByText(CARD_OPTION).first();
  if (await labelled.isVisible().catch(() => false)) {
    await labelled.click().catch(() => undefined);
    if (await waitForCardForm(ctx, 15_000)) {
      log.info({ url: page.url() }, "card option opened via label");
      return true;
    }
  }

  // 3. Some builds pick the mode first and require Proceed.
  const proceed = page.getByRole("button", { name: /proceed/i }).first();
  if (await proceed.isVisible().catch(() => false)) {
    await proceed.click().catch(() => undefined);
    if (await waitForCardForm(ctx, 15_000)) return true;
  }

  return false;
}

/**
 * Fill the card. Number first: most gateways reveal expiry and CVV only after
 * the BIN is accepted, so the later fields get their own short wait.
 */
export interface FillReport {
  filled: CardFieldName[];
  missing: CardFieldName[];
}

async function fillCard(ctx: RunContext, card: Card): Promise<FillReport> {
  const { page, log } = ctx;
  const values: Record<CardFieldName, string> = {
    number: card.number,
    expiry: card.expiry,
    cvv: card.cvv,
    name: card.nameOnCard,
  };

  /** Fill, then read the value back. A fill that silently fails must not count. */
  const fillOne = async (field: CardFieldName): Promise<boolean> => {
    const deadline = Date.now() + (field === "number" ? 15_000 : 10_000);
    while (Date.now() < deadline) {
      const loc = await findCardField(page, field);
      if (loc) {
        await loc.fill(values[field]).catch(() => undefined);
        const got = (await loc.inputValue().catch(() => "")).replace(/\s+/g, "");
        const want = values[field].replace(/\s+/g, "");
        if (got.length > 0 && got.replace(/[*\u2022]/g, "").startsWith(want.slice(0, 4))) return true;
      }
      await page.waitForTimeout(600);
    }
    return false;
  };

  const filled: CardFieldName[] = [];
  const missing: CardFieldName[] = [];
  for (const field of ["number", "expiry", "cvv", "name"] as CardFieldName[]) {
    if (await fillOne(field)) filled.push(field);
    else missing.push(field);
  }
  log.info({ filled, missing }, "card form filled");
  return { filled, missing };
}

export type SubmitResult = { label: string } | { disabled: true } | null;

/**
 * Press Proceed. It is disabled until every field is valid, so clicking it too
 * early does nothing at all — which looks exactly like a hang.
 */
async function submitCard(ctx: RunContext): Promise<SubmitResult> {
  const { page } = ctx;
  const button = page
    .getByRole("button", { name: /pay now|make payment|^pay$|proceed|confirm|continue|add card|save card/i })
    .first();
  if (!(await button.isVisible().catch(() => false))) return null;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await button.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  if (!(await button.isEnabled().catch(() => false))) return { disabled: true };

  const label = ((await button.innerText().catch(() => "")) || "submit").trim() || "submit";
  await button.click().catch(() => undefined);
  return { label };
}

/**
 * Where a result is allowed to come from.
 *
 * A marketing banner on the gateway page reads "Get up to Rs.20 Cashback On
 * Successful Mandate Registration". A /successful/i test matched that and a run
 * was recorded as paid while the card payment was still processing. Success is
 * therefore not a phrase — it is a place: the biller's own result page plus a
 * real transaction id. Nothing on the gateway's pages can ever be "paid".
 */
const BILLER_RESULT = /jio\.com\/selfcare\/recharge\/(status|receipt|confirmation)/i;
const GATEWAY_HOST = /pay\.jio\.com|paytm/i;

const SUCCESS_TEXT = /(recharge|payment)\s+(is\s+|was\s+)?(successful|completed|complete|done)|your recharge (was|is) successful|recharge successful|payment successful/i;
const PROCESSING_TEXT = /processing|in progress|pending|please wait|awaiting confirmation/i;
const REFUSED = /declined|not successful|unable to process|invalid card|rejected|transaction failed|payment failed|recharge failed/i;
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
  const started = Date.now();
  const deadline = started + 90_000;
  let lastUrl = page.url();
  let tick = 0;

  while (Date.now() < deadline) {
    tick++;
    lastUrl = page.url();
    const text = await page.locator("body").innerText().catch(() => "");
    // Progress on stderr every poll: a silent 90s looks like a hang.
    log.info({ tick, elapsed: Math.round((Date.now() - started) / 1000), url: lastUrl.slice(0, 90) }, "waiting for outcome");

    // Paid requires all three: the biller's result page, a success phrase, and
    // an id printed by the biller. No id means no proof, so no "paid".
    const onBillerResult = BILLER_RESULT.test(lastUrl) && !GATEWAY_HOST.test(lastUrl);
    const receiptId = RECEIPT.exec(text)?.[1] ?? null;

    if (onBillerResult && SUCCESS_TEXT.test(text) && !REFUSED.test(text) && receiptId) {
      log.info({ receiptId, url: lastUrl }, "payment confirmed by the biller");
      return {
        status: "paid",
        receiptId,
        paidAt: new Date().toISOString(),
        amount: bill.amount,
        evidence: await capture(ctx, "paid"),
      };
    }

    // On the biller's page with no id we saw a phrase, but nothing provable.
    if (onBillerResult && SUCCESS_TEXT.test(text) && !receiptId) {
      log.warn({ url: lastUrl }, "result page has no transaction id");
      return {
        status: "failed",
        reason: "biller result page showed success text but no transaction id; unconfirmed at " + lastUrl,
        evidence: await capture(ctx, "unconfirmed-no-id"),
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

  // Timed out. If the page was still saying "processing", the honest answer is
  // a failure we do not retry: the card may have been charged.
  const finalText = await page.locator("body").innerText().catch(() => "");
  if (PROCESSING_TEXT.test(finalText)) {
    return {
      status: "failed",
      reason: "payment still processing after 90s at " + lastUrl + " — check the card statement before retrying",
      evidence: await capture(ctx, "still-processing"),
    };
  }
  return {
    status: "failed",
    reason: "no success or failure marker within 90s; last url " + lastUrl,
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
      const { page, log } = ctx;
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

      // Keep the card page markup no matter how this ends: it is the only way to
      // learn selectors for a screen nobody has transcribed yet.
      const cardDom = await dumpDom(ctx, "card-page");
      log.info({ url: page.url(), html: cardDom }, "card form opened");

      const fill = await fillCard(ctx, req.card);
      if (fill.missing.includes("number")) {
        const dom = await dumpDom(ctx, "card-form-unknown");
        return {
          status: "failed",
          reason: "card number field not found on " + page.url() + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "card-form-unknown"),
        };
      }

      await capture(ctx, "card-filled");

      const submit = await submitCard(ctx);
      if (submit === null) {
        const dom = await dumpDom(ctx, "no-submit-button");
        return {
          status: "failed",
          reason: "no submit button on the card form" + (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "no-submit-button"),
        };
      }
      if ("disabled" in submit) {
        const dom = await dumpDom(ctx, "submit-disabled");
        return {
          status: "failed",
          reason:
            "Proceed stayed disabled after 10s; unfilled: " + (fill.missing.join(", ") || "none") +
            (dom ? " (html: " + dom + ")" : ""),
          evidence: await capture(ctx, "submit-disabled"),
        };
      }
      log.info({ submitLabel: submit.label, missing: fill.missing }, "card submitted");

      // ---- post-submit: from here on the card may be charged.
      return observeOutcome(ctx, bill);
    },
  };
}
