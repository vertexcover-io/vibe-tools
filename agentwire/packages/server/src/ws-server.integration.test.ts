import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachWsServer, type WsDeps, type PiSessionLike } from "./ws-server.ts";
import { SessionRegistry } from "./registry.ts";
import { DEFAULT_PI_AGENT_DIR, type Config } from "./config.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const TOKEN = "good-token";
const cfg: Config = {
  configDir: DEFAULT_PI_AGENT_DIR,
  bearerTokens: [TOKEN],
  workingDir: "/tmp/agentwire-test",
  idleMs: 300000,
  maxHot: 5,
  port: 8787,
};

// ----- Mock pi session: scriptable, deterministic, no network -----
interface ScriptedSession extends PiSessionLike {
  emit(event: AgentSessionEvent): void;
  resolveTurn(): void;
  rejectTurn(error: unknown): void;
  calls: { steer: string[]; followUp: string[]; aborted: number; thinking: string[] };
  promptText: string | null;
}

const makeScriptedSession = (id: string): ScriptedSession => {
  const listeners = new Set<(e: AgentSessionEvent) => void>();
  let resolveCurrent: (() => void) | null = null;
  let rejectCurrent: ((error: unknown) => void) | null = null;
  const calls = { steer: [] as string[], followUp: [] as string[], aborted: 0, thinking: [] as string[] };

  return {
    sessionId: id,
    isStreaming: false,
    promptText: null,
    calls,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setThinkingLevel(level) {
      calls.thinking.push(level);
    },
    async prompt(text) {
      this.promptText = text;
      await new Promise<void>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
      });
    },
    async steer(text) {
      calls.steer.push(text);
    },
    async followUp(text) {
      calls.followUp.push(text);
    },
    async abort() {
      calls.aborted += 1;
    },
    dispose() {},
    emit(event) {
      for (const l of listeners) l(event);
    },
    resolveTurn() {
      resolveCurrent?.();
      resolveCurrent = null;
      rejectCurrent = null;
    },
    rejectTurn(error) {
      rejectCurrent?.(error);
      resolveCurrent = null;
      rejectCurrent = null;
    },
  };
};

// ----- Test harness wiring -----
let server: Server;
let registry: SessionRegistry;
let base: string;
let created: ScriptedSession[];
let openable: Map<string, ScriptedSession>;

const makeDeps = (): WsDeps => ({
  cfg,
  registry,
  createSession: async () => {
    const s = makeScriptedSession(`sess-${created.length + 1}`);
    created.push(s);
    return s;
  },
  openSession: async (id: string) => {
    const s = openable.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return s;
  },
});

beforeEach(async () => {
  created = [];
  openable = new Map();
  registry = new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });
  server = createServer();
  attachWsServer(server, makeDeps());
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  base = `ws://127.0.0.1:${port}/sessions/ws`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Frame {
  type: string;
  [k: string]: unknown;
}

const connect = (query = ""): WebSocket =>
  new WebSocket(`${base}?token=${TOKEN}${query}`);

const nextFrame = (ws: WebSocket, predicate: (f: Frame) => boolean): Promise<Frame> =>
  new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (predicate(frame)) {
        ws.off("message", onMsg);
        resolve(frame);
      }
    };
    ws.on("message", onMsg);
    setTimeout(() => reject(new Error("timeout waiting for frame")), 2000);
  });

