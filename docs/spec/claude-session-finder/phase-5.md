# Phase 5: Search + MCP

> **Status:** pending
> **Depends on:** Phase 4
> **Traces to:** REQ-022, REQ-029, REQ-047

## Overview

Two server endpoints + the CLI commands that use them:

1. **`/api/search`** — hybrid Postgres FTS + pgvector cosine, RRF-merged
2. **`/mcp/<token>`** — MCP server with 6 tools, mounted on the same Hono process via `@modelcontextprotocol/sdk` HTTP+SSE transport
3. **CLI**: `claude-sessions find <query>` opens browser to `/search?q=...`; `claude-sessions mcp` prints the install command

## Search endpoint

```ts
// routes/search.ts
const SearchQuery = z.object({
  q: z.string().min(1),
  repo: z.string().optional(),
  branch: z.string().optional(),
  agent: z.string().optional(),
  has_pr: z.coerce.boolean().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

searchRouter.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const params = SearchQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));

  // 1. Embed the query
  const qVec = await getEmbedProvider().embed(params.q);

  // 2. Build filter clauses (RBAC + user filters)
  const accessibleRepoIds = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, user.id));

  const filters = [
    inArray(sessions.repoId, accessibleRepoIds.map(r => r.repoId)),
    params.repo ? eq(repos.canonicalUrl, params.repo) : undefined,
    params.branch ? eq(sessions.branch, params.branch) : undefined,
    params.agent ? eq(sessions.agent, params.agent) : undefined,
    params.since ? gte(sessions.startedAt, params.since) : undefined,
  ].filter(Boolean);

  // 3. FTS top-K
  const ftsResults = await db.execute(sql`
    SELECT s.id, s.started_at,
           ts_rank(to_tsvector('english',
             coalesce(sm.title,'') || ' ' || coalesce(sm.summary,'') || ' ' || array_to_string(sm.tags, ' ')),
             plainto_tsquery('english', ${params.q})) AS rank
    FROM sessions s
    JOIN summaries sm ON sm.session_id = s.id
    WHERE ${and(...filters)}
      AND to_tsvector('english',
            coalesce(sm.title,'') || ' ' || coalesce(sm.summary,'') || ' ' || array_to_string(sm.tags, ' '))
          @@ plainto_tsquery('english', ${params.q})
    ORDER BY rank DESC
    LIMIT 50
  `);

  // 4. Vector top-K
  const vecResults = await db.execute(sql`
    SELECT s.id, 1 - (e.embedding <=> ${qVec}::vector) AS sim
    FROM embeddings e
    JOIN sessions s ON s.id = e.session_id
    WHERE ${and(...filters)}
    ORDER BY e.embedding <=> ${qVec}::vector
    LIMIT 50
  `);

  // 5. RRF merge
  const merged = reciprocalRankFusion([
    ftsResults.rows.map((r, i) => ({ id: r.id, rank: i })),
    vecResults.rows.map((r, i) => ({ id: r.id, rank: i })),
  ], { k: 60 });

  // 6. Hydrate top N with metadata
  const top = merged.slice(0, params.limit);
  const hydrated = await db.query.sessions.findMany({
    where: inArray(sessions.id, top.map(t => t.id)),
    with: { summary: true, repo: true },
  });

  // Stable order matching `top`
  const ordered = top.map(t => hydrated.find(h => h.id === t.id)).filter(Boolean);

  return c.json({
    results: ordered.map(s => ({
      session_id: s.id,
      title: s.summary?.title ?? null,
      summary: s.summary?.summary ?? null,
      tags: s.summary?.tags ?? [],
      repo: s.repo?.canonicalUrl ?? null,
      branch: s.branch,
      agent: s.agent,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      total_cost_usd: s.totalCostUsd,
    })),
    strategy: "rrf",
  });
});

function reciprocalRankFusion(rankedLists: Array<Array<{id: string; rank: number}>>, opts: {k: number}): Array<{id: string; score: number}> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const { id, rank } of list) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (opts.k + rank + 1));
    }
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
```

## MCP server

Mount on the same Hono process at `/mcp/:token`. Token is a JWT with audience `mcp` and `sub` = user id. CLI generates one when user runs `claude-sessions mcp`.

```ts
// routes/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

mcpRouter.get("/:token", async (c) => {
  const payload = await verify(c.req.param("token"), { audience: "mcp" });
  const userId = payload.sub;

  const server = new McpServer({ name: "claude-sessions", version: "0.1.0" });

  server.tool("search_sessions", { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const results = await searchInternal(userId, query, { limit: limit ?? 10 });
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    });

  server.tool("get_session", { session_id: z.string() },
    async ({ session_id }) => {
      const s = await getSessionForUser(userId, session_id);
      return { content: [{ type: "text", text: JSON.stringify(s) }] };
    });

  server.tool("find_sessions_for_pr", { pr_url: z.string() },
    async ({ pr_url }) => {
      const sessions = await findSessionsForPr(userId, pr_url);
      return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
    });

  server.tool("get_my_recent_sessions", { limit: z.number().optional(), agent: z.string().optional(), repo: z.string().optional() },
    async (args) => {
      const sessions = await listRecent(userId, args);
      return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
    });

  server.tool("mark_current_session_private", { session_id: z.string() },
    async ({ session_id }) => {
      await setSessionPrivate(userId, session_id, true);
      return { content: [{ type: "text", text: "ok" }] };
    });

  server.tool("mark_current_session_public", { session_id: z.string() },
    async ({ session_id }) => {
      await setSessionPrivate(userId, session_id, false);
      return { content: [{ type: "text", text: "ok" }] };
    });

  const transport = new SSEServerTransport(`/mcp/${c.req.param("token")}/messages`, c.res);
  await server.connect(transport);
});
```

## CLI commands

```ts
// commands/find.ts
export async function findCommand(query: string) {
  const cred = await loadCredentials();
  const url = `${cred.server_url}/search?q=${encodeURIComponent(query)}`;
  await openInBrowser(url);
}

// commands/mcp.ts
export async function mcpCommand() {
  const cred = await loadCredentials();
  const mcpToken = await client(cred).post("/api/auth/mcp-token");  // server returns a fresh JWT with audience=mcp
  const cmd = `claude mcp add claude-sessions ${cred.server_url}/mcp/${mcpToken.token}`;
  console.log("Run this to register the MCP server in Claude Code:\n");
  console.log(`  ${cmd}\n`);
}

// commands/open.ts
export async function openCommand() {
  const cred = await loadCredentials();
  await openInBrowser(cred.server_url);
}
```

`openInBrowser` uses `open` (macOS), `xdg-open` (Linux), `start` (Windows) via cross-platform helper.

## Tests

- **REQ-022**: seed sessions with known summaries; query returns ranked list, RRF order is stable
- **REQ-029**: connect via MCP SDK client; `tools/list` returns exactly the 6 tool names
- **REQ-047**: `claude-sessions mcp` output starts with `claude mcp add` and contains the URL+token
- Search RBAC: user A's query never returns user B's sessions for a repo A can't access
- Search performance: with 1000 fixture sessions, p95 < 300ms

## Done When

- [ ] All tests pass
- [ ] Manually: open browser, search, see results; click into a session (404 expected since web UI is phase 6, but the JSON endpoint works)
- [ ] MCP register works in a real Claude Code session

## Commit

`feat: hybrid search + MCP server (phase 5)`
