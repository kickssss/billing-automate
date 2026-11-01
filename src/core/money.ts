import type { Money } from "./types.ts";

/** Parse a printed amount as text. Never let a float touch money. */
export function parseMoneyText(text: string, currency: string): Money {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const m = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`cannot parse money from "${text}"`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "0").padEnd(2, "0"));
  return { amountMinor: (whole < 0 ? -1 : 1) * (Math.abs(whole) * 100 + frac), currency: currency.toUpperCase() };
}

export const formatMoney = (m: Money, locale = "en-IN"): string =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m.amountMinor / 100);

export const sameMoney = (a: Money, b: Money): boolean =>
  a.amountMinor === b.amountMinor && a.currency.toUpperCase() === b.currency.toUpperCase();
