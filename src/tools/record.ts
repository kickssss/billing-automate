/**
 * Discovery recorder.
 *
 *   node src/tools/record.ts --provider jio-mobility --url https://www.jio.com/selfcare/recharge/mobility/
 *
 * A window opens. Do the flow once, by hand, exactly as you normally would.
 * Come back to this terminal and press Enter. Produces:
 *
 *   trace.zip      every click, every DOM snapshot, every network call
 *   recording.har  every request and response
 *   steps.md       the URLs you visited, in order
 *   final-state.png
 *
 * Then: npx playwright show-trace .data/recordings/<provider>/<stamp>/trace.zip
 *
 * This tool only watches. It never submits anything on its own.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";

interface Args {
  provider: string;
  url: string;
  seconds: number;
  headless: boolean;
  dataDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const provider = get("--provider");
  const url = get("--url");
  if (!provider || !url) {
    throw new Error("usage: record --provider <id> --url <start-url> [--seconds N] [--headless]");
  }
  return {
    provider,
    url,
    seconds: Number(get("--seconds") ?? 0),
    headless: argv.includes("--headless"),
    dataDir: process.env.DATA_DIR ?? ".data",
  };
}

const args = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(args.dataDir, "recordings", args.provider, stamp);
await mkdir(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(join(args.dataDir, "profiles", args.provider), {
  headless: args.headless,
  viewport: { width: 1400, height: 950 },
  acceptDownloads: true,
});

await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const har = await context.tracing.startHar(join(outDir, "recording.har"));

// Record the navigation trail: it becomes the step list the adapter is built from.
const steps: Array<{ at: string; url: string }> = [];
const seen = new Set<string>();
const trail = (u: string): void => {
  if (!u.startsWith("http") || seen.has(u)) return;
  seen.add(u);
  steps.push({ at: new Date().toISOString(), url: u });
  console.log(`  [${steps.length}] ${u}`);
};
const wire = (p: import("playwright").Page): void => {
  p.on("framenavigated", (f) => {
    if (f === p.mainFrame()) trail(f.url());
  });
};
// Existing page first, then anything the flow opens later.
for (const p of context.pages()) wire(p);
context.on("page", (p) => {
  wire(p);
  p.on("close", () => console.log("  (a tab was closed)"));
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(args.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);

console.log(`\nrecording -> ${outDir}`);
console.log("do the flow in the browser window, then come back here.");
console.log("press Enter when you are done (or just close the window).\n");

if (!args.headless) {
  if (args.seconds > 0) {
    await new Promise((r) => setTimeout(r, args.seconds * 1000));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    await rl.question("");
    rl.close();
  }
} else {
  await new Promise((r) => setTimeout(r, Math.max(args.seconds, 1) * 1000));
}

// The human may have closed the window; everything below tolerates that.
const openPages = context.pages().filter((p) => !p.isClosed());
const last = openPages.at(-1);
if (last) {
  try {
    await last.screenshot({ path: join(outDir, "final-state.png"), fullPage: true, timeout: 15_000 });
  } catch (err) {
    console.log("final screenshot failed:", (err as Error).message.split("\n")[0]);
  }
} else {
  console.log("(window already closed, no final screenshot)");
}

const md = [
  `# Recorded flow: ${args.provider}`,
  "",
  `Started at ${args.url}`,
  "",
  ...steps.map((s, i) => `${i + 1}. ${s.url}`),
  "",
].join("\n");
await writeFile(join(outDir, "steps.md"), md, "utf8");

try {
  await har[Symbol.asyncDispose]();
} catch { /* har already finalised */ }
try {
  await context.tracing.stop({ path: join(outDir, "trace.zip") });
} catch (e) {
  console.log("trace stop failed:", (e as Error).message);
}
await context.close().catch(() => undefined);

console.log(`\n${steps.length} pages recorded. wrote:`);
console.log(`  ${join(outDir, "trace.zip")}`);
console.log(`  ${join(outDir, "recording.har")}`);
console.log(`  ${join(outDir, "steps.md")}`);
console.log(`\ninspect the flow:\n  npx playwright show-trace ${join(outDir, "trace.zip")}`);
