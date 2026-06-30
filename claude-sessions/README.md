# claude-sessions

A personal-cloud product for indexing, summarizing, and searching Claude Code sessions across all your machines. The CLI watches `~/.claude/projects/**/*.jsonl`, redacts secrets, ingests events into a Postgres-backed server, generates per-session summaries with `claude -p`, and exposes the index through a web UI, REST API, and MCP server.

## Architecture

```
+--------------------+        +----------------------+        +-----------+
|  CLI (Node)        |        |  Server (Hono)       |        |  Postgres |
|                    |        |                      |        |  + pgvec  |
|  - watcher         |  HTTPS |  - REST routes       |  pg    |           |
|  - redactor        | -----> |  - MCP transport     | -----> |  schema:  |
|  - summarizer      |        |  - inline embedding  |        |  users,   |
|  - fork rebuild    |        |  - hybrid search RRF |        |  repos,   |
|                    | <----- |  - serves SPA dist   | <----- |  sessions,|
+--------------------+        +----------------------+        |  events,  |
        ^                              ^                      |  summaries|
        |                              |                      |  embeddings,|
        |                          REST + MCP                 |  blobs,   |
        |                              |                      |  audit_log|
+-------+--------+         +-----------+-----------+          +-----------+
|  ~/.claude/    |         |  Web SPA (React)      |
|  projects/     |         |  served from /        |
|  *.jsonl       |         |  by the same server   |
+----------------+         +-----------------------+
```

Single-process server, no worker, no Redis. All write-side work (redact, persist, embed) happens inline in the request that triggered it (REQ-038, REQ-063).

## Quickstart — server

```sh
cd claude-sessions
docker compose up -d postgres
cp .env.example .env                  # edit DATABASE_URL, JWT_SECRET, OPENAI_API_KEY
bun install
bun run db:migrate                    # creates extensions, tables, indexes
bun run --filter @claude-sessions/server dev
```

Required env vars:

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/claude_sessions` | pgvector image is mapped to host port 5433 in `docker-compose.yml` |
| `JWT_SECRET` | — | 8+ chars, signs CLI/web/MCP tokens |
| `EMBED_PROVIDER` | `openai` | `openai`, `bge`, `fake`, `none` |
| `OPENAI_API_KEY` | — | Required when `EMBED_PROVIDER=openai` |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Must produce 1536-dim vectors |
| `PORT` | `3000` | |
| `WEB_DIST` | `packages/web/dist` | Static SPA served from this directory at `/` |

There is no public registration endpoint. Seed a user directly with the helper in `packages/server/tests/helpers/seed.ts` or insert one with SQL — the password column is argon2id-hashed (`packages/server/src/auth/argon.ts`).

## Quickstart — web

```sh
bun run --filter @claude-sessions/web build
# packages/web/dist/ is now served by the running server at http://localhost:3000
```

For development with hot reload:

```sh
bun run --filter @claude-sessions/web dev    # vite at :5173, proxies /api to :3000
```

## Quickstart — CLI

```sh
bun run --filter @claude-sessions/cli build
node packages/cli/dist/main.js login \
  --server http://localhost:3000 \
  --email you@example.com \
  --password '...'
