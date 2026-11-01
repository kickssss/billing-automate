import type { Money } from "./types.ts";

/**
 * Never let a float touch money. "1,234.50" -> 123450, parsed as text.
 */
export function parseMoneyText(text: string, currency: string): Money {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const match = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new Error(`cannot parse money from "${text}"`);
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "0").padEnd(2, "0"));
  const sign = whole < 0 ? -1 : 1;
  return { amountMinor: sign * (Math.abs(whole) * 100 + frac), currency: currency.toUpperCase() };
}

export function formatMoney(money: Money, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    money.amountMinor / 100,
  );
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency.toUpperCase() === b.currency.toUpperCase();
}
