/**
 * Step inspector for the Jio flow.
 *
 *   node scripts/inspect-jio.ts --number <your Jio number>
 *
 * Opens a real window with the same profile the automation will use, gets to the
 * plan list, prints every plan it can see, then hands the browser back to you.
 * Click through to the card page, come back, press Enter, and it prints the
 * fields on whatever page you are looking at.
 *
 * Nothing is submitted. Nothing is paid.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type Page } from "playwright";

const args = process.argv.slice(2);
const get = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i > -1 ? args[i + 1] : undefined;
};
const NUMBER = get("--number") ?? process.env.PROBE_NUMBER;
if (!NUMBER) {
  console.error("usage: node scripts/inspect-jio.ts --number <Jio number>");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? ".data";
const outDir = join(dataDir, "inspect", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });

/**
 * Everything a human can see and act on, in the shape an adapter needs.
 * Role-first: that is what getByRole() will use.
 */
async function describe(page: Page, label: string) {
  const info = {
    label,
    url: page.url(),
    title: await page.title().catch(() => ""),
    fields: await page.locator("input, select, textarea").evaluateAll((els) =>
      els
        .map((e) => {
          const el = e as HTMLInputElement;
          const id = el.id;
          const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          return {
            type: el.type,
            id,
            name: el.name,
            placeholder: el.placeholder,
            ariaLabel: el.getAttribute("aria-label"),
            label: (labelEl?.textContent ?? "").trim().slice(0, 40),
            visible: (el as HTMLElement).offsetParent !== null,
          };
        })
        .filter((f) => f.visible || f.type === "hidden")
        .slice(0, 40),
    ),
    buttons: await page.locator("button, [role=button], a[role=button]").evaluateAll((els) =>
      els
        .map((e) => ({
          text: (e.textContent ?? "").trim().slice(0, 50),
          aria: e.getAttribute("aria-label"),
          visible: (e as HTMLElement).offsetParent !== null,
        }))
        .filter((b) => b.visible && b.text)
        .slice(0, 40),
    ),
    frames: page.frames().map((f) => f.url().slice(0, 120)),
  };
  await page.screenshot({ path: join(outDir, `${label}.png`), fullPage: true }).catch(() => undefined);
  return info;
}

/** Plan cards: containers whose text has both a price and a validity. */
async function readPlans(page: Page) {
  return page
    .locator("li, article, [class*=plan], [class*=Plan], [class*=card], [data-testid]")
    .evaluateAll((els) =>
      els
        .filter((e) => {
          const t = e.textContent ?? "";
          return /₹\s?[\d,]+/.test(t) && /\d+\s*(day|days|month|months)/i.test(t) && t.length < 300;
        })
        .slice(0, 12)
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          cls: (e.className ?? "").toString().slice(0, 70),
          text: (e.textContent ?? "").replace(/\s+/g, " ").slice(0, 160),
        })),
    )
    .catch(() => [] as unknown[]);
}

const context = await chromium.launchPersistentContext(join(dataDir, "profiles", "jio-mobility"), {
  headless: false,
  viewport: { width: 1400, height: 950 },
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto("https://www.jio.com/selfcare/recharge/mobility/", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Jio Number", { exact: true }).fill(NUMBER);
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();

  // Wait for a price to appear, not for the clock.
  await page.getByText(/₹\s?\d/).first().waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined);

  const plansPage = await describe(page, "1-plans");
  const plans = await readPlans(page);
  console.log(JSON.stringify({ step: plansPage, plans }, null, 2));

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.error("\n>>> browser is open. Click the plan you want, then continue to the payment page.");
  console.error(">>> come back here and press Enter.\n");
  await rl.question("");

  const cardPage = await describe(page, "2-current");
  console.log(JSON.stringify({ step: cardPage }, null, 2));
  rl.close();

  await writeFile(join(outDir, "summary.json"), JSON.stringify({ plansPage, plans, cardPage }, null, 2));
  console.error(`\nwrote ${outDir}/summary.json`);
} catch (err) {
  console.error("failed:", (err as Error).message);
  await page.screenshot({ path: join(outDir, "error.png"), fullPage: true }).catch(() => undefined);
} finally {
  await context.close();
}
