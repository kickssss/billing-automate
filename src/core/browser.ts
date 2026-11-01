import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export interface SessionOptions {
  providerId: string;
  dataDir?: string;
  /** Where the trace zip is written. Defaults to <dataDir>/artifacts/<providerId>. */
  artifactsDir?: string;
  headless?: boolean;
  locale?: string;
  timezoneId?: string;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /** Stop tracing (kept on failure) and close the context. */
  close(): Promise<void>;
}

/**
 * One persistent profile per provider.
 *
 * Billers fingerprint *sessions*, not just requests: a fresh incognito context
 * every run looks like a bot and invalidates your "remember this device" state.
 * A persistent profile keeps cookies, device trust and 2FA exemptions alive, so
 * most runs never see a login page.
 */
export async function openSession(opts: SessionOptions): Promise<Session> {
  const root = opts.dataDir ?? process.env.DATA_DIR ?? ".data";
  const profileDir = join(root, "profiles", opts.providerId);
  const artifactsDir = opts.artifactsDir ?? join(root, "artifacts", opts.providerId);
  await mkdir(profileDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const headless = opts.headless ?? process.env.HEADLESS !== "false";
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: opts.locale ?? "en-IN",
    timezoneId: opts.timezoneId ?? "Asia/Kolkata",
    acceptDownloads: true,
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
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
