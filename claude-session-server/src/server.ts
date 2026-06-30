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
import {
  buildPiRestAdapter,
  sessionFileFor,
  type SessionLister,
} from "./pi-rest-adapter.ts";

const REAP_TICK_MS = 30000;

// CORE-tier runs don't have the tool packages installed; only verify the
// config dir when a real settings.json is present and declares packages.
const shouldVerifyConfigDir = (): boolean =>
  existsSync(resolve(PKG_DIR, "settings.json"));

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
  if (shouldVerifyConfigDir()) {
    try {
      verifyConfigDir(cfg);
    } catch {
      // Tool-layer extensions (Linear/Gmail/browser/Notion) are not installed in
      // this config dir. The CORE server (sessions + subscription auth) runs fine
      // without them; run `init` to provision the tool layer.
      console.warn(
        "[startServer] tool-layer extensions not provisioned — core server only. Run `init` to add Linear/Gmail/browser/Notion.",
      );
    }
  }

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
