/**
 * Discovery recorder — the answer to "only the human knows the flow".
 *
 *   node src/tools/record.ts --provider acme-electric --url https://acme.example/login
 *
 * Open the browser, hand the mouse to the person who knows the process, and have
 * them do the whole thing once, exactly as they normally would. This records:
 *
 *   trace.zip  every click, DOM snapshot, network call and source line
 *   *.har      every request/response
 *   *.png      a screenshot at each stop
 *
 * Then open the trace (npx playwright show-trace <file>) and read the real flow
 * instead of interviewing someone about it. A 20-minute trace replaces a week of
 * "what do you click next?".
 *
 * Nothing is submitted by this tool. It only observes.
 */
import { mkdir } from "node:fs/promises";
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
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(args.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);

console.log(`recording -> ${outDir}`);
console.log("do the flow in the browser window; come back here when you are done");

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

await page.screenshot({ path: join(outDir, "final-state.png"), fullPage: true });
await har[Symbol.asyncDispose]();
await context.tracing.stop({ path: join(outDir, "trace.zip") });
await context.close();

console.log(`\nwrote:\n  ${join(outDir, "trace.zip")}\n  ${join(outDir, "recording.har")}\n  ${join(outDir, "final-state.png")}`);
console.log(`\ninspect the flow:\n  npx playwright show-trace ${join(outDir, "trace.zip")}`);
