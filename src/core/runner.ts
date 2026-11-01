import { capture } from "./evidence.ts";
import type { Ledger, PaymentRecord } from "./ledger.ts";
import type { Bill, BillQuery, BillingProvider, Card, PaymentOutcome, RunContext } from "./types.ts";
import { assertCardUsable } from "./cards.ts";

export interface RunOptions {
  provider: BillingProvider;
  ledger: Ledger;
  query: BillQuery;
  card: Card | null;
  /** dry-run reads the bill and stops. Default. */
  mode: "dry-run" | "live";
  /** Ceiling per payment, minor units. */
  maxAmountMinor: number;
  /** How many times to retry a non-submitted payment attempt. */
  maxAttempts?: number;
}

export type RunResult =
  | { kind: "planned"; bill: Bill }
  | { kind: "executed"; bill: Bill; record: PaymentRecord; outcome: PaymentOutcome };

export class GuardError extends Error {}

/**
 * The flow. Everything else in the repo supports these 40 lines.
 *
 *   read bill (retryable)
 *     -> guards
 *     -> dry-run? stop
 *     -> claim in ledger (blocks double payment)
 *     -> attempt payment, retry only if nothing was submitted
 *     -> settle
 */
export async function runPayment(ctx: RunContext, opts: RunOptions): Promise<RunResult> {
  const { provider, ledger, query, card, mode, maxAmountMinor } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const log = ctx.log;

  if (mode === "live" && !card) throw new Error("live mode needs a card");
  if (card) assertCardUsable(card);

  // 1. Read the bill. Reading is safe, so this is the only retried I/O.
  const bill = await withRetry(log, `${provider.id}:lookupBill`, () => provider.lookupBill(ctx, query));
  log.info({ provider: provider.id, customer: bill.customerNumber, amount: bill.amount, ref: bill.billReference }, "bill read");

  // 2. Guards, before anything is claimed.
  if (bill.amount.amountMinor <= 0) throw new GuardError("bill amount is not positive");
  if (bill.amount.amountMinor > maxAmountMinor) {
    throw new GuardError(`bill ${bill.amount.amountMinor} exceeds ceiling ${maxAmountMinor}`);
  }
  if (mode === "dry-run") return { kind: "planned", bill };
  if (!card) throw new Error("live mode needs a card");

  // 3. Exactly-once. A duplicate throws here instead of clicking Pay again.
  const record = ledger.claim(
    { providerId: provider.id, customerNumber: bill.customerNumber, billReference: bill.billReference, amount: bill.amount },
    provider.version,
  );
  ledger.markSubmitting(record.id);
  log.info({ paymentId: record.id }, "payment claimed");

  // 4. Attempt, retrying only outcomes that never reached the biller.
  let outcome: PaymentOutcome = { status: "retry", reason: "not attempted", evidence: await capture(ctx, "start") };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      outcome = await provider.payBill(ctx, { bill, card });
    } catch (err) {
      // The adapter died mid-flow. It may or may not have submitted, so this is
      // a failure we do not retry; "unconfirmed" in the reason is the flag that
      // tells a human to check the card statement.
      outcome = {
        status: "failed",
        reason: `adapter threw after submit (unconfirmed): ${(err as Error).message}`,
        evidence: await capture(ctx, "error"),
      };
    }
    log.info({ attempt, status: outcome.status }, "attempt finished");

    if (outcome.status !== "retry") break;
    ledger.bumpAttempts(record.id);
    if (attempt < maxAttempts) log.warn({ attempt, reason: outcome.reason }, "retrying (nothing submitted)");
  }

  const settled = ledger.settle(record.id, outcome);
  log.info({ paymentId: record.id, state: settled.state, receiptId: settled.receiptId }, "settled");
  return { kind: "executed", bill, record: settled, outcome };
}

async function withRetry<T>(log: RunContext["log"], label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i === attempts) break;
      log.warn({ err, attempt: i }, `${label} failed, retrying`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
  throw last;
}
