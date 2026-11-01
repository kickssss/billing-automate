import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { openSession } from "./core/browser.ts";
import { noHuman, readlineHumanGate } from "./core/human.ts";
import { Ledger } from "./core/ledger.ts";
import { createLogger } from "./core/log.ts";
import { runPayment, type RunResult } from "./core/runner.ts";
import { loadCardFromEnv, redactPan } from "./core/secrets.ts";
import type { Card, RunContext } from "./core/types.ts";
import { getProvider, loadProviders } from "./providers/registry.ts";

const program = new Command();
program
  .name("billing")
  .description("Provider-agnostic bill payment automation on Playwright")
  .version("0.1.0");

const dataDir = (): string => process.env.DATA_DIR ?? ".data";

interface CommonFlags {
  provider: string;
  customer: string;
  period?: string;
  headed?: boolean;
}

async function withSession<T>(
  providerId: string,
  headed: boolean | undefined,
  fn: (ctx: RunContext) => Promise<T>,
): Promise<T> {
  const log = createLogger();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = join(dataDir(), "artifacts", providerId, runId);
  await mkdir(artifactsDir, { recursive: true });

  const session = await openSession({
    providerId,
    dataDir: dataDir(),
    artifactsDir,
    headless: headed ? false : undefined,
  });
  try {
    const ctx: RunContext = { page: session.page, log, human: noHuman, artifactsDir };
    return await fn(ctx);
  } finally {
    await session.close();
  }
}

function report(result: RunResult): void {
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === "executed" && result.record.state !== "paid") {
    process.exitCode = 1;
  }
}

program
  .command("providers")
  .description("list registered providers")
  .action(() => {
    for (const p of loadProviders().values()) {
      console.log(`${p.id}\t${p.version}\t${p.displayName}`);
    }
  });

program
  .command("lookup")
  .description("read a bill without paying (always safe, always retryable)")
  .requiredOption("--provider <id>")
  .requiredOption("--customer <number>")
  .option("--period <period>")
  .option("--headed", "show the browser")
  .action(async (opts: CommonFlags) => {
    const provider = getProvider(opts.provider);
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    try {
      const result = await withSession(opts.provider, opts.headed, (ctx) =>
        runPayment(ctx, {
          provider,
          ledger,
          query: { customerNumber: opts.customer, ...(opts.period ? { period: opts.period } : {}) },
          card: null,
          mode: "dry-run",
          maxAmountMinor: Number.MAX_SAFE_INTEGER,
        }),
      );
      report(result);
    } finally {
      ledger.close();
    }
  });

program
  .command("pay")
  .description("pay a bill (dry-run unless --live is passed)")
  .requiredOption("--provider <id>")
  .requiredOption("--customer <number>")
  .requiredOption("--card <ref>", "card reference, reads BILLING_CARD_<REF>_* env vars")
  .option("--period <period>")
  .option("--live", "actually submit the payment")
  .option("--max-amount <amount>", "per-payment ceiling in rupees", "5000")
  .option("--interactive", "prompt on the terminal for OTP/CAPTCHA")
  .option("--headed", "show the browser")
  .action(async (opts: CommonFlags & { card: string; live?: boolean; maxAmount: string; interactive?: boolean }) => {
    const provider = getProvider(opts.provider);
    const card: Card = loadCardFromEnv(opts.card);
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    const mode = opts.live ? "live" : "dry-run";

    console.log(
      JSON.stringify({ provider: provider.id, customer: opts.customer, card: redactPan(card.number), mode }),
    );

    try {
      const result = await withSession(opts.provider, opts.headed, async (ctx) => {
        if (opts.interactive) ctx.human = readlineHumanGate();
        return runPayment(ctx, {
          provider,
          ledger,
          query: { customerNumber: opts.customer, ...(opts.period ? { period: opts.period } : {}) },
          card,
          mode,
          maxAmountMinor: Math.round(Number(opts.maxAmount) * 100),
        });
      });
      report(result);
    } finally {
      ledger.close();
    }
  });

program
  .command("ledger")
  .description("show recent payment attempts")
  .option("--limit <n>", "how many rows", "20")
  .action((opts: { limit: string }) => {
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    try {
      for (const r of ledger.recent(Number(opts.limit))) {
        console.log(
          [r.createdAt, r.providerId, r.customerNumber, r.state, r.amountMinor, r.receiptId ?? "-"].join("\t"),
        );
      }
    } finally {
      ledger.close();
    }
  });

await program.parseAsync(process.argv);
