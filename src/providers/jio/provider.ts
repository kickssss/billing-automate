/**
 * Jio Mobility recharge — transcribed from the recording at
 * .data/recordings/jio-mobility/2026-11-01T11-22-59-044Z
 *
 * Recorded flow (10 pages):
 *   1  /selfcare/recharge/mobility/                       enter number
 *   2  /selfcare/recharge/mobility/plans/?serviceId=...   plan list
 *   3  /api/jio-common-servlet/jiocommon/redirect
 *   4  pay.jio.com/JpgWebApp/home?paramx1=...             JioPay
 *   5  pay.jio.com/JpgWebApp/home/
 *   6  pay.jio.com/JpgWebApp/add-new-card/                card entry
 *   7  pay.jio.com/JpgWebApp/go-to-pg/
 *   8  securegw.paytmpayments.in/theia/selectCurrencyPage Paytm
 *   9  callback errorCode=810                             (user stopped here)
 *  10  /selfcare/recharge/status/
 *
 * Recorded API sequence, which is what this adapter relies on:
 *   GET  /api/jio-recharge-service/recharge/mobility/number/<num>   validate
 *   GET  /api/jio-recharge-service/recharge/plans/serviceId/<num>   216 plans
 *   POST /api/jio-recharge-service/recharge/buy                    {planKey, selectedService}
 *   POST /api/jio-recharge-service/recharge/pay                    -> paymentURL
 *   POST pay.jio.com/jiopg/v1/authorize-card-operation              paymentMode "CCDC"
 *   POST securegw.paytmpayments.in/theia/api/v1/processTransaction
 *
 * No captcha anywhere in the recorded flow.
 */
import type { Page } from "playwright";
import { capture } from "../../core/evidence.ts";
import { formatMoney, sameMoney } from "../../core/money.ts";
import type { Bill, BillingProvider, Card, PaymentOutcome, RunContext } from "../../core/types.ts";

const ID = "jio-mobility";
const VERSION = "2026.11.2";
const RECHARGE = "https://www.jio.com/selfcare/recharge/mobility/";
const PLANS_API = /\/api\/jio-recharge-service\/recharge\/plans\/serviceId\//;
const NUMBER_API = /\/api\/jio-recharge-service\/recharge\/mobility\/number\//;

/** One entry of the plans API. Field names are Jio's. */
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

function flattenPlans(payload: PlansPayload): JioPlan[] {
  return (payload.planCategories ?? []).flatMap((c) => (c.subCategories ?? []).flatMap((s) => s.plans ?? []));
}

/** "Validity - 70 Days" -> "70 Days". */
function validityOf(plan: JioPlan): string | null {
  const m = /Validity\s*-\s*([^.]{1,24})/i.exec(plan.description);
  return m?.[1]?.trim() ?? null;
}

