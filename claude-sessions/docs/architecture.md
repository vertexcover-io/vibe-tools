# Architecture

## Component map

```
+----------------------------------------------------------------------+
|                              CLI (Node)                              |
|                                                                      |
|  packages/cli/src/                                                   |
|  ├── main.ts                  commander entry, wires subcommands     |
|  ├── commands/                login, enable, disable, status,        |
|  │                            sync, watch, fork, name, find, open,   |
|  │                            mcp                                    |
|  ├── config/                  ~/.claude-sessions/{credentials,       |
|  │                            repos,state}.json + atomic writes      |
|  ├── discover.ts              walk ~/.claude/projects/* for JSONL    |
|  ├── watcher/                 chokidar tail, dedupe via byte offset, |
|  │                            consume → ingest → advance offset      |
|  ├── summarizer/              claude -p runner, end-detect, prompt,  |
|  │                            deterministic stats, PR mining,        |
|  │                            global concurrency cap (2)             |
|  └── upload/client.ts         bearer-auth fetch wrapper, retry       |
+----------------------------------------------------------------------+
                                  |
                                  | HTTPS (bearer JWT, audience=cli)
                                  v
+----------------------------------------------------------------------+
|                            Server (Hono)                             |
|                                                                      |
|  packages/server/src/                                                |
|  ├── main.ts                  loadEnv → createDb → buildApp → serve  |
|  ├── app.ts                   mounts /health, /api/*, /mcp/*, SPA    |
|  ├── env.ts                   zod-parsed env (DATABASE_URL,          |
|  │                            JWT_SECRET, EMBED_PROVIDER, ...)       |
|  ├── auth/                    argon2id, jose JWT, requireAuth        |
|  ├── routes/                  health, auth, repos, ingest, sessions, |
|  │                            search, mcp, static (SPA fallback)    |
|  ├── lib/                     search-internal (RRF), sessions-internal,|
|  │                            audit                                 |
|  ├── embed/                   provider abstraction (openai, bge,     |
|  │                            fake, none)                            |
|  ├── redact.ts                deep walk + core.redact() at write     |
|  └── db/                      drizzle schema, postgres client,       |
|                               migrate.ts (idempotent, file-by-file)  |
+----------------------------------------------------------------------+
                                  |
                                  | postgres protocol
                                  v
+----------------------------------------------------------------------+
|                       Postgres + pgvector                            |
|                                                                      |
|  users, repos, user_repos, sessions, events, summaries,              |
|  embeddings (HNSW cosine), session_blobs (bytea), session_pr_links, |
|  audit_log, schema_migrations                                        |
+----------------------------------------------------------------------+
```

## Data flows

### 1. Ingest

```
JSONL append
  → chokidar fires `change` on parent directory (watcher/chokidar.ts)
  → consumeFile(path) reads first line for cwd + sessionId
  → repo opt-in check (config/repos.ts)
  → sidecar private check (watcher/privacy.ts) — short-circuits to
    PATCH /api/sessions/:id { is_private: true } and advances offset
  → adapter-claude/streamEvents(path, { byteOffset })
  → core.redact() on every string leaf (defense-in-depth pass 1)
  → POST /api/ingest { session, events }
       → server zod-parses, server.redactDeep() (pass 2)
       → upsert sessions row (last-write-wins on metadata)
       → bulk-insert events ON CONFLICT (session_id, event_uuid) DO NOTHING
       → return { accepted_events, skipped_duplicates }
  → on 2xx: setFileState(path, { byte_offset = size, ... })
  → on 5xx: retry with backoff; offset stays put → server dedupes
```

### 2. Summarize

```
end-detect timer fires after 60s of silence on a sessionId
  → Summarizer.summarize(sessionId, jsonlPath)
  → semaphore acquire (cap=2 globally)
  → pipeline:
      runClaude(prompt) → JSON summary { title, summary, tags, files_touched }
      computeDeterministic(events) → { tool_call_counts, total_tokens, cost }
      minePrs(events, summary) → prs_referenced
  → POST /api/sessions/:id/summary { ... }
       → server redactDeep(title, summary)
       → tx: upsert summaries row
       →     compute embedding inline (OpenAI text-embedding-3-small, 1536d)
       →     upsert embeddings row with HNSW cosine vector
  → semaphore release
```

### 3. Search

```
GET /api/search?q=hello&limit=20
  → searchInternal(db, userId, "hello", { limit: 20 })
  → embed(query) → 1536d qVec
  → fetch user's accessible repo IDs (user_repos)
  → FTS: ts_rank(summaries_fts_text(title, summary, tags), plainto_tsquery)
       LIMIT 50
  → vector: ORDER BY embedding <=> qVec::vector LIMIT 50
  → reciprocalRankFusion([fts, vec], k=60)
  → take top 20, hydrate with sessions+repo+summary metadata
  → optional has_pr filter applied post-hoc (small set)
  → response: { results: [{ session_id, title, summary, tags, repo, ... }],
                strategy: "rrf" }
```

### 4. Fork

```
User clicks "Fork from here" on event UUID `e123` in web UI
  → web copies command:
    `claude-sessions fork <sid> --until e123 --cwd /path/to/repo`
  → CLI:
      GET /api/sessions/<sid> → session metadata, infer source repo URL
      resolve --cwd (default: registered local_path for source repo)
      GET /api/sessions/<sid>/blob → raw NDJSON bytes
      truncate at line whose `uuid === e123`
      rewrite each line: cwd=<new cwd>, sessionId=<newSessionId>
      first line: parentUuid = null
      write ~/.claude/projects/<encoded-cwd>/<newSessionId>.jsonl
        (refuse to overwrite — EDGE-022)
      print: cd <cwd> && claude --resume <newSessionId>
```

### 5. MCP

