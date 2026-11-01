import { createHash } from "node:crypto";
import type { Card, CardKind } from "./types.ts";

export class SecretError extends Error {}

/** Luhn check: catches typos before we ever touch a biller form. */
export function luhnValid(pan: string): boolean {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** "4111111111111111" -> "**** **** **** 1111". Safe to log and to show. */
export function redactPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  return digits.length <= 4 ? "*".repeat(digits.length) : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Salted fingerprint used as part of the idempotency key.
 * A bare SHA-256 of a 16-digit PAN is brute-forceable, so it must be salted.
 */
export function cardFingerprint(pan: string, salt = process.env.CARD_FP_SALT ?? ""): string {
  const digits = pan.replace(/\D/g, "");
  return createHash("sha256").update(`${salt}:${digits}`).digest("hex").slice(0, 32);
}

export function assertCardUsable(card: Card, now = new Date()): void {
  if (!luhnValid(card.number)) throw new SecretError("card number failed Luhn check");
  if (!/^\d{2}\/\d{2,4}$/.test(card.expiry)) throw new SecretError("expiry must be MM/YY");
  const [mmRaw, yyRaw] = card.expiry.split("/");
  const month = Number(mmRaw);
  const year = Number(yyRaw!.length === 2 ? `20${yyRaw}` : yyRaw);
  if (month < 1 || month > 12) throw new SecretError("expiry month out of range");
  const endOfMonth = new Date(Date.UTC(year, month, 1));
  if (endOfMonth <= now) throw new SecretError("card is expired");
  if (!/^\d{3,4}$/.test(card.cvv)) throw new SecretError("cvv must be 3-4 digits");
}

const KINDS: readonly CardKind[] = ["debit", "prepaid", "credit"];

/**
 * Cards are addressed by reference ("--card demo"), never inlined on a command
 * line where they would land in shell history and process listings.
 * Swap this class for a keyring/vault implementation without touching callers.
 */
export function loadCardFromEnv(cardRef: string, env: NodeJS.ProcessEnv = process.env): Card {
  const prefix = `BILLING_CARD_${cardRef.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
  const get = (key: string): string => {
    const value = env[`${prefix}${key}`];
    if (!value) throw new SecretError(`missing ${prefix}${key}`);
    return value;
  };
  const kind = (env[`${prefix}KIND`] ?? "debit") as CardKind;
  if (!KINDS.includes(kind)) throw new SecretError(`${prefix}KIND must be one of ${KINDS.join(", ")}`);
  return {
    number: get("NUMBER").replace(/\s+/g, ""),
    expiry: get("EXPIRY"),
    cvv: get("CVV"),
    nameOnCard: get("NAME"),
    kind,
  };
}
