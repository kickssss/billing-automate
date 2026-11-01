import { readFile } from "node:fs/promises";
import type { Card, CardKind } from "./types.ts";

/**
 * Cards live in one plain JSON file. No vault, no env indirection:
 * config/cards.json -> { "demo": { number, expiry, cvv, nameOnCard, kind } }
 */
export type CardStore = Record<string, Card>;

export async function loadCards(path = process.env.CARDS_FILE ?? "config/cards.json"): Promise<CardStore> {
  return JSON.parse(await readFile(path, "utf8")) as CardStore;
}

export async function getCard(ref: string, path?: string): Promise<Card> {
  const cards = await loadCards(path);
  const card = cards[ref];
  if (!card) throw new Error(`no card "${ref}" in card store; have: ${Object.keys(cards).join(", ")}`);
  return card;
}

/** Catches typos before a gateway spends a transaction declining them. */
export function luhnValid(pan: string): boolean {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function assertCardUsable(card: Card, now = new Date()): void {
  if (!luhnValid(card.number)) throw new Error("card number failed Luhn check");
  const m = /^(\d{2})\/(\d{2,4})$/.exec(card.expiry);
  if (!m) throw new Error("expiry must be MM/YY");
  const month = Number(m[1]);
  const year = Number(m[2]!.length === 2 ? `20${m[2]}` : m[2]);
  if (month < 1 || month > 12) throw new Error("expiry month out of range");
  if (new Date(Date.UTC(year, month, 1)) <= now) throw new Error("card is expired");
  if (!/^\d{3,4}$/.test(card.cvv)) throw new Error("cvv must be 3-4 digits");
}

export const KINDS: readonly CardKind[] = ["debit", "prepaid", "credit"];
