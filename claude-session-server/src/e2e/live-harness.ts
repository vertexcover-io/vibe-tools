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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { SessionRegistry } from "../registry.ts";
import { createRestServer, type RestAdapter, type SessionMeta } from "../rest-server.ts";
import { attachWsServer, type PiSessionLike } from "../ws-server.ts";
import { toServerFrame } from "../pi-adapter.ts";
import {
  createSession as piCreateSession,
  openSession as piOpenSession,
} from "../pi-adapter.ts";

export interface LiveServer {
  readonly server: Server;
  readonly port: number;
  readonly registry: SessionRegistry;
  close(): Promise<void>;
}

const freePort = (server: Server): number => (server.address() as AddressInfo).port;

// Resolve the on-disk session file for a given id within the config's cwd.
export const sessionFileFor = async (
  cfg: Config,
  sessionId: string,
): Promise<string> => {
  const infos = await SessionManager.list(cfg.workingDir);
  const info = infos.find((i) => i.id === sessionId);
  if (info === undefined) {
    throw new Error(`session ${sessionId} not found under ${cfg.workingDir}`);
  }
  return info.path;
};

// Drive one prompt to completion on a fresh ephemeral session, collecting the
// streamed assistant text and final usage, then dispose (REQ-009 one-shot).
const completeOnce = async (cfg: Config, prompt: string) => {
  const session = await piCreateSession(cfg);
  let text = "";
  let usage: unknown;
  let errored: { type: string; message: string } | undefined;
  const unsubscribe = session.subscribe((event) => {
    const frame = toServerFrame(event);
    if (frame.type === "text_delta") text += frame.delta;
    if (frame.type === "turn_end") usage = frame.usage;
  });
  try {
    await session.prompt(prompt);
  } catch (error) {
    errored = { type: "stream_error", message: String(error) };
  } finally {
    unsubscribe();
  }
  const sessionId = session.sessionId;
  session.dispose();
  return { sessionId, text, usage, errored };
};

const buildLiveRestAdapter = (cfg: Config): RestAdapter => ({
  complete: async (prompt: string) => {
    const { sessionId, text, usage, errored } = await completeOnce(cfg, prompt);
    if (errored !== undefined) {
      return { session_id: sessionId, text, error: errored };
    }
    return { session_id: sessionId, text, usage };
  },
  listSessions: async (limit: number, cursor?: string) => {
    const infos = await SessionManager.list(cfg.workingDir);
    const sorted = [...infos].sort(
      (a, b) => b.modified.getTime() - a.modified.getTime(),
    );
    const startIdx = cursor
      ? sorted.findIndex((i) => i.id === cursor) + 1
      : 0;
    const page = sorted.slice(startIdx, startIdx + limit);
    const sessions: SessionMeta[] = page.map((i) => ({
      id: i.id,
      title: i.name ?? i.firstMessage,
      updated: i.modified.getTime(),
      messageCount: i.messageCount,
    }));
    const nextCursor =
      startIdx + limit < sorted.length ? (page.at(-1)?.id ?? null) : null;
    return { sessions, nextCursor };
  },
  loadMessages: async (id: string) => {
    let file: string;
    try {
      file = await sessionFileFor(cfg, id);
    } catch {
      return null;
    }
    const manager = SessionManager.open(file);
    return manager
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: unknown }).message);
  },
  fork: async () => "invalid_fork_point",
  remove: async () => {},
});

export const startLiveServer = async (cfg: Config): Promise<LiveServer> => {
  const registry = new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });
  const server = createRestServer({ cfg, adapter: buildLiveRestAdapter(cfg) });

  attachWsServer(server, {
    cfg,
    registry,
    createSession: () => piCreateSession(cfg) as Promise<PiSessionLike>,
    openSession: async (sessionId: string) => {
      const file = await sessionFileFor(cfg, sessionId);
      return piOpenSession(cfg, file) as Promise<PiSessionLike>;
    },
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
