import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "playwright";
import type { Evidence, RunContext } from "./types.ts";

/**
 * A screenshot per decisive step is the cheapest audit trail that survives
 * "did we actually pay this?". Wire these into the ledger, not into /tmp.
 *
 * `mask` is mandatory hygiene: a screenshot taken on a card form otherwise
 * copies the PAN and CVV into an artifact directory that gets backed up.
 */
export async function captureEvidence(
  ctx: RunContext,
  label: string,
  opts: { mask?: Locator[] } = {},
): Promise<Evidence> {
  await mkdir(ctx.artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}-${label.replace(/[^a-z0-9-]+/gi, "-")}`;

  let screenshot: string | null = null;
  try {
    const path = join(ctx.artifactsDir, `${base}.png`);
    await ctx.page.screenshot({ path, fullPage: true, mask: opts.mask ?? [] });
    screenshot = path;
  } catch (err) {
    ctx.log.warn({ err, label }, "evidence screenshot failed");
  }

  return {
    url: ctx.page.url(),
    title: await ctx.page.title().catch(() => ""),
    capturedAt: new Date().toISOString(),
    screenshot,
    traceDir: ctx.artifactsDir,
  };
}