node packages/cli/dist/main.js enable .
node packages/cli/dist/main.js watch
```

Token + per-repo state live under `~/.claude-sessions/` (override with `CLAUDE_SESSIONS_HOME`).

## CLI commands

| Command | What it does |
|---|---|
| `login --server <url> --email <e> --password <p>` | Authenticate, persist token to `~/.claude-sessions/credentials.json` (mode 0600) |
| `enable [path]` | Register a repo (cwd by default), upsert it on the server, backfill existing JSONL |
| `disable [path] [--purge]` | Stop syncing this repo locally; `--purge` deletes its events from the server |
| `status` | Print a table of enabled repos and their last-sync timestamps |
| `sync` | One-shot catch-up: stream any pending events for every enabled repo |
| `watch` | Long-running tail. Watches JSONL parents, dedupes via byte offsets, summarizes on session-end silence |
| `fork <session-id> --until <event-uuid> [--cwd <path>]` | Pull blob, truncate, rewrite cwd + sessionId, write a fresh JSONL under `~/.claude/projects/`, print resume command |
| `name <session-id> [name]` | Set or clear the user-set display name (overrides LLM title) |
| `find <query...>` | Open dashboard search at `<server>/search?q=...` |
| `open` | Open the dashboard |
| `mcp` | Mint an MCP-scoped JWT and print the `claude mcp add` command |

## Server endpoints

REST (all `/api/*` routes require cookie or bearer auth):

- `POST /api/auth/login` — issues bearer (audience `cli`) and `session` cookie (audience `web`)
- `GET  /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/mcp-token` — exchange auth for an MCP-scoped JWT
- `GET  /api/repos` — enabled repos with session counts
- `GET  /api/repos/:canonical/sessions` — session list per repo
- `POST /api/repos/enable` / `POST /api/repos/disable`
- `POST /api/ingest` — batch upload session + events (CLI watcher target)
- `GET  /api/sessions` — recent feed across all enabled repos
- `GET  /api/sessions/:id` — metadata + summary + display_name resolution
- `GET  /api/sessions/:id/events` — chronological event stream
- `POST /api/sessions/:id/summary` — store summary; embedding is generated inline
- `PUT  /api/sessions/:id/blob` / `GET /api/sessions/:id/blob` — raw NDJSON bytes
- `PATCH /api/sessions/:id` — set name; flip `is_private` (privacy-flip wipes events/summary/embedding/blob)
- `GET  /api/search?q=...` — hybrid FTS + pgvector cosine, merged with RRF

MCP (mounted at `/mcp/:token`, six tools):

- `search_sessions`, `get_session`, `find_sessions_for_pr`, `get_my_recent_sessions`, `mark_current_session_private`, `mark_current_session_public`

Full details: [`docs/api.md`](docs/api.md).

## Tech stack

- **Runtime**: Bun for install/scripts, Node 22 for the long-running server
- **Server**: Hono, `@hono/node-server`, Drizzle ORM, `postgres`
- **DB**: Postgres 16 with `pgvector` extension (HNSW cosine), Postgres FTS via `to_tsvector`
- **Auth**: argon2id (`@node-rs/argon2`), JWT via `jose` (audiences: `cli`, `web`, `mcp`)
- **MCP**: `@modelcontextprotocol/sdk` Streamable HTTP transport
- **CLI**: `commander`, `chokidar`, `proper-lockfile`, `undici` (tests)
- **Web**: React 18, Vite 6, TanStack Query/Virtual, Tailwind v4, Shiki for code, react-markdown + remark-gfm
- **Build**: Turborepo, TypeScript strict, Biome (lint + format), Vitest, testcontainers for DB-backed tests

## Privacy model

- **Per-repo opt-in**: nothing leaves the box until `claude-sessions enable <path>` runs (REQ-013)
- **Per-session sidecar**: drop a zero-byte `~/.claude-sessions/sessions/<sessionId>.private` to withdraw a session — the watcher PATCHes `is_private: true` next tick, the server hard-deletes events/summary/embedding/blob (REQ-040, sessions-route privacy flip)
- **Defense-in-depth redaction**: the CLI redacts every string leaf before upload, the server redacts again at write time (`packages/server/src/redact.ts`) so a misconfigured client cannot poison the store
- **Owner-only RBAC**: every read/write checks `sessions.user_id = caller`; cross-user reads are 404
- **Audit log**: blob reads, session detail reads, privacy flips, and renames write to `audit_log`

## Why this is a monorepo inside a flat-tools repo

`vibe-tools` is otherwise one folder per single-file tool. This deviates because it has 6 packages with distinct deploy targets (CLI binary, HTTP server, web SPA, shared types, adapter, test config), needs Postgres + pgvector, and ships long-lived processes. Keeping it as a self-contained subdirectory means it brings its own Turborepo, Biome, Vitest, and `bun` workspaces without leaking into the parent's "every script is independent" invariant.

## Layout

```
claude-sessions/
├── docker-compose.yml             # pgvector/pgvector:pg16 on port 5433
├── package.json                   # workspace root
├── turbo.json                     # build/test/typecheck/db:migrate pipelines
├── biome.json                     # formatter + linter
├── tsconfig.base.json             # strict, ES2022, ESNext, Bundler
├── docs/                          # design + reference docs
└── packages/
    ├── core/                      # canonical types, pricing, redaction, repo detection
    ├── adapter-claude/            # JSONL → canonical event stream
    ├── cli/                       # `claude-sessions` binary
    ├── server/                    # Hono + Postgres + pgvector + MCP
    ├── web/                       # React SPA
    └── test-config/               # shared vitest config
```

## More docs

- [`docs/architecture.md`](docs/architecture.md) — components, data flows, schema, decision log
- [`docs/cli.md`](docs/cli.md) — full CLI reference
- [`docs/api.md`](docs/api.md) — REST + MCP API reference
- [`docs/development.md`](docs/development.md) — local dev, testing, package map
- [`../docs/spec/claude-session-finder/`](../docs/spec/claude-session-finder/) — original spec, plan, phase notes

## License

Private — internal vibe-tools.
