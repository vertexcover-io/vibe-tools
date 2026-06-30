// AI-generated. See PROMPT.md for the prompts and model used.
import { describe, it, expect } from "vitest";
import { createClient } from "./client.ts";
import type { ServerOutboundFrame } from "@agentwire/protocol";

class FakeSocket {
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  emit(frame: ServerOutboundFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  fail(): void {
    this.onerror?.({});
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
}

const makeSocketFactory = (): {
  sockets: FakeSocket[];
  factory: (url: string) => FakeSocket;
} => {
  const sockets: FakeSocket[] = [];
  const factory = (url: string): FakeSocket => {
    const sock = new FakeSocket(url);
    sockets.push(sock);
    return sock;
  };
  return { sockets, factory };
};

const opts = { baseUrl: "http://localhost:8080", token: "tok" };

const connected = async (): Promise<{
  client: ReturnType<typeof createClient>;
  socket: FakeSocket;
}> => {
  const { sockets, factory } = makeSocketFactory();
  const client = createClient({
    ...opts,
    webSocketFactory: factory as never,
  });
  const p = client.connect();
  const socket = sockets[0]!;
  socket.emit({ type: "session_ready", session_id: "s1" });
  await p;
  return { client, socket };
};

describe("createClient ws", () => {
  it("connect() resolves on session_ready and sets sessionId", async () => {
    const { client } = await connected();
    expect(client.sessionId()).toBe("s1");
  });

  it("connect URL swaps http->ws and carries token", async () => {
    const { socket } = await connected();
    expect(socket.url).toBe("ws://localhost:8080/sessions/ws?token=tok");
  });

  it("connect({sessionId}) appends session_id", async () => {
    const { sockets, factory } = makeSocketFactory();
    const client = createClient({ ...opts, webSocketFactory: factory as never });
    const p = client.connect({ sessionId: "prev" });
    sockets[0]!.emit({ type: "session_ready", session_id: "prev" });
    await p;
    expect(sockets[0]!.url).toBe(
      "ws://localhost:8080/sessions/ws?token=tok&session_id=prev",
    );
  });

  it("connect() rejects naming the token cause when the server closes (auth 4401)", async () => {
    const { sockets, factory } = makeSocketFactory();
    const client = createClient({ ...opts, webSocketFactory: factory as never });
    const p = client.connect();
    sockets[0]!.serverClose(4401);
    await expect(p).rejects.toThrow(/bearer token.*SERVER_BEARER_TOKENS/i);
  });

  it("connect() rejects with a real Error (not [object Event]) and names likely causes", async () => {
    const { sockets, factory } = makeSocketFactory();
    const client = createClient({ ...opts, webSocketFactory: factory as never });
    const p = client.connect();
    sockets[0]!.fail();
    await expect(p).rejects.toThrow(/could not connect.*token.*not running/is);
  });

  it("connect() rejects only once even if error and close both fire", async () => {
    const { sockets, factory } = makeSocketFactory();
    const client = createClient({ ...opts, webSocketFactory: factory as never });
    const p = client.connect();
    sockets[0]!.fail();
    sockets[0]!.serverClose(1006); // second signal must be a no-op
    await expect(p).rejects.toThrow(/could not connect/i);
  });

  it("a close AFTER session_ready does not reject the resolved connect", async () => {
    const { client, socket } = await connected();
    socket.serverClose(1000); // must not throw / unhandled-reject
    expect(client.sessionId()).toBe("s1");
  });

  it("prompt sends exact frame with thinking", async () => {
    const { client, socket } = await connected();
    client.prompt("hi", { thinking: "high" });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "prompt",
      text: "hi",
      thinking: "high",
    });
  });

  it("prompt without thinking omits the field", async () => {
    const { client, socket } = await connected();
    client.prompt("yo");
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "prompt", text: "yo" });
  });

  it("steer/followUp/abort send the right frames", async () => {
    const { client, socket } = await connected();
    client.steer("s");
    client.followUp("f");
    client.abort();
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "steer", text: "s" },
      { type: "follow_up", text: "f" },
      { type: "abort" },
    ]);
  });

  it("text_delta reaches on('text_delta'); unsubscribe stops it", async () => {
    const { client, socket } = await connected();
    const seen: string[] = [];
    const off = client.on("text_delta", (f) => seen.push(f.delta));
    socket.emit({ type: "text_delta", delta: "a" });
    off();
    socket.emit({ type: "text_delta", delta: "b" });
    expect(seen).toEqual(["a"]);
  });

  it("error frame reaches on('error')", async () => {
    const { client, socket } = await connected();
    const errs: string[] = [];
    client.on("error", (f) => errs.push(f.code));
    socket.emit({ type: "error", code: "session_busy", message: "x" });
    expect(errs).toEqual(["session_busy"]);
  });

  it("truncated frame reaches on('truncated')", async () => {
    const { client, socket } = await connected();
    let hit = false;
    client.on("truncated", () => {
      hit = true;
    });
    socket.emit({ type: "truncated" });
    expect(hit).toBe(true);
  });

  it("close() closes the socket", async () => {
    const { client, socket } = await connected();
    client.close();
    expect(socket.closed).toBe(true);
  });
});

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const mockFetch = (
  resp: { status?: number; json?: unknown },
): { fetchImpl: typeof fetch; calls: Captured[] } => {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: (resp.status ?? 200) < 400,
      status: resp.status ?? 200,
      json: async () => resp.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("createClient rest", () => {
  it("complete POSTs /complete with bearer + body", async () => {
    const { fetchImpl, calls } = mockFetch({
      json: { session_id: "s", text: "ok", usage: {} },
    });
    const client = createClient({ ...opts, fetchImpl });
    const r = await client.complete("hello");
    expect(calls[0]).toMatchObject({
      url: "http://localhost:8080/complete",
      method: "POST",
      body: { prompt: "hello" },
    });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(r).toMatchObject({ text: "ok" });
  });

  it("listSessions GETs /sessions with query", async () => {
    const { fetchImpl, calls } = mockFetch({
      json: { sessions: [], nextCursor: null },
    });
    const client = createClient({ ...opts, fetchImpl });
    await client.listSessions(5, "cur");
    expect(calls[0]!.url).toBe(
      "http://localhost:8080/sessions?limit=5&cursor=cur",
    );
    expect(calls[0]!.method).toBe("GET");
  });

  it("messages returns null on 404", async () => {
    const { fetchImpl } = mockFetch({ status: 404 });
    const client = createClient({ ...opts, fetchImpl });
    expect(await client.messages("s1")).toBeNull();
  });

  it("messages returns .messages on 200", async () => {
    const { fetchImpl, calls } = mockFetch({
      json: { messages: [{ a: 1 }] },
    });
    const client = createClient({ ...opts, fetchImpl });
    const m = await client.messages("s1");
    expect(m).toEqual([{ a: 1 }]);
    expect(calls[0]!.url).toBe("http://localhost:8080/sessions/s1/messages");
  });

  it("fork POSTs /sessions/:id/fork with entry_id", async () => {
    const { fetchImpl, calls } = mockFetch({ json: { session_id: "f1" } });
    const client = createClient({ ...opts, fetchImpl });
    await client.fork("s1", "e9");
    expect(calls[0]).toMatchObject({
      url: "http://localhost:8080/sessions/s1/fork",
      method: "POST",
      body: { entry_id: "e9" },
    });
  });

  it("remove DELETEs /sessions/:id", async () => {
    const { fetchImpl, calls } = mockFetch({ json: undefined });
    const client = createClient({ ...opts, fetchImpl });
    await client.remove("s1");
    expect(calls[0]).toMatchObject({
      url: "http://localhost:8080/sessions/s1",
      method: "DELETE",
    });
  });
});
