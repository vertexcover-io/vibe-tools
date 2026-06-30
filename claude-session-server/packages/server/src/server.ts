// AI-generated. See PROMPT.md for the prompts and model used.
import { mkdirSync } from "node:fs";
import type { Config } from "./config.ts";
import { SessionRegistry } from "./registry.ts";
import { createRestServer, type RestAdapter } from "./rest-server.ts";
import { attachWsServer, type PiSessionLike } from "./ws-server.ts";
import {
  createSession as piCreateSession,
  openSession as piOpenSession,
} from "./pi-adapter.ts";
import {
  buildPiRestAdapter,
  sessionFileFor,
  type SessionLister,
} from "./pi-rest-adapter.ts";

const REAP_TICK_MS = 30000;

export interface ServerDeps {
  readonly restAdapter: RestAdapter;
  resolveSessionFile(sessionId: string): Promise<string>;
  createSession(): Promise<PiSessionLike>;
  openSession(sessionId: string): Promise<PiSessionLike>;
}

// Wire the live pi-backed adapter (the same one the e2e harness exercises) and
// resolve resume targets via SessionManager.list — pi's real on-disk layout is
// ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl, so a session file MUST be
// looked up, never constructed from the working dir.
export const buildServerDeps = (cfg: Config, lister?: SessionLister): ServerDeps => {
  // pi uses workingDir as the session cwd and as the SessionManager dir. If it
  // doesn't exist, every bash tool call and session write fails with
  // "Working directory does not exist". Create it where the deps are built so
  // every entry point (serve + the e2e harness) is covered.
  mkdirSync(cfg.workingDir, { recursive: true });

  const resolveSessionFile = (sessionId: string): Promise<string> =>
    sessionFileFor(cfg, sessionId, lister);
  return {
    restAdapter: buildPiRestAdapter(cfg, lister),
    resolveSessionFile,
    createSession: () => piCreateSession(cfg) as Promise<PiSessionLike>,
    openSession: async (sessionId: string) => {
      const file = await resolveSessionFile(sessionId);
      return piOpenSession(cfg, file) as Promise<PiSessionLike>;
    },
  };
};

export const startServer = async (cfg: Config): Promise<void> => {
  const registry = new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });
  const deps = buildServerDeps(cfg);

  const httpServer = createRestServer({ cfg, adapter: deps.restAdapter });

  attachWsServer(httpServer, {
    cfg,
    registry,
    createSession: deps.createSession,
    openSession: deps.openSession,
  });

  const reaper = setInterval(() => registry.reapIdle(Date.now()), REAP_TICK_MS);
  reaper.unref?.();

  httpServer.on("close", () => {
    clearInterval(reaper);
    registry.disposeAll();
  });

  await new Promise<void>((resolveListen) => {
    httpServer.listen(cfg.port, () => resolveListen());
  });

  console.log(`[startServer] listening on :${cfg.port}`);
};
