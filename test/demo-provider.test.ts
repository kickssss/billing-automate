import { expect, test } from "@playwright/test";
import { createDemoProvider } from "../src/providers/demo/provider.ts";
import { noHuman } from "../src/core/human.ts";
import { createLogger } from "../src/core/log.ts";
import type { HumanGate } from "../src/core/types.ts";
import { startFixtureBiller, tempArtifactsDir, testCard } from "./support.ts";

const log = createLogger("silent");

test.describe("demo biller adapter", () => {
  test("reads a bill and pays it end to end", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const artifactsDir = await tempArtifactsDir();
      const ctx = { page, log, human: noHuman, artifactsDir };

      const bill = await provider.lookupBill(ctx, { customerNumber: "100200" });
      expect(bill.billReference).toContain("INV-100200");
      expect(bill.amount.amountMinor).toBeGreaterThan(0);

      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("paid");
      if (outcome.status !== "paid") return;

      expect(outcome.receiptId).toMatch(/^RCPT-/);
      expect(outcome.amount.amountMinor).toBe(bill.amount.amountMinor);
      expect(outcome.evidence.screenshot).toBeTruthy();
    } finally {
      await biller.close();
    }
  });

  test("stops at the OTP step when no human is attached", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, human: noHuman, artifactsDir: await tempArtifactsDir() };

      const bill = await provider.lookupBill(ctx, { customerNumber: "900001" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard() });

      expect(outcome.status).toBe("needs-human");
      if (outcome.status !== "needs-human") return;
      expect(outcome.reason).toBe("otp");
    } finally {
      await biller.close();
    }
  });

  test("finishes the OTP step when a human supplies the code", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const human: HumanGate = { ask: async () => "123456" };
      const ctx = { page, log, human, artifactsDir: await tempArtifactsDir() };

      const bill = await provider.lookupBill(ctx, { customerNumber: "900002" });
      const outcome = await provider.payBill(ctx, { bill, card: testCard() });
      expect(outcome.status).toBe("paid");
    } finally {
      await biller.close();
    }
  });

  test("reports a gateway decline instead of throwing", async ({ page }) => {
    const biller = await startFixtureBiller();
    try {
      const provider = createDemoProvider({ baseUrl: biller.baseUrl });
      const ctx = { page, log, human: noHuman, artifactsDir: await tempArtifactsDir() };

      const bill = await provider.lookupBill(ctx, { customerNumber: "100201" });
      // Bypasses the client-side Luhn guard on purpose: this is the shape of a
      // decline that only the processor can produce.
      const outcome = await provider.payBill(ctx, { bill, card: testCard({ number: "4111111111111112" }) });

      expect(outcome.status).toBe("declined");
      if (outcome.status !== "declined") return;
      expect(outcome.code).toBe("14");
    } finally {
      await biller.close();
    }
  });
});
