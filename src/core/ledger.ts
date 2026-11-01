import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Money, PaymentOutcome } from "./types.ts";

/**
 * SQLite table of every attempt. Its only job: make paying the same bill twice
 * impossible, and leave a record of what happened.
 */
export type PaymentState =
  | "claimed"
  | "submitting"
  | "paid"
  | "declined"
  | "failed"
  | "needs-human"
  | "unknown"
  | "aborted";

const ALLOWED: Record<PaymentState, readonly PaymentState[]> = {
  claimed: ["submitting", "aborted"],
  submitting: ["paid", "declined", "failed", "needs-human", "unknown"],
  paid: [],
  declined: [],
  failed: [],
  "needs-human": [],
  unknown: [],
  aborted: [],
};

export interface IntentKey {
  providerId: string;
  customerNumber: string;
  billReference: string;
  amount: Money;
}

export interface PaymentRecord {
  id: string;
  providerId: string;
  providerVersion: string;
  customerNumber: string;
  billReference: string;
  amountMinor: number;
  currency: string;
  state: PaymentState;
  receiptId: string | null;
  detail: string | null;
  screenshot: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export class DuplicatePaymentError extends Error {
  readonly existing: PaymentRecord;
  constructor(existing: PaymentRecord) {
    super(
      `already a ${existing.state} record for ${existing.providerId}/${existing.customerNumber} ` +
        `bill ${existing.billReference} (id ${existing.id})`,
    );
    this.name = "DuplicatePaymentError";
    this.existing = existing;
  }
}

const now = (): string => new Date().toISOString();

export class Ledger {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
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
        state            TEXT NOT NULL,
        receipt_id       TEXT,
        detail           TEXT,
        screenshot       TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
    `);
  }

  claim(key: IntentKey, providerVersion: string): PaymentRecord {
    const id = randomUUID();
    const idempotencyKey = [
      key.providerId,
      key.customerNumber,
      key.billReference,
      String(key.amount.amountMinor),
      key.amount.currency,
    ].join("|");
    const ts = now();
    try {
      this.#db
        .prepare(
          `INSERT INTO payment (id, idempotency_key, provider_id, provider_version, customer_number,
             bill_reference, amount_minor, currency, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(id, idempotencyKey, key.providerId, providerVersion, key.customerNumber,
          key.billReference, key.amount.amountMinor, key.amount.currency, ts, ts);
    } catch (err) {
      const existing = this.#byKey(idempotencyKey);
      if (existing) throw new DuplicatePaymentError(existing);
      throw err;
    }
    const record = this.get(id);
    if (!record) throw new Error("ledger: claim disappeared");
    return record;
  }

  markSubmitting(id: string): PaymentRecord {
    return this.#move(id, "submitting", {});
  }

  /** Counts a retryable attempt (nothing was submitted). */
  bumpAttempts(id: string): void {
    this.#db.prepare("UPDATE payment SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), id);
  }

  settle(id: string, outcome: PaymentOutcome): PaymentRecord {
    switch (outcome.status) {
      case "paid":
        return this.#move(id, "paid", { receiptId: outcome.receiptId, screenshot: outcome.evidence.screenshot });
      case "declined":
        return this.#move(id, "declined", {
          detail: [outcome.code, outcome.message].filter(Boolean).join(": "),
          screenshot: outcome.evidence.screenshot,
        });
      case "needs-human":
        return this.#move(id, "needs-human", {
          detail: `${outcome.reason}: ${outcome.prompt}`,
          screenshot: outcome.evidence.screenshot,
        });
      case "unknown":
        return this.#move(id, "unknown", { detail: outcome.message, screenshot: outcome.evidence.screenshot });
      case "retry":
        return this.#move(id, "failed", { detail: outcome.reason, screenshot: outcome.evidence.screenshot });
      case "aborted":
        return this.#move(id, "aborted", { detail: outcome.reason, screenshot: outcome.evidence.screenshot });
    }
  }

  get(id: string): PaymentRecord | null {
    const row = this.#db.prepare("SELECT * FROM payment WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Deletes a row so the same plan can be tested again.
   *
   * Only rows that provably never charged anything may be forgotten. paid and
   * unknown are permanent on purpose: forgetting those is how you pay twice.
   */
  forget(id: string): { ok: true } | { ok: false; reason: string } {
    const row = this.get(id);
    if (!row) return { ok: false, reason: "no such payment" };
    const safe: PaymentState[] = ["failed", "needs-human", "aborted"];
    if (!safe.includes(row.state)) {
      return { ok: false, reason: `refusing to forget a "${row.state}" payment` };
    }
    this.#db.prepare("DELETE FROM payment WHERE id = ?").run(id);
    return { ok: true };
  }

  recent(limit = 20): PaymentRecord[] {
    const rows = this.#db.prepare("SELECT * FROM payment ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  close(): void {
    this.#db.close();
  }

  #byKey(idempotencyKey: string): PaymentRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM payment WHERE idempotency_key = ?")
      .get(idempotencyKey) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }

  #move(id: string, to: PaymentState, patch: { receiptId?: string; detail?: string; screenshot?: string | null }): PaymentRecord {
    const current = this.get(id);
    if (!current) throw new Error(`ledger: unknown payment ${id}`);
    if (!ALLOWED[current.state].includes(to)) {
      throw new Error(`ledger: ${current.state} -> ${to} not allowed`);
    }
    this.#db
      .prepare(
        `UPDATE payment SET state = ?, receipt_id = COALESCE(?, receipt_id), detail = COALESCE(?, detail),
           screenshot = COALESCE(?, screenshot), updated_at = ? WHERE id = ? AND state = ?`,
      )
      .run(to, patch.receiptId ?? null, patch.detail ?? null, patch.screenshot ?? null, now(), id, current.state);
    const updated = this.get(id);
    if (!updated) throw new Error(`ledger: ${id} vanished`);
    return updated;
  }
}

interface Row {
  id: string; idempotency_key: string; provider_id: string; provider_version: string;
  customer_number: string; bill_reference: string; amount_minor: number; currency: string;
  state: PaymentState; receipt_id: string | null; detail: string | null; screenshot: string | null;
  attempts: number; created_at: string; updated_at: string;
}

const toRecord = (r: Row): PaymentRecord => ({
  id: r.id,
  providerId: r.provider_id,
  providerVersion: r.provider_version,
  customerNumber: r.customer_number,
  billReference: r.bill_reference,
  amountMinor: r.amount_minor,
  currency: r.currency,
  state: r.state,
  receiptId: r.receipt_id,
  detail: r.detail,
  screenshot: r.screenshot,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
