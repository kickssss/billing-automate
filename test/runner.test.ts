import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DuplicatePaymentError, Ledger } from "../src/core/ledger.ts";
import { GuardError, runPayment } from "../src/core/runner.ts";
import { noSolver } from "../src/core/challenge.ts";
import type { RunContext } from "../src/core/types.ts";
import {
  declinedOutcome, log, paidOutcome, retryOutcome, stubProvider, tempArtifactsDir, testBill, testCard,
} from "./support.ts";

async function newLedger(): Promise<Ledger> {
  return new Ledger(join(await mkdtemp(join(tmpdir(), "billing-ledger-")), "ledger.sqlite"));
}

test.describe("payment engine", () => {
  test("pays once and records a receipt", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: stubProvider([paidOutcome()]), ledger: l,
        query: { customerNumber: "100200" }, card: testCard(),
        mode: "live", maxAmountMinor: 1_000_000,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("paid");
      expect(r.record.receiptId).toBe("RCPT-TEST-1");
    } finally { l.close(); }
  });

  test("retries only outcomes that never reached the biller", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: stubProvider([retryOutcome(), paidOutcome("RCPT-TEST-2")]), ledger: l,
        query: { customerNumber: "100200" }, card: testCard(),
        mode: "live", maxAmountMinor: 1_000_000, maxAttempts: 3,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("paid");
      expect(r.record.attempts).toBe(1);
    } finally { l.close(); }
  });

  test("fails after the attempt budget is spent", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: stubProvider([retryOutcome("captcha unsolved")]), ledger: l,
        query: { customerNumber: "100200" }, card: testCard(),
        mode: "live", maxAmountMinor: 1_000_000, maxAttempts: 3,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("failed");
      expect(r.record.attempts).toBe(3);
      expect(r.record.detail).toContain("captcha unsolved");
    } finally { l.close(); }
  });

  test("a decline is terminal, not retried", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: stubProvider([declinedOutcome, paidOutcome()]), ledger: l,
        query: { customerNumber: "100200" }, card: testCard(),
        mode: "live", maxAmountMinor: 1_000_000, maxAttempts: 3,
      });
      expect(r.kind).toBe("executed");
      if (r.kind !== "executed") return;
      expect(r.record.state).toBe("declined");
      expect(r.record.attempts).toBe(0);
    } finally { l.close(); }
  });

  test("refuses a second payment for the same bill", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const opts = {
        provider: stubProvider([paidOutcome()], testBill()), ledger: l,
        query: { customerNumber: "100200" }, card: testCard(),
        mode: "live" as const, maxAmountMinor: 1_000_000,
      };
      await runPayment(ctx, opts);
      await expect(runPayment(ctx, opts)).rejects.toBeInstanceOf(DuplicatePaymentError);
      expect(l.recent(10)).toHaveLength(1);
    } finally { l.close(); }
  });

  test("dry-run reads without claiming", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const r = await runPayment(ctx, {
        provider: stubProvider([paidOutcome()]), ledger: l,
        query: { customerNumber: "100200" }, card: null,
        mode: "dry-run", maxAmountMinor: Number.MAX_SAFE_INTEGER,
      });
      expect(r.kind).toBe("planned");
      expect(l.recent(10)).toHaveLength(0);
    } finally { l.close(); }
  });

  test("blocks a bill above the ceiling", async ({ page }) => {
    const l = await newLedger();
    try {
      const ctx: RunContext = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      await expect(
        runPayment(ctx, {
          provider: stubProvider([paidOutcome()]), ledger: l,
          query: { customerNumber: "100200" }, card: testCard(),
          mode: "live", maxAmountMinor: 100,
        }),
      ).rejects.toBeInstanceOf(GuardError);
      expect(l.recent(10)).toHaveLength(0);
    } finally { l.close(); }
  });
});
