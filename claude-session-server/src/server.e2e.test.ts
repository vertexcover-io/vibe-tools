import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, buildServerDeps } from "./server.ts";
import { loadConfig } from "./config.ts";
import type { SessionInfoLike } from "./pi-rest-adapter.ts";

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

  it("test_gap1_serve_wires_real_adapter: REST + WS resume resolve sessions via SessionManager.list, not a constructed path", async () => {
    // Use a not-yet-created working dir: buildServerDeps must create it
    // (regression guard for the missing-working-dir bash failure).
    const tmpRoot = mkdtempSync(join(tmpdir(), "css-server-e2e-"));
    const workDir = join(tmpRoot, "sessions-not-yet-created");
    expect(existsSync(workDir)).toBe(false);
    const cfg = loadConfig({ SERVER_BEARER_TOKENS: TOKEN, PI_WORKING_DIR: workDir });
    const info: SessionInfoLike = {
      id: "abc",
      path: "/home/.pi/agent/sessions/enc/123_abc.jsonl",
      firstMessage: "hi",
      modified: new Date(5),
      messageCount: 3,
    };
    const lister = async (cwd: string): Promise<readonly SessionInfoLike[]> => {
      expect(cwd).toBe(workDir);
      return [info];
    };

    const deps = buildServerDeps(cfg, lister);
    // buildServerDeps created the working dir.
    expect(existsSync(workDir)).toBe(true);

    // REST adapter is the real pi-backed one: it lists the on-disk session.
    const listed = await deps.restAdapter.listSessions(50);
    expect(listed.sessions.map((s) => s.id)).toEqual(["abc"]);

    // WS openSession resolves the id to its REAL on-disk path (from list),
    // never <workingDir>/.pi/sessions/<id>.jsonl. We stop before touching pi
    // by intercepting the file path the adapter would open.
    const resolvedFile = await deps.resolveSessionFile("abc");
    expect(resolvedFile).toBe("/home/.pi/agent/sessions/enc/123_abc.jsonl");
    await expect(deps.resolveSessionFile("missing")).rejects.toThrow(/not found/);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
