import type { BillingProvider } from "../core/types.ts";
import { createDemoProvider } from "./demo/provider.ts";

/**
 * Explicit registry, built from env. Keep it boring: a provider is "installed"
 * when it is registered here, and every one of them gets the same engine.
 */
export function loadProviders(env: NodeJS.ProcessEnv = process.env): Map<string, BillingProvider> {
  const providers = new Map<string, BillingProvider>();

  const demo = createDemoProvider({ baseUrl: env.DEMO_BILL_URL ?? "http://127.0.0.1:4600" });
  providers.set(demo.id, demo);

  return providers;
}

export function getProvider(id: string, env: NodeJS.ProcessEnv = process.env): BillingProvider {
  const provider = loadProviders(env).get(id);
  if (!provider) {
    const known = [...loadProviders(env).keys()].join(", ");
    throw new Error(`unknown provider "${id}"; known providers: ${known}`);
  }
  return provider;
}
