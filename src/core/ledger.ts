import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Money, PaymentOutcome } from "./types.ts";

/**
 * Money-moving side effects cannot be retried, rolled back or un-clicked. The
 * ledger is the only thing standing between an operator and a double payment:
 *
 *   claim -> submitting -> paid | declined | needs-human | unknown | aborted
 *
 * "submitting" is written *before* the adapter gets control, so a crash mid-flow
 * leaves the record in a state that refuses automatic retries. Failing closed is
 * the whole point.
 */
export type PaymentState =
  | "claimed"
  | "submitting"
  | "paid"
  | "declined"
  | "needs-human"
  | "unknown"
  | "aborted";

const ALLOWED: Record<PaymentState, readonly PaymentState[]> = {
  claimed: ["submitting", "aborted"],
  submitting: ["paid", "declined", "needs-human", "unknown"],
  paid: [],
  declined: [],
  "needs-human": [],
  unknown: [],
  aborted: [],
};

export interface IntentKey {
  providerId: string;
  customerNumber: string;
  billReference: string;
  amount: Money;
  cardFingerprint: string;
}

export interface PaymentRecord {
  id: string;
  idempotencyKey: string;
  providerId: string;
  providerVersion: string;
  customerNumber: string;
  billReference: string;
  amountMinor: number;
  currency: string;
  cardFingerprint: string;
  state: PaymentState;
  receiptId: string | null;
  detail: string | null;
  screenshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export class DuplicatePaymentError extends Error {
  readonly existing: PaymentRecord;
  constructor(existing: PaymentRecord) {
    super(
      `refusing to pay twice: ${existing.providerId}/${existing.customerNumber} ` +
        `already has a ${existing.state} record for this bill+card (id ${existing.id})`,
    );
    this.name = "DuplicatePaymentError";
    this.existing = existing;
  }
}

export class IllegalTransitionError extends Error {}

const now = (): string => new Date().toISOString();

export class Ledger {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 4000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS payment (
        id               TEXT PRIMARY KEY,
        idempotency_key  TEXT NOT NULL UNIQUE,
        provider_id      TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        customer_number  TEXT NOT NULL,
        bill_reference   TEXT NOT NULL,
        amount_minor     INTEGER NOT NULL,
        currency         TEXT NOT NULL,
        card_fingerprint TEXT NOT NULL,
        state            TEXT NOT NULL,
        receipt_id       TEXT,
        detail           TEXT,
        screenshot       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payment_by_account
        ON payment (provider_id, customer_number, created_at DESC);
    `);
  }

  /** Insert-or-fail. The UNIQUE index is the real mutex. */
  claim(key: IntentKey, providerVersion: string): PaymentRecord {
    const id = randomUUID();
    const idempotencyKey = [
      key.providerId,
      key.customerNumber,
      key.billReference,
      String(key.amount.amountMinor),
      key.amount.currency,
      key.cardFingerprint,
    ].join("|");
    const ts = now();
    try {
      this.#db
        .prepare(
          `INSERT INTO payment (id, idempotency_key, provider_id, provider_version, customer_number,
             bill_reference, amount_minor, currency, card_fingerprint, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(
          id,
          idempotencyKey,
          key.providerId,
          providerVersion,
          key.customerNumber,
          key.billReference,
          key.amount.amountMinor,
          key.amount.currency,
          key.cardFingerprint,
          ts,
          ts,
        );
    } catch (err) {
      const existing = this.#findByKey(idempotencyKey);
      if (existing) throw new DuplicatePaymentError(existing);
      throw err;
    }
    const record = this.get(id);
    if (!record) throw new Error("ledger: claim vanished immediately after insert");
    return record;
  }

  markSubmitting(id: string): PaymentRecord {
    return this.#transition(id, "submitting", {});
  }

  settle(id: string, outcome: PaymentOutcome): PaymentRecord {
    switch (outcome.status) {
      case "paid":
        return this.#transition(id, "paid", {
          receiptId: outcome.receiptId,
          screenshot: outcome.evidence.screenshot,
        });
      case "declined":
        return this.#transition(id, "declined", {
          detail: [outcome.code, outcome.message].filter(Boolean).join(": "),
          screenshot: outcome.evidence.screenshot,
        });
      case "needs-human":
        return this.#transition(id, "needs-human", {
          detail: `${outcome.reason}: ${outcome.prompt}`,
          screenshot: outcome.evidence.screenshot,
        });
      case "unknown":
        return this.#transition(id, "unknown", {
          detail: outcome.message,
          screenshot: outcome.evidence.screenshot,
        });
      case "aborted":
        return this.#transition(id, "aborted", {
          detail: outcome.reason,
          screenshot: outcome.evidence.screenshot,
        });
    }
  }

  get(id: string): PaymentRecord | null {
    const row = this.#db.prepare("SELECT * FROM payment WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  recent(limit = 20): PaymentRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM payment ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  close(): void {
    this.#db.close();
  }

  #findByKey(idempotencyKey: string): PaymentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM payment WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  #transition(
    id: string,
    to: PaymentState,
    patch: { receiptId?: string; detail?: string; screenshot?: string | null },
  ): PaymentRecord {
    const current = this.get(id);
    if (!current) throw new Error(`ledger: unknown payment ${id}`);
    if (!ALLOWED[current.state].includes(to)) {
      throw new IllegalTransitionError(`ledger: ${current.state} -> ${to} is not allowed`);
    }
    this.#db
      .prepare(
        `UPDATE payment
            SET state = ?, receipt_id = COALESCE(?, receipt_id), detail = COALESCE(?, detail),
                screenshot = COALESCE(?, screenshot), updated_at = ?
          WHERE id = ? AND state = ?`,
      )
      .run(to, patch.receiptId ?? null, patch.detail ?? null, patch.screenshot ?? null, now(), id, current.state);

    const updated = this.get(id);
    if (!updated) throw new Error(`ledger: payment ${id} disappeared during transition`);
    return updated;
  }
}

interface Row {
  id: string;
  idempotency_key: string;
  provider_id: string;
  provider_version: string;
  customer_number: string;
  bill_reference: string;
  amount_minor: number;
  currency: string;
  card_fingerprint: string;
  state: PaymentState;
  receipt_id: string | null;
  detail: string | null;
  screenshot: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): PaymentRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    customerNumber: row.customer_number,
    billReference: row.bill_reference,
    amountMinor: row.amount_minor,
    currency: row.currency,
    cardFingerprint: row.card_fingerprint,
    state: row.state,
    receiptId: row.receipt_id,
    detail: row.detail,
    screenshot: row.screenshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