```
User runs `claude-sessions mcp`
  → POST /api/auth/mcp-token with bearer
  → server signs new JWT with audience=mcp
  → CLI prints: claude mcp add claude-sessions http://server/mcp/<token>

Claude Code → /mcp/:token (Streamable HTTP)
  → verifyToken(token) — must have audience=mcp
  → buildMcpServer(db, userId) wires 6 tools:
      search_sessions  (calls searchInternal)
      get_session
      find_sessions_for_pr
      get_my_recent_sessions
      mark_current_session_private  (deletes events/summary/embed/blob)
      mark_current_session_public
  → WebStandardStreamableHTTPServerTransport.handleRequest(req)
```

## Session lifecycle

```
1. user opens claude → claude writes ~/.claude/projects/<cwd>/<sid>.jsonl
2. CLI watcher (already running) sees `add`/`change`
3. consumeFile streams new bytes → POST /api/ingest
4. for every batch: server upserts sessions row, inserts events
5. claude session ends; user closes terminal
6. 60s of silence → SessionEndDetector fires
7. summarizer runs claude -p on the JSONL → JSON summary
8. POST /api/sessions/:id/summary → server stores summary + embedding
9. (optional) PUT /api/sessions/:id/blob → raw NDJSON for fork support
10. session is now searchable in web UI, MCP, REST search endpoint
11. (later) user marks private → events/summary/embedding/blob hard-deleted,
    only the sessions row remains so audit_log FKs still resolve
```

## Schema overview

Tables (`packages/server/src/db/schema.ts`, migration `0001_init.sql`):

```
users (id uuid pk, email unique, password_hash, role)
  └─ user_repos (user_id, repo_id, access)  ──┐
                                              │ many-to-many
repos (id uuid pk, canonical_url unique) ─────┘

sessions (id text pk, user_id, repo_id, agent, agent_version, branch,
          source_cwd_hint, model, started_at, ended_at,
          total_input_tokens, total_output_tokens, total_cost_usd,
          permission_mode, is_private, name, has_blob)
  ├─ events (session_id, event_uuid, parent_uuid, ts, type, payload jsonb)
  │       primary key (session_id, event_uuid)  ← natural dedup
  ├─ summaries (session_id pk, title, summary, tags[], files_touched[],
  │             prs_referenced[], tool_call_counts jsonb, model, status)
  ├─ embeddings (session_id pk, embedding vector(1536), embedding_model)
  │       HNSW index on cosine
  ├─ session_blobs (session_id pk, jsonl_bytes bytea, byte_size)
  └─ session_pr_links (session_id, pr_url, source)

audit_log (id uuid pk, actor_user_id, action, target_session_id, ts, detail)
  ─ blob reads, session detail reads, marked_private, marked_public, renamed
```

Indexes worth noting:

- `idx_sessions_user_repo (user_id, repo_id)` — RBAC + repo-scoped feeds
- `idx_sessions_started_at DESC` — recent feed
- `idx_events_session_ts (session_id, ts)` — chronological transcript
- `idx_summaries_fts` (gin) — FTS on `summaries_fts_text(title, summary, tags)`
- `idx_embeddings_cosine` (hnsw) — vector search
- `idx_audit_actor_ts (actor_user_id, ts DESC)` — per-user audit history

The `summaries_fts_text(t, s, tags)` is an immutable SQL function that returns a tsvector concatenating the three fields — the FTS index is built over its output so writes don't have to maintain a denormalized column.

## Decision log

### Why no SQLite

The CLI used to keep SQLite for cached summaries and offline queries. The user said: "I want one place where the truth lives — the cloud server. If I'm offline, I'm offline." So the local CLI now keeps **only**:

- `~/.claude-sessions/credentials.json` — bearer token
- `~/.claude-sessions/repos.json` — opted-in repo list
- `~/.claude-sessions/state.json` — per-file `byte_offset` so we don't re-upload bytes we already shipped
- `~/.claude-sessions/sessions/<id>.private` — per-session sidecar markers

None of these are query caches. Search and read paths always hit the server.

### Why no worker / Redis (REQ-063)

The classic shape — `POST /api/ingest` enqueues a job, a worker pops it, redacts, embeds, indexes — was rejected because:

- It doubles the deploy footprint (web + worker + Redis)
- It introduces an outbox / job table that needs its own monitoring
- For ingest throughput, inline-in-handler easily handles a single user across multiple machines
- `claude -p` runs locally on the CLI machine, not on the server, so the heavy LLM work isn't centralized anyway

The summary upload route does the embedding inline (REQ-038) so callers see a single 200 only after both summary and embedding are committed.

### Why pgvector inline (not async)

Async embedding requires reliable retries, which requires a job queue. We avoid that whole arc by computing embeddings in the same DB transaction as the summary insert. If embedding generation fails, the summary insert rolls back and the CLI retries the upload — the server is the source of truth and never has a "summary present, embedding missing" race.

### Why bytea blob (not S3) (REQ-061, REQ-062)

S3 (or any object store) is a second backup target, second IAM surface, and second deploy dependency. Transcripts are bounded (we cap at 100MB per blob, REQ-061 enforces this in the PUT handler) and uncommonly read (only on fork or download), so storing them as `bytea` keeps the whole product to one container + one Postgres.

The `GET /api/sessions/:id/blob` route copies bytes into a fresh `Uint8Array` before responding so we don't hand the postgres driver's pool buffer to Node's `Response`.

### Why a single-process server

The web SPA, REST API, and MCP transport all live on the same Hono process (`packages/server/src/app.ts`). The static handler at `/` serves `packages/web/dist`, falling back to `index.html` for client-side routes. Reserved prefixes (`/api/`, `/mcp`, `/health`) bypass the static handler. One port, one process, one deploy.
