// AI-generated. See PROMPT.md for the prompts and model used.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { SessionRegistry, SessionBusyError, AtCapacityError, type WSLike } from "./registry.ts";
import { createPromptScheduler } from "./scheduler.ts";
import { toServerFrame, type ServerFrame } from "./pi-adapter.ts";
import {
  parseInboundFrame,
  serializeOutbound,
  type InboundFrame,
  type ServerOutboundFrame,
  type ThinkingLevel,
} from "./frames.ts";

export interface PiSessionLike {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setThinkingLevel(level: ThinkingLevel): void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface WsDeps {
  readonly cfg: Config;
  readonly registry: SessionRegistry;
  createSession(): Promise<PiSessionLike>;
  openSession(sessionId: string): Promise<PiSessionLike>;
}

const WS_PATH = "/sessions/ws";
const CLOSE_AUTH = 4401;

const tokenFromRequest = (
  url: URL,
  req: IncomingMessage,
): string | undefined => {
  const queryToken = url.searchParams.get("token");
  if (queryToken !== null) return queryToken;
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
};

const isAuthorized = (token: string | undefined, cfg: Config): boolean =>
  token !== undefined && cfg.bearerTokens.includes(token);

const send = (ws: WebSocket, frame: ServerOutboundFrame): void => {
  ws.send(serializeOutbound(frame));
};

const serverFrameToOutbound = (frame: ServerFrame): ServerOutboundFrame | null => {
  switch (frame.type) {
    case "text_delta":
      return { type: "text_delta", delta: frame.delta };
    case "thinking_delta":
      return { type: "thinking_delta", delta: frame.delta };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        args: frame.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        partialResult: frame.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        result: frame.result,
        isError: frame.isError,
      };
    case "turn_end":
      return { type: "turn_end", usage: frame.usage };
    case "turn_start":
    case "raw":
      return null;
  }
};

const handlePrompt = (
  ws: WebSocket,
  registry: SessionRegistry,
  scheduler: ReturnType<typeof createPromptScheduler>,
  session: PiSessionLike,
  frame: Extract<InboundFrame, { type: "prompt" }>,
): void => {
  try {
    registry.markBusy(session.sessionId);
  } catch (error) {
    if (error instanceof SessionBusyError) {
      send(ws, { type: "error", code: "session_busy", message: error.message });
      return;
    }
    throw error;
  }

  if (frame.thinking !== undefined) session.setThinkingLevel(frame.thinking);

  scheduler.schedule(async () => {
    try {
      await session.prompt(frame.text);
    } finally {
      if (registry.get(session.sessionId) !== undefined) {
        registry.clearBusy(session.sessionId, Date.now());
      }
    }
  });
};

const handleInbound = (
  ws: WebSocket,
  deps: WsDeps,
  scheduler: ReturnType<typeof createPromptScheduler>,
  session: PiSessionLike,
  frame: InboundFrame,
): void => {
  switch (frame.type) {
    case "prompt":
      handlePrompt(ws, deps.registry, scheduler, session, frame);
      return;
    case "steer":
      void session.steer(frame.text);
      return;
    case "follow_up":
      void session.followUp(frame.text);
      return;
    case "abort":
      void session.abort();
      return;
  }
};

const isLiveSocket = (ws: WSLike | null): ws is WebSocket =>
  ws !== null && (ws as WebSocket).readyState === (ws as WebSocket).OPEN;

const attachWsToEntry = (deps: WsDeps, session: PiSessionLike, ws: WebSocket): void => {
  const scheduler = createPromptScheduler();

  ws.on("message", (data: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const result = parseInboundFrame(parsed);
    if (!result.ok) return;
    handleInbound(ws, deps, scheduler, session, result.frame);
  });

  ws.on("close", () => {
    // Only detach if this socket is still the entry's current socket — a
    // superseding reconnect may have already swapped in a newer one (EDGE-013).
    const entry = deps.registry.get(session.sessionId);
    if (entry?.ws === ws) deps.registry.detach(session.sessionId);
  });
};

// Persistent per-entry subscriber: routes pi events to the entry's current
// live socket, or buffers them while detached (REQ-015 / EDGE-014).
const subscribeEntry = (deps: WsDeps, session: PiSessionLike): (() => void) =>
  session.subscribe((event) => {
    const frame = toServerFrame(event);
    const entry = deps.registry.get(session.sessionId);
    if (entry === undefined) return;
    if (isLiveSocket(entry.ws)) {
      const outbound = serverFrameToOutbound(frame);
      if (outbound !== null) send(entry.ws, outbound);
      return;
    }
    entry.buffer.push(frame);
  });

const replayBuffer = (deps: WsDeps, id: string, ws: WebSocket): void => {
  const entry = deps.registry.get(id);
  if (entry === undefined) return;
  const { frames, truncated } = entry.buffer.drain();
  if (truncated) send(ws, { type: "truncated" });
  for (const frame of frames) {
    const outbound = serverFrameToOutbound(frame);
    if (outbound !== null) send(ws, outbound);
  }
};

const reattach = (deps: WsDeps, session: PiSessionLike, ws: WebSocket): void => {
  const entry = deps.registry.get(session.sessionId)!;
  const stale = entry.ws;
  deps.registry.attach(session.sessionId, ws);
  if (stale !== null && stale !== ws) (stale as WebSocket).terminate();
  attachWsToEntry(deps, session, ws);
  send(ws, { type: "session_ready", session_id: session.sessionId });
  replayBuffer(deps, session.sessionId, ws);
};

const onConnection = async (
  ws: WebSocket,
  req: IncomingMessage,
  deps: WsDeps,
): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("session_id");

  let session: PiSessionLike;
  try {
    session = sessionId === null
      ? await deps.createSession()
      : await deps.openSession(sessionId);
  } catch {
    send(ws, { type: "error", code: "auth_error", message: "session_open_failed" });
    ws.close();
    return;
  }

  const existing = deps.registry.get(session.sessionId);
  if (existing !== undefined) {
    if (isLiveSocket(existing.ws)) {
      send(ws, {
        type: "error",
        code: "session_in_use",
        message: `session ${session.sessionId} already attached`,
      });
      ws.close();
      return;
    }
    reattach(deps, session, ws);
    return;
  }

  try {
    deps.registry.add(session.sessionId, session, ws);
  } catch (error) {
    if (error instanceof AtCapacityError) {
      send(ws, { type: "error", code: "at_capacity", message: error.message });
      ws.close();
      return;
    }
    throw error;
  }

  const unsubscribe = subscribeEntry(deps, session);
  deps.registry.get(session.sessionId)!.onDispose = unsubscribe;
  attachWsToEntry(deps, session, ws);
  send(ws, { type: "session_ready", session_id: session.sessionId });
};

const HEARTBEAT_MS = 30000;

interface HeartbeatSocket extends WebSocket {
  isAlive?: boolean;
}

export const attachWsServer = (httpServer: Server, deps: WsDeps): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(tokenFromRequest(url, req), deps.cfg)) {
      socket.write(`HTTP/1.1 ${CLOSE_AUTH} Unauthorized\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const hb = ws as HeartbeatSocket;
      hb.isAlive = true;
      ws.on("pong", () => {
        hb.isAlive = true;
      });
      void onConnection(ws, req, deps);
    });
  });

  // Dead-socket detection: terminate sockets that miss a pong, which fires
  // the entry's close handler → detach (EDGE-013).
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const hb = client as HeartbeatSocket;
      if (hb.isAlive === false) {
        hb.terminate();
        continue;
      }
      hb.isAlive = false;
      hb.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
};
