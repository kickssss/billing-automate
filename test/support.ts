import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDemoServer } from "../src/providers/demo/site/server.ts";
import { createLogger } from "../src/core/logger.ts";
import type { Card } from "../src/core/types.ts";

process.env.LOG_LEVEL = "silent";

export const log = createLogger();

export async function startFixtureBiller(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const tempArtifactsDir = (): Promise<string> => mkdtemp(join(tmpdir(), "billing-artifacts-"));

export const testCard = (over: Partial<Card> = {}): Card => ({
  number: "4111111111111111",
  expiry: "12/30",
  cvv: "123",
  nameOnCard: "Ada Lovelace",
  kind: "debit",
  ...over,
});
