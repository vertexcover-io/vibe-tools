// AI-generated. See PROMPT.md for the prompts and model used.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.ts";
import { PKG_DIR } from "./config.ts";
import { verifyConfigDir } from "./init.ts";
import { SessionRegistry } from "./registry.ts";
import { createRestServer, type RestAdapter } from "./rest-server.ts";
import { attachWsServer, type PiSessionLike } from "./ws-server.ts";
import {
  createSession as piCreateSession,
  openSession as piOpenSession,
} from "./pi-adapter.ts";

const REAP_TICK_MS = 30000;

// CORE-tier runs don't have the tool packages installed; only verify the
// config dir when a real settings.json is present and declares packages.
const shouldVerifyConfigDir = (): boolean =>
  existsSync(resolve(PKG_DIR, "settings.json"));

const piSessionPath = (cfg: Config, sessionId: string): string =>
  resolve(cfg.workingDir, ".pi", "sessions", `${sessionId}.jsonl`);

const buildRestAdapter = (): RestAdapter => ({
  complete: async () => {
    throw new Error("complete not implemented in this phase");
  },
  listSessions: async () => ({ sessions: [], nextCursor: null }),
  loadMessages: async () => null,
  fork: async () => "invalid_fork_point",
  remove: async () => {},
});

export const startServer = async (cfg: Config): Promise<void> => {
  if (shouldVerifyConfigDir()) {
    try {
      verifyConfigDir(cfg);
    } catch (error) {
      console.warn(`[startServer] config dir not provisioned: ${String(error)}`);
    }
  }

  const registry = new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });

  const httpServer = createRestServer({ cfg, adapter: buildRestAdapter() });

  attachWsServer(httpServer, {
    cfg,
    registry,
    createSession: () => piCreateSession(cfg) as Promise<PiSessionLike>,
    openSession: (sessionId: string) =>
      piOpenSession(cfg, piSessionPath(cfg, sessionId)) as Promise<PiSessionLike>,
  });

  const reaper = setInterval(() => registry.reapIdle(Date.now()), REAP_TICK_MS);
  reaper.unref?.();

  httpServer.on("close", () => clearInterval(reaper));

  await new Promise<void>((resolveListen) => {
    httpServer.listen(cfg.port, () => resolveListen());
  });

  console.log(`[startServer] listening on :${cfg.port}`);
};
