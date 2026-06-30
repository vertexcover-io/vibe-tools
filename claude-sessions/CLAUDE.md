# claude-sessions — Project Instructions for Claude Code

A Turborepo monorepo (6 packages) inside the flat `vibe-tools` repo. Captures Claude Code session JSONLs, summarizes them, and serves a web UI + MCP server for search.

Read this first; it encodes invariants the codebase relies on.

## Packages

- `@claude-sessions/core` — canonical types, pricing, redaction, repo-detect. **All shared types live here.**
- `@claude-sessions/adapter-claude` — Claude Code JSONL → `CanonicalEvent` adapter, with byteOffset resume.
- `@claude-sessions/cli` — `claude-sessions` binary: login, enable, disable, status, watch, sync, find, open, mcp, fork, name. Owns redaction, summarization, upload, retry.
- `@claude-sessions/server` — Hono + Postgres (pgvector) + Drizzle. Auth, ingest, search, MCP, blob, audit. Hosts the SPA static assets at `/`.
- `@claude-sessions/web` — Vite + React 18 + Tailwind v4 SPA.
- `@claude-sessions/test-config` — shared vitest config.

## Architectural Invariants

These are load-bearing. Don't change them without understanding why.

### Canonical types live in `core`

`CanonicalEvent`, `CanonicalSession`, `SessionSummary`, `InterventionEvent`, `RepoIdentity` are all in `packages/core/src/types.ts` (and `repo-detect.ts`). **Never duplicate these in another package.** Import:

```ts
import type { CanonicalEvent, SessionSummary } from "@claude-sessions/core";
```

If you need a util in two packages, move it to `core` and re-export. That's how `canonicalizeRepo` ended up in `core/repo-detect.ts` after phase 3.

### Summarization runs in the CLI, not the server

The CLI invokes `claude -p` with the structured-output schema, mines PRs deterministically (regex over messages + `gh pr list` fallback), merges, and uploads via `POST /api/sessions/:id/summary`. The server never calls `claude` — it has no Anthropic credentials and shouldn't.

If you're tempted to add `claude -p` to the server, stop and put it in `cli/src/summarizer/`.

### Redaction is canonical at the CLI; server is defense in depth

`packages/core/src/redact.ts` is THE redaction implementation (regex patterns + Shannon-entropy heuristic, idempotent). The CLI runs it on every event before upload. The server runs `redactDeep` (which wraps `core.redact`) on ingest payloads as a safety net for misbehaving or legacy clients.

`redact(redact(x)) === redact(x)` — keep this property. The replacement token `[REDACTED:kind]` is non-matching against any pattern.

**Env-line redact wins over more specific patterns** (e.g. an OpenAI-key regex). When `OPENAI_KEY=sk-...` appears, the env-line regex captures the whole line including the value. This is intentional defense-in-depth — don't "fix" it.

### Embedding provider is pluggable

`EMBED_PROVIDER` env var selects the strategy (in `packages/server/src/embed/index.ts`):

- `openai` (default): `text-embedding-3-small` via raw fetch (no SDK)
- `bge`: stub, throws "not implemented in v0"
- `fake`: deterministic SHA256-derived L2-normalized 1536-vector — used by tests so CI doesn't need an OpenAI key
- `none`: skip embedding entirely

When adding a new provider, keep the 1536-dim contract — the `summaries.embedding` column is `vector(1536)`.

### pgvector embedding is generated inline on summary upload (no worker)

`POST /api/sessions/:id/summary` runs the embedding call and inserts into `summaries.embedding` in the same transaction. Search is immediately consistent. **Don't introduce a queue or worker without a real reason** — v0 traffic is single-user and the CLI is already async.

### `event_uuid` is the dedupe key

Server upserts ingest events on `event_uuid`. Idempotent re-uploads depend on this. EDGE-002 (inode replacement) and the retry/backoff loop both rely on it. Any new ingest path must preserve uniqueness per (session, line).

### JWT `aud` claim distinguishes token types

- `aud=api` — normal session token (login)
- `aud=mcp` — MCP server token (issued by `POST /api/auth/mcp-token`)

Middleware checks `aud` per route. Don't collapse the two.

### TIMESTAMPTZ everywhere

All timestamp columns are `timestamp with time zone`. ISO strings on the wire end in `Z`. Drizzle returns `Date`; raw `postgres-js` template literals return strings (use the query builder for `Z`-suffix assertions).

## Test Patterns

