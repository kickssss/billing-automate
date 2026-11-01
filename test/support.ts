import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/core/logger.ts";
import type { Bill, BillingProvider, Card, PaymentOutcome } from "../src/core/types.ts";

process.env.LOG_LEVEL = "silent";
export const log = createLogger();

export const tempArtifactsDir = (): Promise<string> => mkdtemp(join(tmpdir(), "billing-artifacts-"));

export const testCard = (over: Partial<Card> = {}): Card => ({
  number: "4111111111111111",
  expiry: "12/30",
  cvv: "123",
  nameOnCard: "Ada Lovelace",
  kind: "debit",
  ...over,
});

export const testBill = (over: Partial<Bill> = {}): Bill => ({
  providerId: "stub",
  customerNumber: "100200",
  period: "28 Days",
  amount: { amountMinor: 34_900, currency: "INR" },
  billReference: "JIO-100200-1018982",
  raw: { planId: "1018982" },
  ...over,
});

/**
 * A provider that replays a scripted list of outcomes. Tests the engine, not a
 * website: no browser, no network, no money.
 */
export function stubProvider(script: PaymentOutcome[], bill: Bill = testBill()): BillingProvider {
  let i = 0;
  return {
    id: "stub",
    displayName: "scripted stub",
    version: "test",
    async lookupBill() {
      return bill;
    },
    async payBill() {
      const next = script[Math.min(i, script.length - 1)]!;
      i++;
      return next;
    },
  };
}

const ev = { url: "about:blank", screenshot: null };

export const paidOutcome = (receiptId = "RCPT-TEST-1"): PaymentOutcome => ({
  status: "paid",
  receiptId,
  paidAt: new Date().toISOString(),
  amount: { amountMinor: 34_900, currency: "INR" },
  evidence: ev,
});

export const retryOutcome = (reason = "captcha unsolved"): PaymentOutcome => ({
  status: "retry",
  reason,
  evidence: ev,
});

export const declinedOutcome: PaymentOutcome = {
  status: "declined",
  code: "14",
  message: "Invalid card number",
  evidence: ev,
};
