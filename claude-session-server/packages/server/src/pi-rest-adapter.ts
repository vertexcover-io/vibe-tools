// AI-generated. See PROMPT.md for the prompts and model used.
//
// Real pi-backed RestAdapter + on-disk session-file resolution shared by the
// `serve` entrypoint (src/server.ts) and the live e2e harness. pi stores
// transcripts under ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl, so a
// session id is resolved to its file via SessionManager.list(cwd) — never by
// constructing a path by hand.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import type { SessionMeta } from "@agentwire/protocol";
import type { RestAdapter } from "./rest-server.ts";
import { toServerFrame, createSession as piCreateSession } from "./pi-adapter.ts";

export interface SessionInfoLike {
  readonly id: string;
  readonly path: string;
  readonly name?: string;
  readonly firstMessage: string;
  readonly modified: Date;
  readonly messageCount: number;
}

export type SessionLister = (cwd: string) => Promise<readonly SessionInfoLike[]>;

const defaultLister: SessionLister = (cwd) =>
  SessionManager.list(cwd) as Promise<readonly SessionInfoLike[]>;

// Resolve the on-disk session file for a given id within the config's cwd.
export const sessionFileFor = async (
  cfg: Config,
  sessionId: string,
  list: SessionLister = defaultLister,
): Promise<string> => {
  const infos = await list(cfg.workingDir);
  const info = infos.find((i) => i.id === sessionId);
  if (info === undefined) {
    throw new Error(`session ${sessionId} not found under ${cfg.workingDir}`);
  }
  return info.path;
};

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

export const buildPiRestAdapter = (
  cfg: Config,
  list: SessionLister = defaultLister,
): RestAdapter => ({
  complete: async (prompt: string) => {
    const { sessionId, text, usage, errored } = await completeOnce(cfg, prompt);
    if (errored !== undefined) {
      return { session_id: sessionId, text, error: errored };
    }
    return { session_id: sessionId, text, usage };
  },
  listSessions: async (limit: number, cursor?: string) => {
    const infos = await list(cfg.workingDir);
    const sorted = [...infos].sort(
      (a, b) => b.modified.getTime() - a.modified.getTime(),
    );
    const startIdx = cursor ? sorted.findIndex((i) => i.id === cursor) + 1 : 0;
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
      file = await sessionFileFor(cfg, id, list);
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