- **Server integration tests use `testcontainers`** with `pgvector/pgvector:pg16`. Don't migrate to pg-mem / sqlite — pgvector, FTS, and IMMUTABLE-indexed expressions don't survive the substitution.
- **`execFile`-based subprocesses (claude, gh) are mocked via `vi.mock("node:child_process")`**. Don't add a heavyweight mock library — `vi.mock` + a typed `execFile` factory is enough. See `packages/cli/src/summarizer/claude-runner.test.ts`.
- **CLI integration tests use an in-process HTTP mock server** — see `packages/cli/tests/helpers/mock-server.ts`. Avoids spinning up the real Hono server for CLI-side flows.
- **Web tests use jsdom**. `tanstack-virtual` returns 0-height scroll containers under jsdom — flat-render below 50 events, virtualize above (already wired in `TranscriptList`).
- **Use real Postgres for any FTS/vector/IMMUTABLE-index assertion**. Mocks lie about Postgres semantics.

## Tooling

- **Bun** for install + script running. Workspace root: `claude-sessions/`. Run `bun install` from there.
- **Turbo** for task orchestration (`bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`).
- **Biome** for lint + format. `biome check .` from the workspace root.
- **TypeScript strict** + `verbatimModuleSyntax: true`. Always use `import type` for types.
- **Drizzle** ORM + raw SQL migrations in `packages/server/src/db/migrations/`. Both kept in sync by hand.
- **Docker compose** at `claude-sessions/docker-compose.yml` runs Postgres on `:5433` for local dev.

## Common Gotchas

- **Postgres FTS index needs an IMMUTABLE wrapper function** (`summaries_fts_text(...)`). Naive `to_tsvector('english', coalesce(...))` fails because `coalesce` over `regconfig` is STABLE.
- **MCP SDK SSE transport is deprecated** (1.29.0+). Use `WebStandardStreamableHTTPServerTransport` (stateless, `enableJsonResponse: true`) — Hono-compatible.
- **chokidar v4 has named exports only**: `import { watch as chokidarWatch, type FSWatcher } from "chokidar"`.
- **Biome `useLiteralKeys` vs TS `noUncheckedIndexedAccess`** — use dot access on `process.env.X`. Still narrows to `string | undefined`.
- **`bytea` returns as Node `Buffer`** — copy into a fresh `Uint8Array` for `new Response(...)` byte-equality.
- **4xx is non-retryable** in the CLI uploader — auth/RBAC failures don't burn the backoff schedule. See `cli/src/upload/retry.ts` and its `shouldRetry` predicate.
- **Inode replacement (EDGE-002)**: when the persisted offset > new file size, reset offset to 0; server dedupe by `event_uuid` keeps it idempotent.
- **`db.query.<table>.findFirst` requires `relations(...)` declarations**. We chose plain `db.select().from().where().limit(1)` to keep the schema relation-free. Don't add relations unless you really need them.
- **Turbo doesn't pass env vars to tasks by default**. Add to `turbo.json`'s `env: [...]` passthrough list (e.g. `DATABASE_URL`, `JWT_SECRET`, `EMBED_PROVIDER`).
- **rehype-shiki fails to compile under Node 25** (oniguruma native build). Currently no inline syntax highlighting in markdown. To re-add: `@shikijs/rehype` with a working Node pin.

## Where to Find Things

- Canonical types: `packages/core/src/types.ts`
- Redaction: `packages/core/src/redact.ts`
- Pricing: `packages/core/src/pricing.ts`
- Repo identity / git detection: `packages/core/src/repo-detect.ts`
- Adapter (Claude JSONL): `packages/adapter-claude/src/{index,stream}.ts`
- Server entry: `packages/server/src/main.ts` → `app.ts` (router composition)
- Server schema (SQL): `packages/server/src/db/migrations/0001_init.sql`
- Server schema (Drizzle): `packages/server/src/db/schema.ts`
- Embedding providers: `packages/server/src/embed/{index,openai,bge,fake}.ts`
- Search (RRF + FTS + vector): `packages/server/src/lib/search-internal.ts`
- MCP server (6 tools): `packages/server/src/routes/mcp.ts`
- CLI entry: `packages/cli/src/main.ts`
- CLI commands: `packages/cli/src/commands/`
- CLI watcher + uploader: `packages/cli/src/watcher/` and `packages/cli/src/upload/`
- CLI summarizer: `packages/cli/src/summarizer/`
- Web SPA pages: `packages/web/src/pages/`
- Web transcript components: `packages/web/src/components/transcript/`

## Style

- TypeScript strict; type all functions.
- Prefer small, focused functions; early returns over nested conditionals.
- No needless comments / docstrings.
- No emojis in code or commit messages unless the user asks.
- Commit conventions: per-tool addition uses `add <tool-name>: <one-line>`, but inside this monorepo prefer conventional `feat:` / `fix:` / `refactor:` prefixes.
