import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachWsServer, type WsDeps, type PiSessionLike } from "./ws-server.ts";
import { SessionRegistry } from "./registry.ts";
import { loadConfig } from "./config.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const TOKEN = "good-token";
const cfg = loadConfig({ SERVER_BEARER_TOKENS: TOKEN, MAX_HOT: "5" });

// ----- Mock pi session with a controllable streaming turn -----
interface ScriptedSession extends Omit<PiSessionLike, "isStreaming"> {
  isStreaming: boolean;
  emit(event: AgentSessionEvent): void;
  resolveTurn(): void;
  running: boolean;
  promptText: string | null;
}

const makeScriptedSession = (id: string): ScriptedSession => {
  const listeners = new Set<(e: AgentSessionEvent) => void>();
  let resolveCurrent: (() => void) | null = null;

  return {
    sessionId: id,
    isStreaming: false,
    running: false,
    promptText: null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setThinkingLevel() {},
    async prompt(text) {
      this.promptText = text;
      this.running = true;
      this.isStreaming = true;
      await new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
      this.running = false;
      this.isStreaming = false;
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    dispose() {},
    emit(event) {
      for (const l of listeners) l(event);
    },
    resolveTurn() {
      resolveCurrent?.();
      resolveCurrent = null;
    },
  };
};

const textDelta = (delta: string): AgentSessionEvent =>
  ({
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  }) as unknown as AgentSessionEvent;

const turnEnd = (): AgentSessionEvent =>
  ({ type: "turn_end", message: { usage: {} }, toolResults: [] }) as unknown as AgentSessionEvent;

// ----- Harness -----
let server: Server;
let registry: SessionRegistry;
let base: string;
let created: ScriptedSession[];

const makeDeps = (overrides?: Partial<WsDeps>): WsDeps => ({
  cfg,
  registry,
  createSession: async () => {
    const s = makeScriptedSession(`sess-${created.length + 1}`);
    created.push(s);
    return s;
  },
  openSession: async (id: string) => {
    const existing = created.find((s) => s.sessionId === id);
    if (existing) return existing;
    throw new Error(`no session ${id}`);
  },
  ...overrides,
});

const setup = async (registryOverride?: SessionRegistry): Promise<void> => {
  created = [];
  registry = registryOverride ?? new SessionRegistry({ maxHot: cfg.maxHot, idleMs: cfg.idleMs });
  server = createServer();
  attachWsServer(server, makeDeps());
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  base = `ws://127.0.0.1:${port}/sessions/ws`;
};

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Frame {
  type: string;
  [k: string]: unknown;
}

const connect = (query = ""): WebSocket => new WebSocket(`${base}?token=${TOKEN}${query}`);

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
    setTimeout(() => reject(new Error("timeout waiting for frame")), 3000);
  });

const collectFrames = (ws: WebSocket): Frame[] => {
  const frames: Frame[] = [];
  ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString()) as Frame));
  return frames;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const closed = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => ws.on("close", () => resolve()));

