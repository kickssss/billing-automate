import { defineConfig, devices } from "@playwright/test";

/**
 * Provider adapters are tested against a bundled fixture biller, so the suite is
 * deterministic and never moves real money. Point DEMO_BILL_URL at the fixture
 * server; live billers are exercised by the CLI, not by this suite.
 */
export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    video: "off",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
