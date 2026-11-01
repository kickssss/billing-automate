import pino, { type Logger } from "pino";

/**
 * Card material is the one thing that must never reach a log sink.
 * Redaction is defence in depth: the code never logs a PAN either.
 */
const REDACT = {
  paths: [
    "card.number",
    "card.cvv",
    "pan",
    "cvv",
    "req.headers.authorization",
    "req.headers.cookie",
    "*.card.number",
    "*.card.cvv",
  ],
  censor: "[redacted]",
};

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino(
    {
      level,
      base: undefined,
      redact: REDACT,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // stdout carries command output; logs and prompts go to stderr.
    pino.destination(2),
  );
}