const allFramesUntil = (ws: WebSocket, stopType: string): Promise<Frame[]> =>
  new Promise((resolve, reject) => {
    const collected: Frame[] = [];
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as Frame;
      collected.push(frame);
      if (frame.type === stopType) {
        ws.off("message", onMsg);
        resolve(collected);
      }
    };
    ws.on("message", onMsg);
    setTimeout(() => reject(new Error("timeout collecting frames")), 2000);
  });

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("WS session protocol", () => {
  it("test_REQ_001_ws_create_returns_session_ready: create on connect", async () => {
    const ws = connect();
    const ready = await nextFrame(ws, (f) => f.type === "session_ready");
    expect(ready.session_id).toBe("sess-1");
    expect(registry.get("sess-1")).toBeDefined();
    ws.close();
  });

  // An unauthorized upgrade is accepted then closed with code 4401 (so browsers
  // can read the reason), so a 4401 close counts as "rejected". A genuinely
  // accepted connection stays open and emits frames.
  const outcome = (ws: WebSocket): Promise<"opened" | "rejected"> =>
    new Promise((resolve) => {
      let opened = false;
      ws.on("open", () => {
        opened = true;
      });
      ws.on("message", () => resolve("opened"));
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
      ws.on("close", (code) => resolve(code === 4401 || !opened ? "rejected" : "opened"));
    });

  it("test_REQ_021_bearer_auth_enforced: missing/bad token rejected, valid accepted", async () => {
    expect(await outcome(new WebSocket(`${base}`))).toBe("rejected");
    expect(await outcome(new WebSocket(`${base}?token=wrong`))).toBe("rejected");

    const good = connect();
    const ready = await nextFrame(good, (f) => f.type === "session_ready");
    expect(ready.type).toBe("session_ready");
    good.close();
  });

  it("test_REQ_002_prompt_streams_text_delta + REQ_005_incremental_before_turn_end", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    const collecting = allFramesUntil(ws, "turn_end");
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await waitFor(() => session.promptText === "hello");

    session.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    } as unknown as AgentSessionEvent);
    session.emit({
      type: "turn_end",
      message: { usage: { inputTokens: 1, costUSD: 0.01 } },
      toolResults: [],
    } as unknown as AgentSessionEvent);
    session.resolveTurn();

    const frames = await collecting;
    const types = frames.map((f) => f.type);
    const textIdx = types.indexOf("text_delta");
    const turnEndIdx = types.indexOf("turn_end");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(turnEndIdx);
    expect(frames[textIdx]!.delta).toBe("Hi");
    ws.close();
  });

  it("test_REQ_003_tool_execution_frames: start/update/end stream in order", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    const collecting = allFramesUntil(ws, "turn_end");
    ws.send(JSON.stringify({ type: "prompt", text: "use a tool" }));
    await waitFor(() => session.promptText === "use a tool");

    session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } } as unknown as AgentSessionEvent);
    session.emit({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: "partial" } as unknown as AgentSessionEvent);
    session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false } as unknown as AgentSessionEvent);
    session.emit({ type: "turn_end", message: { usage: {} }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();

    const frames = await collecting;
    const types = frames.map((f) => f.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_update");
    expect(types).toContain("tool_execution_end");
    expect(types.indexOf("tool_execution_start")).toBeLessThan(types.indexOf("tool_execution_end"));
    ws.close();
  });

  it("test_REQ_004_turn_end_has_usage: usage+cost forwarded", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "x" }));
    await waitFor(() => session.promptText === "x");

    const end = nextFrame(ws, (f) => f.type === "turn_end");
    session.emit({ type: "turn_end", message: { usage: { inputTokens: 9, costUSD: 0.5 } }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();

    expect((await end).usage).toEqual({ inputTokens: 9, costUSD: 0.5 });
    ws.close();
  });

  it("test_REQ_006_thinking_delta_toggle: sets thinkingLevel and streams thinking_delta", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    const collecting = allFramesUntil(ws, "turn_end");
    ws.send(JSON.stringify({ type: "prompt", text: "think", thinking: "medium" }));
    await waitFor(() => session.promptText === "think");
    expect(session.calls.thinking).toContain("medium");

    session.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
    } as unknown as AgentSessionEvent);
    session.emit({ type: "turn_end", message: { usage: {} }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();

    const frames = await collecting;
    const thinking = frames.find((f) => f.type === "thinking_delta");
    expect(thinking?.delta).toBe("hmm");
    ws.close();
  });

  it("test_REQ_007_steer_calls_session_steer: steer bypasses scheduler", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.send(JSON.stringify({ type: "steer", text: "redirect" }));
    await waitFor(() => session.calls.steer.length > 0);
    expect(session.calls.steer).toEqual(["redirect"]);

    const end = nextFrame(ws, (f) => f.type === "turn_end");
    session.emit({ type: "turn_end", message: { usage: {} }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();
    await end;
    ws.close();
  });

  it("test_REQ_008_followup_calls_session_followup", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "run" }));
    await waitFor(() => session.promptText === "run");

    ws.send(JSON.stringify({ type: "follow_up", text: "and then" }));
    await waitFor(() => session.calls.followUp.length > 0);
    expect(session.calls.followUp).toEqual(["and then"]);

    const end = nextFrame(ws, (f) => f.type === "turn_end");
    session.emit({ type: "turn_end", message: { usage: {} }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();
    await end;
    ws.close();
  });

  it("test_REQ_019_single_writer_rejects_concurrent: second prompt → session_busy", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "first" }));
    await waitFor(() => session.promptText === "first");

    ws.send(JSON.stringify({ type: "prompt", text: "second" }));
    const err = await nextFrame(ws, (f) => f.type === "error");
    expect(err.code).toBe("session_busy");

    // first turn unaffected — completes normally
    const end = nextFrame(ws, (f) => f.type === "turn_end");
    session.emit({ type: "turn_end", message: { usage: {} }, toolResults: [] } as unknown as AgentSessionEvent);
    session.resolveTurn();
    expect((await end).type).toBe("turn_end");
    ws.close();
  });

  it("test_REQ_024_rate_limited_frame_on_429: 429/overloaded mid-turn → rate_limited, session stays hot, busy cleared", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "go" }));
    await waitFor(() => session.promptText === "go");

    const err = nextFrame(ws, (f) => f.type === "error");
    session.rejectTurn(new Error("Request failed: 429 overloaded_error"));
    expect((await err).code).toBe("rate_limited");

    // Session stays hot and is no longer busy — a follow-up prompt is accepted.
    await waitFor(() => registry.get("sess-1")?.busy === false);
    expect(registry.get("sess-1")).toBeDefined();
    ws.close();
  });

  it("test_EDGE_003_auth_error_frame: non-rate-limit turn failure → auth_error", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "go" }));
    await waitFor(() => session.promptText === "go");

    const err = nextFrame(ws, (f) => f.type === "error");
    session.rejectTurn(new Error("token refresh failed: keychain locked"));
    expect((await err).code).toBe("auth_error");
    await waitFor(() => registry.get("sess-1")?.busy === false);
    ws.close();
  });

  it("rejects malformed inbound frames without crashing the connection", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    ws.send(JSON.stringify({ type: "bogus" }));
    // connection still alive — a valid prompt still flows
    const session = created[0]!;
    ws.send(JSON.stringify({ type: "prompt", text: "ok" }));
    await waitFor(() => session.promptText === "ok");
    expect(session.promptText).toBe("ok");
    ws.close();
  });
});
