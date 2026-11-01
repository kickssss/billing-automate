import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence, RunContext } from "./types.ts";

/** A screenshot per decisive step: cheap proof of what the biller showed us. */
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
