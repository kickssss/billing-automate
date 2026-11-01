import { expect, test } from "@playwright/test";
import { createDemoProvider } from "../src/providers/demo/provider.ts";
import { fixedSolver, noSolver } from "../src/core/challenge.ts";
import { DEMO_CAPTCHA_TOKEN } from "../src/providers/demo/site/server.ts";
import { log, startFixtureBiller, tempArtifactsDir, testCard } from "./support.ts";

test.describe("demo provider", () => {
  test("reads a bill and pays it", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };

      const bill = await provider.lookupBill(ctx, { customerNumber: "100200" });
      expect(bill.billReference).toContain("INV-100200");
      expect(bill.amount.amountMinor).toBeGreaterThan(0);

      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("paid");
      if (outcome.status !== "paid") return;
      expect(outcome.receiptId).toMatch(/^RCPT-/);
      expect(outcome.amount.amountMinor).toBe(bill.amount.amountMinor);
    } finally {
      await biller.close();
    }
  });

  test("solves the captcha when a solver is wired", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = {
        page, log,
        solver: fixedSolver(DEMO_CAPTCHA_TOKEN),
        artifactsDir: await tempArtifactsDir(),
      };
      const bill = await provider.lookupBill(ctx, { customerNumber: "810001" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("paid");
    } finally {
      await biller.close();
    }
  });

  test("returns retry, not failure, when no solver is wired", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const bill = await provider.lookupBill(ctx, { customerNumber: "810002" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("retry");
      if (outcome.status !== "retry") return;
      expect(outcome.reason).toContain("captcha unsolved");
    } finally {
      await biller.close();
    }
  });

  test("stops on OTP and says so", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const bill = await provider.lookupBill(ctx, { customerNumber: "900001" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("needs-human");
      if (outcome.status !== "needs-human") return;
      expect(outcome.reason).toBe("otp");
    } finally {
      await biller.close();
    }
  });

  test("reports a decline instead of throwing", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, solver: noSolver, artifactsDir: await tempArtifactsDir() };
      const bill = await provider.lookupBill(ctx, { customerNumber: "100201" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard({ number: "4111111111111112" }) });
      expect(outcome.status).toBe("declined");
      if (outcome.status !== "declined") return;
      expect(outcome.code).toBe("14");
    } finally {
      await biller.close();
    }
  });
});
