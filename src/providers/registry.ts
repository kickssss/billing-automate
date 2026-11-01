import { httpSolver, noSolver } from "../core/challenge.ts";
import type { BillingProvider, ChallengeSolver } from "../core/types.ts";
import { createJioProvider } from "./jio/provider.ts";

/** Add a provider: one import, one line. */
export function loadProviders(_env: NodeJS.ProcessEnv = process.env): Map<string, BillingProvider> {
  const map = new Map<string, BillingProvider>();
  const jio = createJioProvider();
  map.set(jio.id, jio);
  return map;
}

export function getProvider(id: string, env: NodeJS.ProcessEnv = process.env): BillingProvider {
  const all = loadProviders(env);
  const p = all.get(id);
  if (!p) throw new Error(`unknown provider "${id}"; known: ${[...all.keys()].join(", ")}`);
  return p;
}

/** SOLVER_URL + SOLVER_KEY in the environment switches captcha solving on. */
export function loadSolver(env: NodeJS.ProcessEnv = process.env): ChallengeSolver {
  if (!env.SOLVER_URL || !env.SOLVER_KEY) return noSolver;
  return httpSolver({ endpoint: env.SOLVER_URL, apiKey: env.SOLVER_KEY });
}
