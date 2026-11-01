import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { openSession } from "./core/browser.ts";
import { assertCardUsable, getCard } from "./core/cards.ts";
import { Ledger } from "./core/ledger.ts";
import { createLogger } from "./core/logger.ts";
import { runPayment, type RunResult } from "./core/runner.ts";
import type { RunContext } from "./core/types.ts";
import { getProvider, loadProviders, loadSolver } from "./providers/registry.ts";

const program = new Command();
program.name("billing").description("Bill payment automation").version("0.2.0");

const dataDir = (): string => process.env.DATA_DIR ?? ".data";

async function withSession<T>(providerId: string, fn: (ctx: RunContext) => Promise<T>): Promise<T> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = join(dataDir(), "artifacts", providerId, runId);
  await mkdir(artifactsDir, { recursive: true });

  const session = await openSession({ providerId, dataDir: dataDir(), artifactsDir });
  try {
    return await fn({ page: session.page, log: createLogger(), solver: loadSolver(), artifactsDir });
  } finally {
    await session.close();
  }
}

const report = (r: RunResult): void => {
  console.log(JSON.stringify(r, null, 2));
  if (r.kind === "executed" && r.record.state !== "paid") process.exitCode = 1;
};

program
  .command("providers")
  .description("list providers")
  .action(() => {
    for (const p of loadProviders().values()) console.log(`${p.id}\t${p.version}\t${p.displayName}`);
  });

program
  .command("lookup")
  .description("read a bill, never pays")
  .requiredOption("--provider <id>")
  .requiredOption("--customer <number>")
  .option("--amount <rupees>", "recharge providers: the plan price to target")
  .action(async (opts: { provider: string; customer: string; amount?: string }) => {
    const provider = getProvider(opts.provider);
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    try {
      report(await withSession(opts.provider, (ctx) =>
        runPayment(ctx, {
          provider, ledger,
          query: {
            customerNumber: opts.customer,
            ...(opts.amount ? { targetAmountMinor: Math.round(Number(opts.amount) * 100) } : {}),
          },
          card: null, mode: "dry-run", maxAmountMinor: Number.MAX_SAFE_INTEGER,
        })));
    } finally { ledger.close(); }
  });

program
  .command("pay")
  .description("pay a bill (dry-run unless --live)")
  .requiredOption("--provider <id>")
  .requiredOption("--customer <number>")
  .requiredOption("--card <name>", "key in config/cards.json")
  .option("--live", "actually submit")
  .option("--amount <rupees>", "recharge providers: the plan price to target")
  .option("--max-amount <rupees>", "per-payment ceiling", "5000")
  .option("--attempts <n>", "retries for a non-submitted attempt", "1")
  .action(async (opts: { provider: string; customer: string; card: string; live?: boolean; amount?: string; maxAmount: string; attempts: string }) => {
    const provider = getProvider(opts.provider);
    const card = await getCard(opts.card);
    assertCardUsable(card);
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    const mode = opts.live ? "live" : "dry-run";
    console.error(JSON.stringify({ provider: provider.id, customer: opts.customer, card: opts.card, mode }));
    try {
      report(await withSession(opts.provider, (ctx) =>
        runPayment(ctx, {
          provider, ledger,
          query: {
            customerNumber: opts.customer,
            ...(opts.amount ? { targetAmountMinor: Math.round(Number(opts.amount) * 100) } : {}),
          },
          card, mode,
          maxAmountMinor: Math.round(Number(opts.maxAmount) * 100),
          maxAttempts: Number(opts.attempts),
        })));
    } finally { ledger.close(); }
  });

program
  .command("ledger")
  .description("recent attempts, or forget one so it can be retested")
  .option("--limit <n>", "rows", "20")
  .option("--forget <id>", "delete a failed/aborted row so the same plan can run again")
  .action((opts: { limit: string; forget?: string }) => {
    const ledger = new Ledger(join(dataDir(), "ledger.sqlite"));
    try {
      if (opts.forget) {
        const r = ledger.forget(opts.forget);
        console.log(r.ok ? `forgotten ${opts.forget}` : `not forgotten: ${r.reason}`);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      for (const r of ledger.recent(Number(opts.limit))) {
        console.log(
          [r.id, r.createdAt, r.providerId, r.customerNumber, r.state, r.attempts, r.amountMinor, r.receiptId ?? "-"].join("\t"),
        );
      }
    } finally { ledger.close(); }
  });

await program.parseAsync(process.argv);
