import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export interface SessionOptions {
  providerId: string;
  dataDir?: string;
  artifactsDir?: string;
}

export interface Session {
  page: Page;
  close(): Promise<void>;
}

/**
 * One persistent profile per biller, always in a visible window.
 *
 * Not about stealth: the profile holds the login. A fresh context every run means
 * logging in every run, which means an OTP every run.
 *
 * Headed is not configurable on purpose. A payment you cannot watch is a payment
 * you find out about from your bank statement.
 */
export async function openSession(opts: SessionOptions): Promise<Session> {
  const root = opts.dataDir ?? process.env.DATA_DIR ?? ".data";
  const profileDir = join(root, "profiles", opts.providerId);
  const artifactsDir = opts.artifactsDir ?? join(root, "artifacts", opts.providerId);
  await mkdir(profileDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    page,
    async close() {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        await context.tracing.stop({ path: join(artifactsDir, `${stamp}-trace.zip`) });
      } finally {
        await context.close();
      }
    },
  };
}