describe("session lifecycle: detach / re-attach / reaper", () => {
  it("test_REQ_014_ws_close_detaches_not_dispose: close mid-turn keeps turn running, no dispose", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.close();
    await closed(ws);
    await waitFor(() => registry.get("sess-1")?.ws === null);

    // Detached, not disposed: entry still present, turn still running.
    expect(registry.get("sess-1")).toBeDefined();
    expect(session.running).toBe(true);
    expect(session.isStreaming).toBe(true);

    // Turn can still reach completion.
    session.emit(turnEnd());
    session.resolveTurn();
    await waitFor(() => session.running === false);
    expect(registry.get("sess-1")).toBeDefined();
  });

  it("test_REQ_015_detached_turn_buffers_output: frames stream into the buffer while detached", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.close();
    await closed(ws);
    await waitFor(() => registry.get("sess-1")?.ws === null);

    session.emit(textDelta("buffered-1"));
    session.emit(textDelta("buffered-2"));

    await waitFor(() => (registry.get("sess-1")?.buffer.size ?? 0) >= 2);
    expect(registry.get("sess-1")!.buffer.size).toBe(2);
  });

  it("test_REQ_016_reattach_replays_buffer: reconnect replays buffered frames then resumes live", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.close();
    await closed(ws);
    await waitFor(() => registry.get("sess-1")?.ws === null);

    session.emit(textDelta("while-gone"));
    await waitFor(() => (registry.get("sess-1")?.buffer.size ?? 0) >= 1);

    const ws2 = connect("&session_id=sess-1");
    const frames = collectFrames(ws2);
    await nextFrame(ws2, (f) => f.type === "session_ready");

    // Replayed buffered delta.
    await waitFor(() => frames.some((f) => f.type === "text_delta" && f.delta === "while-gone"));

    // Resumes live streaming on the new socket.
    session.emit(textDelta("live-again"));
    await waitFor(() => frames.some((f) => f.type === "text_delta" && f.delta === "live-again"));

    session.emit(turnEnd());
    session.resolveTurn();
    ws2.close();
  });

  it("test_REQ_018_idle_reaper_disposes_after_window: detached-idle session reaped", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 20 });
    await setup(reg);

    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    // Complete a turn so lastTurnAt is set, then detach.
    ws.send(JSON.stringify({ type: "prompt", text: "quick" }));
    await waitFor(() => session.promptText === "quick");
    session.emit(turnEnd());
    session.resolveTurn();
    await waitFor(() => registry.get("sess-1")?.busy === false);

    ws.close();
    await closed(ws);
    await waitFor(() => registry.get("sess-1")?.ws === null);

    await new Promise((r) => setTimeout(r, 40));
    const disposed = registry.reapIdle(Date.now());
    expect(disposed).toContain("sess-1");
    expect(registry.get("sess-1")).toBeUndefined();
  });

  it("test_EDGE_005_attached_second_ws_rejected: second ws on an attached session → session_in_use", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    expect(registry.get("sess-1")?.ws).not.toBeNull();

    const ws2 = connect("&session_id=sess-1");
    const err = await nextFrame(ws2, (f) => f.type === "error");
    expect(err.code).toBe("session_in_use");
    await closed(ws2);

    // Original socket unaffected.
    expect(registry.get("sess-1")?.ws).not.toBeNull();
    ws.close();
  });

  it("test_EDGE_008_abrupt_drop_detaches: terminate (no close frame) still detaches", async () => {
    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.terminate();
    await waitFor(() => registry.get("sess-1")?.ws === null);

    expect(registry.get("sess-1")).toBeDefined();
    expect(session.running).toBe(true);
    session.emit(turnEnd());
    session.resolveTurn();
  });

  it("test_EDGE_014_buffer_overflow_truncates: overflow → truncated marker on replay", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const reg = new SessionRegistry({ maxHot: 5, idleMs: cfg.idleMs, bufferCap: 2 });
    await setup(reg);

    const ws = connect();
    await nextFrame(ws, (f) => f.type === "session_ready");
    const session = created[0]!;

    ws.send(JSON.stringify({ type: "prompt", text: "long" }));
    await waitFor(() => session.promptText === "long");

    ws.close();
    await closed(ws);
    await waitFor(() => registry.get("sess-1")?.ws === null);

    // 4 frames into a cap-2 buffer → truncation.
    session.emit(textDelta("d1"));
    session.emit(textDelta("d2"));
    session.emit(textDelta("d3"));
    session.emit(textDelta("d4"));
    await waitFor(() => registry.get("sess-1")!.buffer.size === 2);

    const ws2 = connect("&session_id=sess-1");
    const frames = collectFrames(ws2);
    await nextFrame(ws2, (f) => f.type === "session_ready");

    await waitFor(() => frames.some((f) => f.type === "truncated"));
    expect(frames.some((f) => f.type === "truncated")).toBe(true);
    ws2.close();
  });
});
