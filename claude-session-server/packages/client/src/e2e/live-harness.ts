// AI-generated. See PROMPT.md for the prompts and model used.
//
// Live e2e harness: boots a real REST + WS server (from @agentwire/server)
// wired to live pi backed by the host Claude subscription. The harness is a
// dev-only test concern — the client RUNTIME stays node/ws-free; only this
// harness pulls in @agentwire/server to stand up a real server on a free port.
//
// It wires a real pi-backed RestAdapter and resolves session files via
// SessionManager.list so resume (session_id=) works against the real on-disk
// transcript layout (~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl).
import { resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Config,
  PKG_DIR,
  DEFAULT_PI_AGENT_DIR,
  SessionRegistry,
  createRestServer,
  attachWsServer,
  buildServerDeps,
  sessionFileFor,
} from "@agentwire/server";

export { sessionFileFor };
export type { Config };

type Env = Readonly<Record<string, string | undefined>>;

const parseInt10 = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCsv = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

// Build a Config straight from env-like values (mirrors apps/server loadConfig
// so the e2e doesn't depend on the apps/server package).
export const buildConfig = (env: Env): Config => ({
  configDir: resolve(env.CLAUDE_CONFIG_DIR ?? DEFAULT_PI_AGENT_DIR),
  bearerTokens: parseCsv(env.SERVER_BEARER_TOKENS),
  workingDir: resolve(env.PI_WORKING_DIR ?? resolve(PKG_DIR, ".sessions")),
  idleMs: parseInt10(env.IDLE_MS, 300000),
  maxHot: parseInt10(env.MAX_HOT, 50),
  port: parseInt10(env.PORT, 8787),
});

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

  await new Promise<void>((res) => {
    server.listen(0, () => res());
  });

  const close = (): Promise<void> =>
    new Promise<void>((res) => {
      registry.disposeAll();
      server.close(() => res());
    });

  return { server, port: freePort(server), registry, close };
};
