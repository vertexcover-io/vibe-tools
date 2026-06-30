// AI-generated. See PROMPT.md for the prompts and model used.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { verifyToken } from "../auth/jwt.js";
import type { DbClient } from "../db/client.js";
import type { Env } from "../env.js";
import { searchInternal } from "../lib/search-internal.js";
import {
  findSessionsForPr,
  getSessionForUser,
  listRecent,
  setSessionPrivate,
} from "../lib/sessions-internal.js";

const buildMcpServer = (db: DbClient, userId: string): McpServer => {
  const server = new McpServer({ name: "claude-sessions", version: "0.1.0" });

  server.tool(
    "search_sessions",
    "Hybrid FTS + vector search across this user's accessible sessions.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, limit }) => {
      const result = await searchInternal(db, userId, query, {
        limit: limit ?? 10,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "get_session",
    "Fetch a single session by id.",
    { session_id: z.string() },
    async ({ session_id }) => {
      const detail = await getSessionForUser(db, userId, session_id);
      if (!detail) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "session not found" }) }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(detail) }] };
    },
  );

  server.tool(
    "find_sessions_for_pr",
    "Find sessions whose summary references the given PR URL.",
    { pr_url: z.string() },
    async ({ pr_url }) => {
      const sessions = await findSessionsForPr(db, userId, pr_url);
      return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
    },
  );

  server.tool(
    "get_my_recent_sessions",
    "List the user's most recent sessions, optionally filtered.",
    {
      limit: z.number().int().min(1).max(50).optional(),
      agent: z.string().optional(),
      repo: z.string().optional(),
    },
    async (args) => {
      const opts: { limit?: number; agent?: string; repo?: string } = {};
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.agent !== undefined) opts.agent = args.agent;
      if (args.repo !== undefined) opts.repo = args.repo;
      const result = await listRecent(db, userId, opts);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "mark_current_session_private",
    "Withdraw a session from the cloud (privacy).",
    { session_id: z.string() },
    async ({ session_id }) => {
      await setSessionPrivate(db, userId, session_id, true);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.tool(
    "mark_current_session_public",
    "Re-publish a previously-private session.",
    { session_id: z.string() },
    async ({ session_id }) => {
      await setSessionPrivate(db, userId, session_id, false);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  return server;
};

export const buildMcpRouter = (db: DbClient, env: Env): Hono => {
  const router = new Hono();

  const handle = async (req: Request, token: string): Promise<Response> => {
    let userId: string;
    try {
      const payload = await verifyToken(token, env.JWT_SECRET);
      if (payload.aud !== "mcp") return new Response("unauthorized", { status: 401 });
      userId = payload.sub;
    } catch {
      return new Response("unauthorized", { status: 401 });
    }

    const server = buildMcpServer(db, userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // Schedule cleanup after the response body is consumed.
    res.headers.append("x-mcp-server", "claude-sessions");
    return res;
  };

  router.all("/:token", async (c) => {
    return handle(c.req.raw, c.req.param("token"));
  });

  return router;
};
