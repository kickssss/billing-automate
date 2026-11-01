/**
 * Domain types for billing/payment automation.
 *
 * Two rules encoded here:
 *  1. Money is integer minor units. No floats anywhere near a payment.
 *  2. Every adapter returns a closed outcome union, so "unknown" is a first-class
 *     result instead of an exception that someone eventually retries.
 */
import type { Page } from "playwright";
import type { Logger } from "pino";

export interface Money {
  /** Integer minor units (paise, cents). */
  amountMinor: number;
  /** ISO-4217 alpha code, uppercase. */
  currency: string;
}

export interface Bill {
  providerId: string;
  customerNumber: string;
  accountLabel: string | null;
  /** Billing period as printed by the biller, e.g. "2026-10" or "Oct 2026". */
  period: string | null;
  /** ISO-8601 date (YYYY-MM-DD) when known. */
  dueDate: string | null;
  amount: Money;
  /** Biller-side invoice/reference number, printed on the receipt. */
  billReference: string;
  /** Field-by-field extraction, persisted as audit evidence. */
  raw: Record<string, string>;
}

export type CardKind = "debit" | "prepaid" | "credit";

export interface Card {
  /** PAN. In memory for one payment only: never logged, never persisted. */
  number: string;
  /** "MM/YY". */
  expiry: string;
  cvv: string;
  nameOnCard: string;
  kind: CardKind;
}

export interface Evidence {
  url: string;
  title: string;
  capturedAt: string;
  screenshot: string | null;
  /** Directory holding this run's trace.zip (Playwright trace viewer). */
  traceDir: string;
}

export type NeedsHumanReason =
  | "otp"
  | "captcha"
  | "3ds-challenge"
  | "unexpected-screen";

/**
 * Closed outcome union.
 * - paid: the biller confirmed the payment; receiptId is authoritative.
 * - declined: the processor said no; safe to retry with another card.
 * - needs-human: the run stopped on purpose and a person must unblock it.
 * - unknown: we clicked submit but cannot prove the result. NEVER auto-retry.
 * - aborted: a pre-submit guard tripped; nothing was submitted.
 */
export type PaymentOutcome =
  | { status: "paid"; receiptId: string; paidAt: string; amount: Money; evidence: Evidence }
  | { status: "declined"; code: string | null; message: string; evidence: Evidence }
  | { status: "needs-human"; reason: NeedsHumanReason; prompt: string; evidence: Evidence }
  | { status: "unknown"; message: string; evidence: Evidence }
  | { status: "aborted"; reason: string; evidence: Evidence };

export interface HumanRequest {
  kind: "otp" | "captcha" | "confirm";
  prompt: string;
}

/** Port for human-in-the-loop. CLI wires a prompt; servers wire a UI/queue. */
export interface HumanGate {
  /** Resolve with the typed answer, or null when no human is available. */
  ask(req: HumanRequest): Promise<string | null>;
}

export interface RunContext {
  page: Page;
  log: Logger;
  human: HumanGate;
  artifactsDir: string;
  signal?: AbortSignal;
}

export interface BillQuery {
  customerNumber: string;
  /** Optional period filter for billers that keep history. */
  period?: string;
}

export interface PayRequest {
  bill: Bill;
  card: Card;
}

/**
 * The whole provider contract. Adding a biller means implementing this file and
 * nothing else — the engine owns retries, idempotency, evidence and secrets.
 */
export interface BillingProvider {
  readonly id: string;
  readonly displayName: string;
  /** Bump on every selector change; stamped into the ledger for forensics. */
  readonly version: string;
  lookupBill(ctx: RunContext, q: BillQuery): Promise<Bill>;
  payBill(ctx: RunContext, req: PayRequest): Promise<PaymentOutcome>;
}
