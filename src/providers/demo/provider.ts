import type { Page } from "playwright";
import { capture } from "../../core/evidence.ts";
import { formatMoney, parseMoneyText, sameMoney } from "../../core/money.ts";
import type { Bill, BillingProvider, PaymentOutcome, RunContext } from "../../core/types.ts";

const ID = "demo-bill";
const VERSION = "2026.11.2";

export interface DemoProviderOptions {
  baseUrl: string;
}

type Step = "paid" | "declined" | "otp" | "captcha" | "unknown";

const text = async (page: Page, testId: string): Promise<string> =>
  ((await page.getByTestId(testId).textContent()) ?? "").trim();

async function readBill(page: Page, customerNumber: string): Promise<Bill> {
  await page.getByTestId("bill-amount").waitFor({ state: "visible" });
  const amountText = await text(page, "bill-amount");
  const currency = (await text(page, "bill-currency")) || "INR";
  return {
    providerId: ID,
    customerNumber,
    period: (await text(page, "bill-period")) || null,
    amount: parseMoneyText(amountText, currency),
    billReference: await text(page, "bill-reference"),
    raw: { amountText, currency },
  };
}

/**
 * After a submit the page can land in five places. Race the markers; never sleep.
 */
async function detectStep(page: Page): Promise<Step> {
  const paid = page.getByTestId("receipt-reference");
  const declined = page.getByTestId("decline-code");
  const captcha = page.getByTestId("captcha-widget");
  const otp = page.getByTestId("otp-input");
  try {
    await paid.or(declined).or(captcha).or(otp).first().waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    return "unknown";
  }
  if (await paid.isVisible()) return "paid";
  if (await declined.isVisible()) return "declined";
  if (await captcha.isVisible()) return "captcha";
  if (await otp.isVisible()) return "otp";
  return "unknown";
}

export function createDemoProvider(opts: DemoProviderOptions): BillingProvider {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    id: ID,
    displayName: "Demo Biller (bundled fixture)",
    version: VERSION,

    async lookupBill(ctx: RunContext, q): Promise<Bill> {
      const { page } = ctx;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Customer number").fill(q.customerNumber);
      await page.getByRole("button", { name: "View bill" }).click();
      return readBill(page, q.customerNumber);
    },

    async payBill(ctx, req): Promise<PaymentOutcome> {
      const { page, log } = ctx;
      const bill = req.bill;

      // Re-enter and re-read: never pay an amount you did not just see.
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Customer number").fill(bill.customerNumber);
      await page.getByRole("button", { name: "View bill" }).click();
      const live = await readBill(page, bill.customerNumber);
      if (!sameMoney(live.amount, bill.amount)) {
        return {
          status: "aborted",
          reason: `amount changed: quoted ${formatMoney(bill.amount)}, page shows ${formatMoney(live.amount)}`,
          evidence: await capture(ctx, "amount-changed"),
        };
      }

      await page.getByRole("button", { name: "Pay now" }).click();
      await page.getByLabel("Card number").waitFor({ state: "visible" });
      await page.getByLabel("Name on card").fill(req.card.nameOnCard);
      await page.getByLabel("Card number").fill(req.card.number);
      await page.getByLabel("Expiry (MM/YY)").fill(req.card.expiry);
      await page.getByLabel("CVV").fill(req.card.cvv);
      await page.getByRole("button", { name: "Confirm payment" }).click();

      let step = await detectStep(page);

      // CAPTCHA: hand it to the solver, inject the token, submit again.
      if (step === "captcha") {
        const widget = page.getByTestId("captcha-widget");
        const siteKey = await widget.getAttribute("data-sitekey");
        const solution = await ctx.solver.solve({
          kind: "captcha",
          url: page.url(),
          siteKey,
          image: null,
        });
        if (!solution) {
          return {
            status: "retry",
            reason: `captcha unsolved (solver=${ctx.solver.name})`,
            evidence: await capture(ctx, "captcha-unsolved"),
          };
        }
        log.info({ solver: ctx.solver.name }, "captcha solved");
        await page.getByTestId("captcha-token").fill(solution.token);
        await page.getByRole("button", { name: "Continue" }).click();
        step = await detectStep(page);
        if (step === "captcha") {
          return {
            status: "retry",
            reason: "captcha token rejected by the biller",
            evidence: await capture(ctx, "captcha-rejected"),
          };
        }
      }

      // OTP needs a phone. Not solvable here, so report it and stop.
      if (step === "otp") {
        return {
          status: "needs-human",
          reason: "otp",
          prompt: `OTP required for ${bill.customerNumber} (${formatMoney(bill.amount)})`,
          evidence: await capture(ctx, "otp-required"),
        };
      }

      if (step === "paid") {
        const receiptId = await text(page, "receipt-reference");
        const paidAmount = parseMoneyText(await text(page, "receipt-amount"), bill.amount.currency);
        const evidence = await capture(ctx, "receipt");
        if (!sameMoney(paidAmount, bill.amount)) {
          return { status: "unknown", message: `receipt ${receiptId} shows ${formatMoney(paidAmount)}`, evidence };
        }
        return { status: "paid", receiptId, paidAt: new Date().toISOString(), amount: paidAmount, evidence };
      }

      if (step === "declined") {
        return {
          status: "declined",
          code: (await text(page, "decline-code")) || null,
          message: (await text(page, "decline-message")) || "declined",
          evidence: await capture(ctx, "declined"),
        };
      }

      return {
        status: "unknown",
        message: "no receipt, decline, captcha or OTP marker after submit",
        evidence: await capture(ctx, "unknown-after-submit"),
      };
    },
  };
}
