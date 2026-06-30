// AI-generated. See PROMPT.md for the prompts and model used.
import type {
  ServerOutboundFrame,
  ThinkingLevel,
  CompleteResult,
  ListResult,
  ForkResult,
} from "@agentwire/protocol";

interface SocketLike {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly webSocketFactory?: (url: string) => SocketLike;
  readonly fetchImpl?: typeof fetch;
}

type FrameType = ServerOutboundFrame["type"];
type FrameHandler = (frame: ServerOutboundFrame) => void;

export interface AgentClient {
  connect(opts?: { sessionId?: string }): Promise<void>;
  on<T extends FrameType>(
    type: T,
    handler: (frame: Extract<ServerOutboundFrame, { type: T }>) => void,
  ): () => void;
  prompt(text: string, opts?: { thinking?: ThinkingLevel }): void;
  steer(text: string): void;
  followUp(text: string): void;
  abort(): void;
  complete(prompt: string): Promise<CompleteResult>;
  listSessions(limit?: number, cursor?: string): Promise<ListResult>;
  messages(id: string): Promise<readonly unknown[] | null>;
  fork(id: string, entryId?: string): Promise<ForkResult>;
  remove(id: string): Promise<void>;
  sessionId(): string | undefined;
  close(): void;
}

const wsUrl = (baseUrl: string, token: string, sessionId?: string): string => {
  const base = baseUrl.replace(/\/$/, "").replace(/^http/, "ws");
  const q = new URLSearchParams({ token });
  if (sessionId !== undefined) q.set("session_id", sessionId);
  return `${base}/sessions/ws?${q.toString()}`;
};

// 4401 is the server's "unauthorized" close code; 1006 is the browser's "closed
// abnormally" (no server close frame reached us — typically server unreachable).
const closeReason = (code?: number, reason?: string): string => {
  if (code === 4401) return "401 unauthorized: bearer token rejected";
  if (code === 1006 || code === undefined) return "could not reach server";
  return reason ? `connection closed: ${reason}` : `connection closed (${code})`;
};

export const createClient = (opts: ClientOptions): AgentClient => {
  const httpBase = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket =
    opts.webSocketFactory ??
    ((url: string): SocketLike => new WebSocket(url) as unknown as SocketLike);

  const handlers = new Map<FrameType, Set<FrameHandler>>();
  let socket: SocketLike | undefined;
  let sid: string | undefined;

  const dispatch = (frame: ServerOutboundFrame): void => {
    for (const h of handlers.get(frame.type) ?? []) h(frame);
  };

  const send = (frame: unknown): void => {
    socket?.send(JSON.stringify(frame));
  };

  const restHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${opts.token}`,
  });

  const jsonHeaders = (): Record<string, string> => ({
    ...restHeaders(),
    "Content-Type": "application/json",
  });

  return {
    connect: (connectOpts) =>
      new Promise<void>((resolve, reject) => {
        const url = wsUrl(opts.baseUrl, opts.token, connectOpts?.sessionId);
        const sock = makeSocket(url);
        socket = sock;
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        sock.onmessage = (ev): void => {
          const frame = JSON.parse(ev.data) as ServerOutboundFrame;
          if (frame.type === "session_ready") {
            sid = frame.session_id;
            settle(resolve);
          }
          dispatch(frame);
        };
        // The server closes an unauthorized upgrade with code 4401, which the
        // browser delivers here (a generic transport failure arrives as 1006).
        sock.onclose = (ev): void =>
          settle(() =>
            reject(new Error(closeReason(ev?.code, ev?.reason))),
          );
        sock.onerror = (): void =>
          settle(() => reject(new Error(closeReason(undefined, undefined))));
      }),

    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<FrameHandler>();
      set.add(handler as FrameHandler);
      handlers.set(type, set);
      return (): void => {
        set.delete(handler as FrameHandler);
      };
    },

    prompt: (text, promptOpts) =>
      send(
        promptOpts?.thinking !== undefined
          ? { type: "prompt", text, thinking: promptOpts.thinking }
          : { type: "prompt", text },
      ),
    steer: (text) => send({ type: "steer", text }),
    followUp: (text) => send({ type: "follow_up", text }),
    abort: () => send({ type: "abort" }),

    complete: async (prompt) => {
      const res = await doFetch(`${httpBase}/complete`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ prompt }),
      });
      return (await res.json()) as CompleteResult;
    },

    listSessions: async (limit, cursor) => {
      const q = new URLSearchParams();
      if (limit !== undefined) q.set("limit", String(limit));
      if (cursor !== undefined) q.set("cursor", cursor);
      const suffix = q.toString() === "" ? "" : `?${q.toString()}`;
      const res = await doFetch(`${httpBase}/sessions${suffix}`, {
        headers: restHeaders(),
      });
      return (await res.json()) as ListResult;
    },

    messages: async (id) => {
      const res = await doFetch(`${httpBase}/sessions/${id}/messages`, {
        headers: restHeaders(),
      });
      if (res.status === 404) return null;
      const body = (await res.json()) as { messages: readonly unknown[] };
      return body.messages;
    },

    fork: async (id, entryId) => {
      const res = await doFetch(`${httpBase}/sessions/${id}/fork`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(entryId !== undefined ? { entry_id: entryId } : {}),
      });
      return (await res.json()) as ForkResult;
    },

    remove: async (id) => {
      await doFetch(`${httpBase}/sessions/${id}`, {
        method: "DELETE",
        headers: restHeaders(),
      });
    },

    sessionId: () => sid,
    close: () => socket?.close(),
  };
};
