/**
 * Dump what the Jio plan page actually looks like, so adapter selectors can be
 * written from real data instead of guesswork.
 *
 *   PROBE_NUMBER=<a real Jio number> node scripts/probe-jio-plans.ts
 *
 * Nothing is paid. Stops at the plan list.
 */
import { chromium } from "playwright";

const NUMBER = process.env.PROBE_NUMBER;
if (!NUMBER) {
  console.error("set PROBE_NUMBER=<a real Jio number>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: "en-IN", timezoneId: "Asia/Kolkata" });
try {
  await page.goto("https://www.jio.com/selfcare/recharge/mobility/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByLabel("Jio Number", { exact: true }).fill(NUMBER);
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.waitForTimeout(8000);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const prices = [...new Set([...bodyText.matchAll(/₹\s?[\d,]+/g)].map((m) => m[0]))].slice(0, 30);

  const candidates = await page.locator("li, article, [class*=plan], [class*=card], [data-testid]").evaluateAll((els) =>
    els
      .filter((e) => {
        const t = e.textContent ?? "";
        return /₹\s?[\d,]+/.test(t) && /\d+\s*(day|days|month|months)/i.test(t) && t.length < 400;
      })
      .slice(0, 10)
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        cls: (e.className ?? "").toString().slice(0, 90),
        testid: e.getAttribute("data-testid"),
        role: e.getAttribute("role"),
        text: (e.textContent ?? "").replace(/\s+/g, " ").slice(0, 180),
      })),
  );

  const clickable = await page.locator("button, a, [role=button]").evaluateAll((els) =>
    [...new Set(els.map((e) => (e.textContent ?? "").trim()).filter((t) => t && t.length < 45))].slice(0, 50),
  );

  console.log(JSON.stringify({
    url: page.url(),
    title: await page.title(),
    prices,
    planCandidates: candidates,
    clickableText: clickable,
    bodyHead: bodyText.slice(0, 600),
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ error: (err as Error).message, url: page.url() }, null, 2));
} finally {
  await browser.close();
}
