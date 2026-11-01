import { createInterface } from "node:readline/promises";
import type { HumanGate } from "./types.ts";

/** No person attached: every gate answers null, which becomes needs-human. */
export const noHuman: HumanGate = { ask: async () => null };

/**
 * Interactive terminal gate for OTP/CAPTCHA. Deliberately blocking and loud:
 * a payment run waiting on a human is a feature, not a stall.
 */
export function readlineHumanGate(): HumanGate {
  return {
    async ask(req) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        process.stderr.write(`\n[human-in-the-loop] ${req.prompt}\n> `);
        const answer = (await rl.question("")).trim();
        return answer.length > 0 ? answer : null;
      } finally {
        rl.close();
      }
    },
  };
}
