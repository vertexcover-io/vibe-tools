import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";

const TOKEN = "e2e-token";

// Grab a free port by opening then closing a throwaway listener.
const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
};

describe("e2e: real http + ws server boots via startServer", () => {
  it("test_e2e_startServer_boots_http_ws: REST health + WS auth wired end to end", async () => {
    const port = await freePort();
    const cfg = loadConfig({
      SERVER_BEARER_TOKENS: TOKEN,
      PORT: String(port),
      MAX_HOT: "5",
    });

    await startServer(cfg);

    const base = `http://127.0.0.1:${port}`;

    // REST health (no auth required) responds — real createRestServer is wired.
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string };
    expect(body.status).toBe("ok");

    // REST without a bearer token is rejected — auth middleware wired.
    const noAuth = await fetch(`${base}/sessions`);
    expect(noAuth.status).toBe(401);

    // WS upgrade with a bad token is rejected — attachWsServer is wired.
    const rejected = await new Promise<"opened" | "rejected">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/ws?token=wrong`);
      ws.on("open", () => {
        ws.close();
        resolve("opened");
      });
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(rejected).toBe("rejected");
  });
});
