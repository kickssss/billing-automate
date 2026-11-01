/**
 * Check the adapter's real card-field selectors against a saved page.
 * No network, no payment: load the HTML, run the locators, print the winner.
 *
 *   node scripts/verify-selectors.ts <saved.html>
 */
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { CARD_FIELDS } from "../src/providers/jio/provider.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-selectors.ts <saved.html>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(await readFile(file, "utf8"), { waitUntil: "domcontentloaded" });

let bad = 0;
for (const field of Object.keys(CARD_FIELDS) as Array<keyof typeof CARD_FIELDS>) {
  const hits: string[] = [];
  let winner: string | null = null;
  for (const sel of CARD_FIELDS[field].css) {
    const n = await page.locator(sel).count();
    hits.push(sel + "=" + n);
    if (!winner && n > 0) winner = sel;
  }
  if (!winner) bad++;
  console.log(field.padEnd(8), winner ? "OK   " + winner : "MISS ", " [" + hits.join("  ") + "]");
}

await browser.close();
process.exit(bad === 0 ? 0 : 1);
