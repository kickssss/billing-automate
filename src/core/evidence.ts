import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence, RunContext } from "./types.ts";

/** A screenshot per decisive step: cheap proof of what the biller showed us. */
/**
 * Save the page's HTML next to the screenshot.
 *
 * A screenshot shows you what a screen looks like; the HTML tells you the ids,
 * names and autocomplete attributes the adapter needs. Single-page apps never
 * re-fetch a document, so the network log has nothing for these routes — this is
 * the only way to get their markup.
 */
export async function dumpDom(ctx: RunContext, label: string): Promise<string | null> {
  await mkdir(ctx.artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(ctx.artifactsDir, `${stamp}-${label.replace(/[^a-z0-9-]+/gi, "-")}.html`);
  try {
    await writeFile(path, await ctx.page.content(), "utf8");
    return path;
  } catch (err) {
    ctx.log.warn({ err }, "dom dump failed");
    return null;
  }
}

export async function capture(ctx: RunContext, label: string): Promise<Evidence> {
  await mkdir(ctx.artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let screenshot: string | null = null;
  try {
    screenshot = join(ctx.artifactsDir, `${stamp}-${label.replace(/[^a-z0-9-]+/gi, "-")}.png`);
    await ctx.page.screenshot({ path: screenshot, fullPage: true });
  } catch (err) {
    ctx.log.warn({ err }, "screenshot failed");
    screenshot = null;
  }
  return { url: ctx.page.url(), screenshot };
}
