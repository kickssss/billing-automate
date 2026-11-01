import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createDemoProvider } from "../src/providers/demo/provider.ts";
import { fixedSolver, noSolver } from "../src/core/challenge.ts";
import { DuplicatePaymentError, Ledger } from "../src/core/ledger.ts";
import { GuardError, runPayment } from "../src/core/runner.ts";
import { DEMO_CAPTCHA_TOKEN } from "../src/providers/demo/site/server.ts";
import type { RunContext } from "../src/core/types.ts";
import { log, startFixtureBiller, tempArtifactsDir, testCard } from "./support.ts";

async function fixture() {
  const biller = await startFixtureBiller();
  const dir = await mkdtemp(join(tmpdir(), "billing-ledger-"));
  return {
    biller,
    ledger: new Ledger(join(dir, "ledger.sqlite")),
    provider: createDemoProvider({ baseUrl: biller.baseUrl }),
  };
}

test.describe("payment flow", () => {
  test("pays once and records a receipt", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "100200" },
        card: testCard(), mode: "live", maxAmountMinor: 1_000_000,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("paid");
      expect(r.record.receiptId).toMatch(/^RCPT-/);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("retries an unsolved captcha, then fails the attempt", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "810003" },
        card: testCard(), mode: "live", maxAmountMinor: 1_000_000, maxAttempts: 3,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("failed");
      expect(r.record.attempts).toBe(3);
      expect(r.record.detail).toContain("captcha unsolved");
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("pays through the captcha when a solver is wired", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = {
        page, log, solver: fixedSolver(DEMO_CAPTCHA_TOKEN), artifactsDir: await tempArtifactsDir(),
      };
      const r = await runPayment(ctx, {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "810004" },
        card: testCard(), mode: "live", maxAmountMinor: 1_000_000,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("paid");
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("refuses a second payment for the same bill", async ({ page }) => {
    const f = await fixture();
    try {
      const base = {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "100200" },
        card: testCard(), mode: "live" as const, maxAmountMinor: 1_000_000,
      };
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      await runPayment(ctx, base);
      await expect(runPayment(ctx, base)).rejects.toBeInstanceOf(DuplicatePaymentError);
      expect(f.ledger.recent(10)).toHaveLength(1);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("dry-run reads without claiming", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "100200" },
        card: null, mode: "dry-run", maxAmountMinor: Number.MAX_SAFE_INTEGER,
      });
      expect(r.kind).toBe("planned");
      expect(f.ledger.recent(10)).toHaveLength(0);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });

  test("blocks a bill above the ceiling", async ({ page }) => {
    const f = await fixture();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      await expect(runPayment(ctx, {
        provider: f.provider, ledger: f.ledger, query: { customerNumber: "100200" },
        card: testCard(), mode: "live", maxAmountMinor: 100,
      })).rejects.toBeInstanceOf(GuardError);
      expect(f.ledger.recent(10)).toHaveLength(0);
    } finally {
      await f.biller.close();
      f.ledger.close();
    }
  });
});
