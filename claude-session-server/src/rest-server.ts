// AI-generated. See PROMPT.md for the prompts and model used.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";

export interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
  readonly messageCount: number;
}

export interface CompleteOk {
  readonly session_id: string;
  readonly text: string;
  readonly usage: unknown;
}

export interface CompleteErr {
  readonly session_id: string;
  readonly text: string;
  readonly error: { readonly type: string; readonly message: string };
}

export type CompleteResult = CompleteOk | CompleteErr;

export interface ListResult {
  readonly sessions: readonly SessionMeta[];
  readonly nextCursor: string | null;
}

export type ForkResult = { readonly session_id: string } | "invalid_fork_point";

export interface RestAdapter {
  complete(prompt: string): Promise<CompleteResult>;
  listSessions(limit: number, cursor?: string): Promise<ListResult>;
  loadMessages(id: string): Promise<readonly unknown[] | null>;
  fork(id: string, entryId?: string): Promise<ForkResult>;
  remove(id: string): Promise<void>;
}

export interface RestDeps {
  readonly cfg: Config;
  readonly adapter: RestAdapter;
}

const DEFAULT_LIMIT = 50;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const parseJson = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const hasValidBearer = (req: IncomingMessage, tokens: readonly string[]): boolean => {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1] ?? "";
  return tokens.includes(token);
};

const parseLimit = (value: string | null): number => {
  if (value === null) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const handleComplete = async (
  adapter: RestAdapter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.prompt !== "string" || body.prompt.length === 0) {
    sendJson(res, 400, { error: "prompt_required" });
    return;
  }
  const result = await adapter.complete(body.prompt);
  sendJson(res, 200, result);
};

const handleList = async (
  adapter: RestAdapter,
  url: URL,
  res: ServerResponse,
): Promise<void> => {
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const result = await adapter.listSessions(limit, cursor);
  sendJson(res, 200, result);
};

const handleMessages = async (
  adapter: RestAdapter,
  id: string,
  res: ServerResponse,
): Promise<void> => {
  const messages = await adapter.loadMessages(id);
  if (messages === null) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  sendJson(res, 200, { messages });
};

const handleFork = async (
  adapter: RestAdapter,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  const body = parsed.value;
  const entryId =
    isRecord(body) && typeof body.entry_id === "string" ? body.entry_id : undefined;
  const result = await adapter.fork(id, entryId);
  if (result === "invalid_fork_point") {
    sendJson(res, 400, { error: "invalid_fork_point" });
    return;
  }
  sendJson(res, 200, result);
};

const handleDelete = async (
  adapter: RestAdapter,
  id: string,
  res: ServerResponse,
): Promise<void> => {
  await adapter.remove(id);
  res.writeHead(204);
  res.end();
};

type Route =
  | { kind: "complete" }
  | { kind: "list" }
  | { kind: "messages"; id: string }
  | { kind: "fork"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "health" }
  | { kind: "not_found" };

const matchRoute = (method: string, pathname: string): Route => {
  if (method === "GET" && pathname === "/health") return { kind: "health" };
  if (method === "POST" && pathname === "/complete") return { kind: "complete" };
  if (method === "GET" && pathname === "/sessions") return { kind: "list" };

  const messages = /^\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (method === "GET" && messages) return { kind: "messages", id: messages[1]! };

  const fork = /^\/sessions\/([^/]+)\/fork$/.exec(pathname);
  if (method === "POST" && fork) return { kind: "fork", id: fork[1]! };

  const session = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (method === "DELETE" && session) return { kind: "delete", id: session[1]! };

  return { kind: "not_found" };
};

export const createRestServer = (deps: RestDeps): Server => {
  const { cfg, adapter } = deps;

  return createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = matchRoute(method, url.pathname);

        if (route.kind === "health") {
          sendJson(res, 200, { status: "ok", services: {} });
          return;
        }

        if (!hasValidBearer(req, cfg.bearerTokens)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        switch (route.kind) {
          case "complete":
            await handleComplete(adapter, req, res);
            return;
          case "list":
            await handleList(adapter, url, res);
            return;
          case "messages":
            await handleMessages(adapter, route.id, res);
            return;
          case "fork":
            await handleFork(adapter, route.id, req, res);
            return;
          case "delete":
            await handleDelete(adapter, route.id, res);
            return;
          case "not_found":
            sendJson(res, 404, { error: "not_found" });
            return;
        }
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error" });
        }
      }
    })();
  });
};
