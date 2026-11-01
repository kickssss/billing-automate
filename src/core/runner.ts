import type { Logger } from "pino";
import { captureEvidence } from "./evidence.ts";
import type { Ledger, PaymentRecord } from "./ledger.ts";
import type {
  Bill,
  BillQuery,
  BillingProvider,
  Card,
  PaymentOutcome,
  RunContext,
} from "./types.ts";
import { assertCardUsable, cardFingerprint, redactPan } from "./secrets.ts";

export interface RunOptions {
  provider: BillingProvider;
  ledger: Ledger;
  query: BillQuery;
  /** Required for live runs; omit for read-only lookups. */
  card: Card | null;
  /** "dry-run" reads the bill and stops before anything is claimed. */
  mode: "dry-run" | "live";
  /** Hard ceiling per payment, in minor units. Always set one. */
  maxAmountMinor: number;
}

export type RunResult =
  | { kind: "planned"; bill: Bill }
  | { kind: "executed"; bill: Bill; record: PaymentRecord; outcome: PaymentOutcome };

export class AmountGuardError extends Error {}

/**
 * The engine. Providers only know *how* to read and pay; everything that can go
 * catastrophically wrong (retrying a payment, paying twice, paying too much) is
 * decided here, once, for every biller.
 */
export async function runPayment(ctx: RunContext, opts: RunOptions): Promise<RunResult> {
  const { provider, ledger, query, card, mode, maxAmountMinor } = opts;
  const log = ctx.log;

  if (mode === "live" && !card) throw new Error("live mode requires a card");
  if (card) assertCardUsable(card);
  log.info(
    {
      provider: provider.id,
      customer: query.customerNumber,
      card: card ? redactPan(card.number) : null,
      kind: card?.kind ?? null,
      mode,
    },
    "run starting",
  );

  // 1. Read the bill. Reading is idempotent, so this is the only phase we retry.
  const bill = await withRetry(`${provider.id}:lookupBill`, log, () => provider.lookupBill(ctx, query));

  // 2. Guards run before any money is claimed.
  if (bill.amount.amountMinor <= 0) throw new AmountGuardError("bill amount is not positive");
  if (bill.amount.amountMinor > maxAmountMinor) {
    throw new AmountGuardError(
      `bill ${bill.amount.amountMinor} exceeds ceiling ${maxAmountMinor} ${bill.amount.currency}`,
    );
  }

  if (mode === "dry-run") {
    log.info({ bill }, "dry-run: no payment claimed");
    return { kind: "planned", bill };
  }

  // 3. Exactly-once. A duplicate here throws instead of clicking submit again.
  if (!card) throw new Error("live mode requires a card");
  const record = ledger.claim(
    {
      providerId: provider.id,
      customerNumber: bill.customerNumber,
      billReference: bill.billReference,
      amount: bill.amount,
      cardFingerprint: cardFingerprint(card.number),
    },
    provider.version,
  );

  // 4. Fail closed: "submitting" is durable *before* the adapter can click Pay.
  ledger.markSubmitting(record.id);
  log.info({ paymentId: record.id, amount: bill.amount }, "submitted to provider adapter");

  let outcome: PaymentOutcome;
  try {
    outcome = await provider.payBill(ctx, { bill, card });
  } catch (err) {
    // The adapter exploded mid-flow. We do not know whether the biller charged
    // the card, so this is "unknown" — never "failed".
    const evidence = await captureEvidence(ctx, "engine-error").catch(() => null);
    outcome = {
      status: "unknown",
      message: `adapter threw after submit: ${(err as Error).message}`,
      evidence:
        evidence ?? {
          url: ctx.page.url(),
          title: "",
          capturedAt: new Date().toISOString(),
          screenshot: null,
          traceDir: ctx.artifactsDir,
        },
    };
    log.error({ err, paymentId: record.id }, "adapter threw after control hand-off");
  }

  const settled = ledger.settle(record.id, outcome);
  log.info({ paymentId: record.id, state: settled.state, receiptId: settled.receiptId }, "run settled");
  return { kind: "executed", bill, record: settled, outcome };
}

/** Exponential backoff with jitter. Only ever used for read-only steps. */
export async function withRetry<T>(
  label: string,
  log: Logger,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const delay = Math.round(500 * 2 ** (attempt - 1) * (0.5 + Math.random()));
      log.warn({ err, attempt, delay }, `${label} failed, retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
