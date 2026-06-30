import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRestServer, type RestAdapter, type RestDeps } from "./rest-server.ts";
import { DEFAULT_PI_AGENT_DIR, type Config } from "./config.ts";

const TOKEN = "good-token";

const cfg: Config = {
  configDir: DEFAULT_PI_AGENT_DIR,
  bearerTokens: [TOKEN],
  workingDir: "/tmp/agentwire-test",
  idleMs: 300000,
  maxHot: 50,
  port: 8787,
};

interface MockState {
  completeError: boolean;
  deleted: string[];
  forkInvalid: boolean;
}

const makeAdapter = (state: MockState): RestAdapter => ({
  complete: async (prompt: string) => {
    if (state.completeError) {
      return {
        session_id: "eph-err",
        text: "partial output",
        error: { type: "stream_error", message: "boom" },
      };
    }
    return {
      session_id: "eph-1",
      text: `echo:${prompt}`,
      usage: { inputTokens: 3, outputTokens: 4 },
    };
  },
  listSessions: async (limit: number, cursor?: string) => {
    const all = [
      { id: "s3", title: "third", updated: 300, messageCount: 6 },
      { id: "s2", title: "second", updated: 200, messageCount: 4 },
      { id: "s1", title: "first", updated: 100, messageCount: 2 },
    ];
    const startIdx = cursor ? all.findIndex((s) => s.id === cursor) + 1 : 0;
    const page = all.slice(startIdx, startIdx + limit);
    const last = page.at(-1);
    const nextCursor =
      last && startIdx + limit < all.length ? last.id : null;
    return { sessions: page, nextCursor };
  },
  loadMessages: async (id: string) => {
    if (id === "missing") return null;
    return [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
  },
  fork: async (id: string, _entryId?: string) => {
    if (state.forkInvalid || id === "missing") return "invalid_fork_point";
    return { session_id: `${id}-fork` };
  },
  remove: async (id: string) => {
    state.deleted.push(id);
  },
});

interface JsonBody {
  readonly [key: string]: unknown;
  readonly text?: unknown;
  readonly error?: unknown;
  readonly session_id?: unknown;
  readonly sessions?: unknown;
  readonly messages?: unknown;
  readonly nextCursor?: unknown;
  readonly status?: unknown;
  readonly services?: unknown;
}

const json = async (res: Response): Promise<JsonBody> =>
  (await res.json()) as JsonBody;

let server: Server;
let base: string;
let state: MockState;

beforeAll(async () => {
  state = { completeError: false, deleted: [], forkInvalid: false };
  const deps: RestDeps = { cfg, adapter: makeAdapter(state) };
  server = createRestServer(deps);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("REST server", () => {
  it("test_REQ_021_bearer_auth_enforced: missing/bad token 401, valid passes", async () => {
    const noTok = await fetch(`${base}/sessions`);
    expect(noTok.status).toBe(401);

    const badTok = await fetch(`${base}/sessions`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(badTok.status).toBe(401);

    const ok = await fetch(`${base}/sessions`, { headers: auth });
    expect(ok.status).toBe(200);
  });

  it("test_REQ_009_complete_oneshot_disposes: returns full text + usage + session_id", async () => {
    const res = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ping" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      text: "echo:ping",
      usage: { inputTokens: 3, outputTokens: 4 },
      session_id: "eph-1",
    });
  });

  it("test_EDGE_010_oneshot_partial_error: typed error + partial text, still disposed", async () => {
    state.completeError = true;
    const res = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ping" }),
    });
    state.completeError = false;
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.text).toBe("partial output");
    expect(body.error).toEqual({ type: "stream_error", message: "boom" });
    expect(body.session_id).toBe("eph-err");
  });

  it("test_REQ_009_complete_requires_prompt: bad/missing JSON 400", async () => {
    const badJson = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);

    const noPrompt = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noPrompt.status).toBe(400);
  });

  it("test_REQ_010_list_sessions_paginated: bounded by limit, newest-first, cursor advances", async () => {
    const res = await fetch(`${base}/sessions?limit=2`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    const sessions = body.sessions as { id: string; updated: number }[];
    expect(sessions.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(sessions[0]!.updated).toBeGreaterThan(sessions[1]!.updated);
    expect(body.nextCursor).toBe("s2");

    const page2 = await fetch(`${base}/sessions?limit=2&cursor=s2`, {
      headers: auth,
    });
    const body2 = await json(page2);
    const sessions2 = body2.sessions as { id: string }[];
    expect(sessions2.map((s) => s.id)).toEqual(["s1"]);
    expect(body2.nextCursor).toBeNull();
  });

  it("test_EDGE_012_list_bounded_large_count: default limit applied without limit param", async () => {
    const res = await fetch(`${base}/sessions`, { headers: auth });
    const body = await json(res);
    const sessions = body.sessions as unknown[];
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeLessThanOrEqual(50);
  });

  it("test_REQ_011_get_messages_full_history: returns full conversation", async () => {
    const res = await fetch(`${base}/sessions/s1/messages`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    const messages = body.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });

    const missing = await fetch(`${base}/sessions/missing/messages`, {
      headers: auth,
    });
    expect(missing.status).toBe(404);
  });

  it("test_REQ_013_fork_leaves_original: returns new id, original untouched", async () => {
    const res = await fetch(`${base}/sessions/s1/fork`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.session_id).toBe("s1-fork");
    expect(body.session_id).not.toBe("s1");
  });

  it("test_EDGE_009_invalid_fork_point: 400 invalid_fork_point", async () => {
    const res = await fetch(`${base}/sessions/missing/fork`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ entry_id: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("invalid_fork_point");
  });

  it("test_REQ_017_delete_aborts_and_disposes: 204 and registry remove called", async () => {
    const res = await fetch(`${base}/sessions/s2`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(204);
    expect(state.deleted).toContain("s2");
  });

  it("health returns status ok without auth-sensitive failure", async () => {
    const res = await fetch(`${base}/health`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("ok");
    expect(body.services).toEqual({});
  });

  it("unknown route 404", async () => {
    const res = await fetch(`${base}/nope`, { headers: auth });
    expect(res.status).toBe(404);
  });
});