/** Rupees from the plan string amount, without touching floats. */
function rupeesToMinor(amount: string): number {
  const [whole = "0", frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

/**
 * Step 1: enter the number and wait for the two API responses that prove the
 * number is valid and give us the plan catalogue.
 *
 * Waiting on the response rather than on a selector is deliberate: the plan grid
 * is virtualised and its CSS-module class names change on every deploy.
 */
async function openPlans(ctx: RunContext, customerNumber: string): Promise<JioPlan[]> {
  const { page, log } = ctx;
  await page.goto(RECHARGE, { waitUntil: "domcontentloaded" });

  const plansDone = page.waitForResponse((r) => PLANS_API.test(r.url()) && r.status() === 200, {
    timeout: 60_000,
  });
  const numberDone = page.waitForResponse((r) => NUMBER_API.test(r.url()) && r.status() === 200, {
    timeout: 60_000,
  });

  await page.getByLabel("Jio Number", { exact: true }).fill(customerNumber);
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();

  const numberRes = await numberDone.catch(() => null);
  if (numberRes) {
    const body = (await numberRes.json().catch(() => ({}))) as {
      primaryService?: { serviceId?: string; billingType?: string };
    };
    if (!body.primaryService?.serviceId) throw new Error(customerNumber + " is not a Jio number");
    log.info({ serviceId: body.primaryService.serviceId, billingType: body.primaryService.billingType }, "number valid");
  }

  const plansRes = await plansDone;
  const payload = (await plansRes.json()) as PlansPayload;
  const plans = flattenPlans(payload);
  if (plans.length === 0) throw new Error("plans API returned no plans");
  log.info({ plans: plans.length }, "plan catalogue loaded");
  return plans;
}

/** Exact amount match. Several plans can share a price (data/OTT variants). */
function pickPlan(plans: JioPlan[], targetAmountMinor: number): JioPlan {
  const matches = plans.filter((p) => rupeesToMinor(p.amount) === targetAmountMinor);
  if (matches.length === 0) {
    const seen = [...new Set(plans.map((p) => p.amount))].slice(0, 20).join(", ");
    throw new Error(
      "no plan at " + formatMoney({ amountMinor: targetAmountMinor, currency: "INR" }) + "; available: " + seen,
    );
  }
  // Prefer the plain recharge over add-ons and vouchers.
  return matches.find((p) => p.categoryLabel.toLowerCase().includes("popular")) ?? matches[0]!;
}

/**
 * Clicks Buy on the plan card whose price equals the plan we picked.
 *
 * Class names are CSS-module hashes (Details_planCard__1lyyX) and change on
 * deploy, so match on the stable part: the class prefix plus the exact price.
 */
async function clickBuy(ctx: RunContext, plan: JioPlan): Promise<void> {
  const { page } = ctx;
  const price = "\u20b9" + Math.round(rupeesToMinor(plan.amount) / 100);

  const cards = page.locator('[class*="planCard"]');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const text = (await card.locator('[class*="planText"]').first().innerText().catch(() => "")).trim();
    if (text !== price) continue;

    const buy = card.getByRole("button", { name: /buy/i }).or(card.getByText(/^Buy$/)).first();
    await buy.click();
    return;
  }
  throw new Error("could not find a plan card priced " + price + " (scanned " + count + " cards)");
}

/** Where did clicking Buy take us? */
type Screen = "jiopay" | "otp" | "unknown";

async function afterBuy(ctx: RunContext): Promise<Screen> {
  const { page } = ctx;
  const otp = page.getByRole("textbox", { name: /otp|one.?time|verification code/i });
  try {
    await Promise.race([
      page.waitForURL(/pay\.jio\.com/, { timeout: 60_000 }),
      otp.waitFor({ state: "visible", timeout: 60_000 }),
    ]);
  } catch {
    return "unknown";
  }
  if (/pay\.jio\.com/.test(page.url())) return "jiopay";
  if (await otp.isVisible().catch(() => false)) return "otp";
  return "unknown";
}

/**
 * Card entry on pay.jio.com/JpgWebApp/add-new-card/.
 *
 * NOT covered by the recording: the trace stops at the Paytm currency page, so
 * JioPay's card form DOM was never captured. These candidates cover the shapes
 * seen around it (autocomplete attributes, cc-* names, the ids on the Paytm page).
 * If none match, the run stops with needs-human and a screenshot. That is the
 * correct outcome: do not guess a card into a page you cannot read.
 */
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
    for (const sel of CARD_FIELDS[field]) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.fill(values[field]);
        filled++;
        break;
      }
    }
  }
  return filled >= 3;
}

export function createJioProvider(): BillingProvider {
  return {
    id: ID,
    displayName: "Jio Mobility recharge",
    version: VERSION,

    /**
     * Reads the plan catalogue and returns the plan worth targetAmountMinor.
     * Verified against the live site: 216 plans, no captcha, no login.
     */
    async lookupBill(ctx: RunContext, q): Promise<Bill> {
      if (!q.targetAmountMinor) {
        throw new Error("jio-mobility needs --amount (the plan price in rupees)");
      }
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

      // Re-read the catalogue in this session: never pay a price you have not just seen.
      const plans = await openPlans(ctx, bill.customerNumber);
      const plan = plans.find((p) => p.id === bill.raw.planId);
      if (!plan) {
        return {
          status: "aborted",
          reason: "plan " + bill.raw.planId + " is no longer offered",
          evidence: await capture(ctx, "plan-gone"),
        };
      }
      if (!sameMoney(bill.amount, { amountMinor: rupeesToMinor(plan.amount), currency: "INR" })) {
        return {
          status: "aborted",
          reason: "price changed: quoted " + formatMoney(bill.amount) + ", page shows " + plan.amount,
          evidence: await capture(ctx, "price-changed"),
        };
      }

      await clickBuy(ctx, plan);
      const screen = await afterBuy(ctx);
      log.info({ screen, url: page.url() }, "left the plan page");

      if (screen === "otp") {
        return {
          status: "needs-human",
          reason: "otp",
          prompt: "Jio wants an OTP before paying " + plan.amount + " for " + bill.customerNumber,
          evidence: await capture(ctx, "otp"),
        };
      }
      if (screen !== "jiopay") {
        return {
          status: "retry",
          reason: "unexpected screen after Buy: " + page.url(),
          evidence: await capture(ctx, "after-buy-unknown"),
        };
      }

      // Card entry: the part the recording does not cover.
      const ok = await fillCard(ctx, req.card);
      if (!ok) {
        return {
          status: "needs-human",
          reason: "otp",
          prompt: "card form not recognised on " + page.url() + " — read the screenshot, then fix CARD_FIELDS",
          evidence: await capture(ctx, "card-form-unknown"),
        };
      }

      await page
        .getByRole("button", { name: /pay|proceed|continue|confirm|add card/i })
        .first()
        .click()
        .catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);

      // Everything past this point is unverified against a real transaction.
      return {
        status: "needs-human",
        reason: "3ds",
        prompt: "card submitted; confirm the outcome at " + page.url() + " — this branch is not recorded yet",
        evidence: await capture(ctx, "after-card-submit"),
      };
    },
  };
}
