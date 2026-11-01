/**
 * The whole domain model, in one file. Read this first.
 */
import type { Page } from "playwright";
import type { Logger } from "./logger.ts";

export interface Money {
  /** Integer minor units (paise). No floats near money. */
  amountMinor: number;
  currency: string;
}

export interface Bill {
  providerId: string;
  customerNumber: string;
  period: string | null;
  amount: Money;
  /** Biller invoice number, printed on the receipt. */
  billReference: string;
  raw: Record<string, string>;
}

export type CardKind = "debit" | "prepaid" | "credit";

export interface Card {
  number: string;
  /** MM/YY */
  expiry: string;
  cvv: string;
  nameOnCard: string;
  kind: CardKind;
}

export interface Evidence {
  url: string;
  /** Null when the screenshot failed; the run still records the outcome. */
  screenshot: string | null;
}

/**
 * What a payment attempt produced. There is no "you handle it" state: a run
 * either pays or it does not.
 *
 *   paid      biller confirmed; receiptId is authoritative
 *   declined  processor said no; try another card
 *   failed    did not pay, for a stated reason
 *   retry     nothing was submitted; the engine may try again
 *   aborted   a guard tripped before submit
 */
export type PaymentOutcome =
  | { status: "paid"; receiptId: string; paidAt: string; amount: Money; evidence: Evidence }
  | { status: "declined"; code: string | null; message: string; evidence: Evidence }
  | { status: "failed"; reason: string; evidence: Evidence }
  | { status: "retry"; reason: string; evidence: Evidence }
  | { status: "aborted"; reason: string; evidence: Evidence };

export interface ChallengeRequest {
  kind: "captcha" | "otp" | "3ds";
  url: string;
  /** reCAPTCHA/Turnstile/hCaptcha sitekey when the widget exposes one. */
  siteKey: string | null;
  image: Buffer | null;
}

export interface ChallengeSolution {
  token: string;
}

/**
 * Everything the automation cannot decide by itself.
 * Wire a paid solving service here, or a human console. Both are the same port.
 */
export interface ChallengeSolver {
  readonly name: string;
  solve(req: ChallengeRequest): Promise<ChallengeSolution | null>;
}

export interface RunContext {
  page: Page;
  log: Logger;
  solver: ChallengeSolver;
  artifactsDir: string;
}

export interface BillQuery {
  customerNumber: string;
  /** Recharge-style providers: the exact plan amount to target, in minor units. */
  targetAmountMinor?: number;
}

export interface PayRequest {
  bill: Bill;
  card: Card;
}

/**
 * A provider is only a description of one website.
 * Adding a biller = write this file, register it, done.
 */
export interface BillingProvider {
  readonly id: string;
  readonly displayName: string;
  /** Bump on every selector change; stamped into the ledger. */
  readonly version: string;
  lookupBill(ctx: RunContext, q: BillQuery): Promise<Bill>;
  payBill(ctx: RunContext, req: PayRequest): Promise<PaymentOutcome>;
}
