import { expect, test } from "@playwright/test";
import { formatMoney, parseMoneyText, sameMoney } from "../src/core/money.ts";
import { luhnValid, redactPan } from "../src/core/secrets.ts";

test("parses formatted amounts without floats", () => {
  expect(parseMoneyText("1,234.50", "INR")).toEqual({ amountMinor: 123450, currency: "INR" });
  expect(parseMoneyText("₹ 999", "INR")).toEqual({ amountMinor: 99900, currency: "INR" });
  expect(parseMoneyText("0.07", "INR")).toEqual({ amountMinor: 7, currency: "INR" });
});

test("round-trips money", () => {
  const money = { amountMinor: 1234567, currency: "INR" };
  expect(parseMoneyText(formatMoney(money), "INR")).toEqual(money);
  expect(sameMoney(money, { ...money })).toBe(true);
});

test("card helpers", () => {
  expect(luhnValid("4111111111111111")).toBe(true);
  expect(luhnValid("4111111111111112")).toBe(false);
  expect(redactPan("4111111111111111")).toBe("************1111");
});
