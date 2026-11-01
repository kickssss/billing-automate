import type { ChallengeRequest, ChallengeSolution, ChallengeSolver } from "./types.ts";

/** Always fails. Used for billers that never show a captcha. */
export const noSolver: ChallengeSolver = {
  name: "none",
  async solve() {
    return null;
  },
};

/** For tests: returns a fixed token without touching the network. */
export function fixedSolver(token: string): ChallengeSolver {
  return { name: "fixed", solve: async () => ({ token }) };
}

export interface HttpSolverOptions {
  /** e.g. https://api.capsolver.com — any service with in.php/res.php or a REST API. */
  endpoint: string;
  apiKey: string;
  /** ms between polls. */
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Generic HTTP solver adapter.
 *
 * Every commercial solver (CapSolver, 2Captcha, Anti-Captcha, DeathByCaptcha)
 * exposes the same shape: submit task -> get id -> poll for token -> we inject the
 * token into the page. Only the JSON keys differ, so the mapping lives here and
 * nowhere else.
 *
 * This is a stub: fill in the request shape for the service you pick.
 */
export function httpSolver(opts: HttpSolverOptions): ChallengeSolver {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    name: `http:${new URL(opts.endpoint).host}`,
    async solve(req: ChallengeRequest): Promise<ChallengeSolution | null> {
      if (req.kind !== "captcha") return null; // OTP and 3DS are not ours to solve

      const submit = await fetch(`${opts.endpoint}/createTask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientKey: opts.apiKey,
          task: {
            type: "ReCaptchaV3TaskProxyless",
            websiteURL: req.url,
            websiteKey: req.siteKey,
          },
        }),
      });
      const { taskId } = (await submit.json()) as { taskId?: string };
      if (!taskId) return null;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const poll = await fetch(`${opts.endpoint}/getTaskResult`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientKey: opts.apiKey, taskId }),
        });
        const body = (await poll.json()) as { status?: string; solution?: { gRecaptchaResponse?: string } };
        if (body.status === "ready" && body.solution?.gRecaptchaResponse) {
          return { token: body.solution.gRecaptchaResponse };
        }
      }
      return null;
    },
  };
}
