import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createDemoProvider } from "../src/providers/demo/provider.ts";
import { noHuman } from "../src/core/human.ts";
import { DuplicatePaymentError, Ledger } from "../src/core/ledger.ts";
import { createLogger } from "../src/core/log.ts";
import { AmountGuardError, runPayment } from "../src/core/runner.ts";
import type { RunContext } from "../src/core/types.ts";
import { startFixtureBiller, tempArtifactsDir, testCard } from "./support.ts";

const log = createLogger("silent");

async function fixture() {
  const biller = await startFixtureBiller();
  const dir = await mkdtemp(join(tmpdir(), "billing-ledger-"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  const provider = createDemoProvider({ baseUrl: biller.baseUrl });
  return { biller, ledger, provider, dir };
}

test.describe("payment engine", () => {
  test("pays once and records a receipt", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = {
        page,
        log,
        human: noHuman,
        artifactsDir: await tempArtifactsDir(),
      };
      const result = await runPayment(ctx, {
        provider: f.provider,
        ledger: f.ledger,
        query: { customerNumber: "100200" },
        card: testCard(),
        mode: "live",
        maxAmountMinor: 1_000_000,
      });

      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") return;
      expect(result.record.state).toBe("paid");
      expect(result.record.receiptId).toMatch(/^RCPT-/);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("refuses a second payment for the same bill and card", async ({ page }) => {
    const f = await fixture();
    try {
      const base = {
        provider: f.provider,
        ledger: f.ledger,
        query: { customerNumber: "100200" },
        card: testCard(),
        mode: "live" as const,
        maxAmountMinor: 1_000_000,
      };
      const ctx: RunContext = { page, log, human: noHuman, artifactsDir: await tempArtifactsDir() };

      await runPayment(ctx, base);
      await expect(runPayment(ctx, base)).rejects.toBeInstanceOf(DuplicatePaymentError);
      expect(f.ledger.recent(10)).toHaveLength(1);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("dry-run reads the bill without claiming anything", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, human: noHuman, artifactsDir: await tempArtifactsDir() };
      const result = await runPayment(ctx, {
        provider: f.provider,
        ledger: f.ledger,
        query: { customerNumber: "100200" },
        card: null,
        mode: "dry-run",
        maxAmountMinor: Number.MAX_SAFE_INTEGER,
      });

      expect(result.kind).toBe("planned");
      expect(f.ledger.recent(10)).toHaveLength(0);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("blocks a bill above the configured ceiling", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, human: noHuman, artifactsDir: await tempArtifactsDir() };
      await expect(
        runPayment(ctx, {
          provider: f.provider,
          ledger: f.ledger,
          query: { customerNumber: "100200" },
          card: testCard(),
          mode: "live",
          maxAmountMinor: 100,
        }),
      ).rejects.toBeInstanceOf(AmountGuardError);
      expect(f.ledger.recent(10)).toHaveLength(0);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });
});
