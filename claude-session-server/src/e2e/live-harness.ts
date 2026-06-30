// AI-generated. See PROMPT.md for the prompts and model used.
//
// Live e2e harness: boots a real REST + WS server wired to live pi backed by
// the host Claude subscription. Unlike src/server.ts (which ships a stubbed
// RestAdapter and a fixed session-file path), this harness wires a real
// pi-backed RestAdapter and resolves session files via SessionManager.list so
// resume (?session_id=) works against the real on-disk transcript layout
// (~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.ts";
import { SessionRegistry } from "../registry.ts";
import { createRestServer } from "../rest-server.ts";
import { attachWsServer } from "../ws-server.ts";
import { buildServerDeps } from "../server.ts";
import { sessionFileFor } from "../pi-rest-adapter.ts";

export { sessionFileFor };

export interface LiveServer {
  readonly server: Server;
  readonly port: number;
  readonly registry: SessionRegistry;
  close(): Promise<void>;
}

const freePort = (server: Server): number => (server.address() as AddressInfo).port;

export const startLiveServer = async (cfg: Config): Promise<LiveServer> => {
  const registry = new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });
  const deps = buildServerDeps(cfg);
  const server = createRestServer({ cfg, adapter: deps.restAdapter });

  attachWsServer(server, {
    cfg,
    registry,
    createSession: deps.createSession,
    openSession: deps.openSession,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      registry.disposeAll();
      server.close(() => resolve());
    });

  return { server, port: freePort(server), registry, close };
};
