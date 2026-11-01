import type { Locator, Page } from "playwright";
import { captureEvidence } from "../../core/evidence.ts";
import { formatMoney, parseMoneyText, sameMoney } from "../../core/money.ts";
import type { Bill, BillingProvider, PaymentOutcome, RunContext } from "../../core/types.ts";

const ID = "demo-bill";
const VERSION = "2026.11.1";

export interface DemoProviderOptions {
  baseUrl: string;
}

/** Fields that must never appear in an artifact. */
const sensitive = (page: Page): Locator[] => [
  page.getByLabel("Card number"),
  page.getByLabel("CVV"),
  page.getByLabel("Expiry (MM/YY)"),
];

async function text(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(testId).textContent()) ?? "").trim();
}

async function readBill(page: Page, customerNumber: string): Promise<Bill> {
  await page.getByTestId("bill-amount").waitFor({ state: "visible" });
  const amountText = await text(page, "bill-amount");
  const currency = (await text(page, "bill-currency")) || "INR";
  return {
    providerId: ID,
    customerNumber,
    accountLabel: null,
    period: (await text(page, "bill-period")) || null,
    dueDate: null,
    amount: parseMoneyText(amountText, currency),
    billReference: await text(page, "bill-reference"),
    raw: { amountText, currency },
  };
}

type Step = "paid" | "declined" | "otp" | "unknown";

/**
 * After the submit click the page can legitimately land in three different
 * places. Racing the three markers is far more robust than `waitForURL` or a
 * fixed sleep, and it never throws on the "we are not sure" branch.
 */
async function detectStep(page: Page): Promise<Step> {
  const paid = page.getByTestId("receipt-reference");
  const declined = page.getByTestId("decline-code");
  const otp = page.getByTestId("otp-input");
  try {
    await paid.or(declined).or(otp).first().waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    return "unknown";
  }
  if (await paid.isVisible()) return "paid";
  if (await declined.isVisible()) return "declined";
  if (await otp.isVisible()) return "otp";
  return "unknown";
}

export function createDemoProvider(opts: DemoProviderOptions): BillingProvider {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    id: ID,
    displayName: "Demo Biller (bundled fixture site)",
    version: VERSION,

    async lookupBill(ctx: RunContext, q): Promise<Bill> {
      const { page } = ctx;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Customer number").fill(q.customerNumber);
      await page.getByRole("button", { name: "View bill" }).click();
      return readBill(page, q.customerNumber);
    },

    async payBill(ctx: RunContext, req): Promise<PaymentOutcome> {
      const { page, log } = ctx;
      const bill = req.bill;

      // Re-enter the flow and re-read the bill. Never pay an amount you did not
      // observe in the same browser session you are about to submit from.
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Customer number").fill(bill.customerNumber);
      await page.getByRole("button", { name: "View bill" }).click();
      const live = await readBill(page, bill.customerNumber);

      if (!sameMoney(live.amount, bill.amount)) {
        return {
          status: "aborted",
          reason: `amount changed between lookup (${formatMoney(bill.amount)}) and payment (${formatMoney(live.amount)})`,
          evidence: await captureEvidence(ctx, "amount-changed"),
        };
      }

      await page.getByRole("button", { name: "Pay now" }).click();
      await page.getByLabel("Card number").waitFor({ state: "visible" });
      await page.getByLabel("Name on card").fill(req.card.nameOnCard);
      await page.getByLabel("Card number").fill(req.card.number);
      await page.getByLabel("Expiry (MM/YY)").fill(req.card.expiry);
      await page.getByLabel("CVV").fill(req.card.cvv);

      // Last look before the irreversible click, with the PAN masked out.
      const preSubmit = await captureEvidence(ctx, "before-submit", { mask: sensitive(page) });
      log.info({ paymentUrl: preSubmit.url }, "submitting card payment");

      await page.getByRole("button", { name: "Confirm payment" }).click();
      let step = await detectStep(page);

      if (step === "otp") {
        const prompt = `OTP required to pay ${formatMoney(bill.amount)} ${bill.amount.currency} for ${bill.customerNumber}`;
        const code = await ctx.human.ask({ kind: "otp", prompt });
        if (!code) {
          return {
            status: "needs-human",
            reason: "otp",
            prompt,
            evidence: await captureEvidence(ctx, "otp-required", { mask: sensitive(page) }),
          };
        }
        await page.getByTestId("otp-input").fill(code);
        await page.getByRole("button", { name: "Verify" }).click();
        step = await detectStep(page);
      }

      if (step === "paid") {
        const receiptId = await text(page, "receipt-reference");
        const paidAmount = parseMoneyText(await text(page, "receipt-amount"), bill.amount.currency);
        const evidence = await captureEvidence(ctx, "receipt");

        // A receipt that disagrees with the bill is a reconciliation problem,
        // not a success: surface it as unknown so nothing auto-retries.
        if (!sameMoney(paidAmount, bill.amount)) {
          return {
            status: "unknown",
            message: `receipt ${receiptId} shows ${formatMoney(paidAmount)} but bill was ${formatMoney(bill.amount)}`,
            evidence,
          };
        }
        return {
          status: "paid",
          receiptId,
          paidAt: new Date().toISOString(),
          amount: paidAmount,
          evidence,
        };
      }

      if (step === "declined") {
        return {
          status: "declined",
          code: (await text(page, "decline-code")) || null,
          message: (await text(page, "decline-message")) || "declined",
          evidence: await captureEvidence(ctx, "declined"),
        };
      }

      // The third branch that everyone forgets: we clicked, and we genuinely do
      // not know. Report it; never retry it.
      return {
        status: "unknown",
        message: "no receipt, decline or OTP marker appeared after submit",
        evidence: await captureEvidence(ctx, "unknown-after-submit"),
      };
    },
  };
}
