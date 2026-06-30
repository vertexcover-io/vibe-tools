# claude-sessions: Build Learnings

Captured at the close of the 8-phase pipeline build (phase 0 → phase 7 + quality gate). 194 tests across 6 packages green, type/lint/build clean. This document focuses on friction signals and gotchas that were not obvious from the spec or phase docs.

## Pipeline Friction (Multi-Phase Orchestration)

### What worked

- **Canonical types in `@claude-sessions/core` from phase 0**: every later phase (adapter, server, cli, web) imported `CanonicalEvent`/`CanonicalSession`/`SessionSummary` instead of redeclaring. No drift, no duplicate validation logic. The discriminated union keeps narrowing free at every consumer.
- **Pricing helper in core from day one**: family-fallback (`claude-opus-4-7-20250514` → `claude-opus-4-7` → `opus` family) meant phase 1's adapter and phase 4's summarizer both costed sessions consistently with one source of truth.
- **Move-up refactor on demand**: phase 3 needed `canonicalizeRepo` on the CLI side; instead of duplicating, it was relocated `server/src/lib → core/src/repo-detect` and re-exported. This is the right pattern for a monorepo — push a util to `core` the moment a second package needs it.
- **Concurrent phases 5 + 7 merged cleanly**: both edited `cli/src/main.ts` to append commander subcommands. Append-only edits at well-known extension points (registering commands, mounting routers) don't conflict.
- **`@claude-sessions/test-config` shared vitest config**: 6 packages, one tsconfig.base.json + one vitest base. New packages light up green without bespoke config.
- **Real Postgres via testcontainers, not pg-mem or sqlite**: pgvector + FTS + TIMESTAMPTZ semantics behave differently in mocks. Phase 2 caught the IMMUTABLE-index bug because it was running real Postgres. Slow tests, but truthful tests.

### What hurt

- **Phase docs went stale faster than expected**: phase 5's prescribed `SSEServerTransport` was already deprecated in MCP SDK 1.29.0 — caught only at integration time. Lesson: when a phase doc names a specific SDK class, sanity-check the SDK's current export before implementing.
- **Schema-first migrations + parallel Drizzle definition** is duplicate work: every column lives in `0001_init.sql` AND in `db/schema.ts`. Worth it for raw SQL escape hatches (FTS index expression, IMMUTABLE function), but accept the bookkeeping cost.
- **`db.query.<table>.findFirst` requires explicit `relations(...)` declarations**: phase 4 hit this and chose to stay on `db.select().from().where().limit(1)` rather than touch the schema. Trade-off: query-builder ergonomics on one side, schema cleanliness on the other. We picked the latter.
- **Turbo doesn't pass env vars to tasks by default**: phase 2 had to add an `env: ["DATABASE_URL", "JWT_SECRET", ...]` passthrough list to `turbo.json` for `db:migrate` and `test`. Easy to forget; expect it for any task that needs `process.env`.
- **Web build pinning vs Vitest's bundled Vite**: Vitest bundles its own pinned Vite. With our pinned `vite@6` and `@vitejs/plugin-react`, the `Plugin<any>` type didn't unify. One `biome-ignore` cast in `vitest.config.ts` papers it over. Watch for this any time Vitest and Vite versions disagree.

## Per-Package Gotchas

### `@claude-sessions/core`

- **Redaction precedence: env-line beats key-specific**. The line-anchored env regex (`^[A-Z_]+=...$`) intentionally captures the entire RHS — including `sk-...` — before the OpenAI-key regex gets a chance. This is defense-in-depth: we'd rather over-redact a `KEY=value` line than leak the value because the key regex didn't recognize a new format. Tests must use a non-line-start fixture (`auth: sk-...`) to exercise the OpenAI-key path.
- **Idempotent redaction**: `redact(redact(x)) === redact(x)`. The replacement token `[REDACTED:kind]` is itself non-matching against any pattern. Don't break this — server defense-in-depth re-runs `redact` on already-redacted CLI payloads.

### `@claude-sessions/adapter-claude`

- **`ended_at` from raw lines, not canonical events**. The raw stream's last entry is often a tool_result that gets folded into a tool_use during pairing — so the canonical stream is shorter. Source first/last timestamps from `rawLines[]` so session bounds remain correct after pairing.
- **Tool-use ↔ tool-result pairing reduces event count**. 8 raw lines → 7 canonical events for the standard fixture. Don't assert equal lengths.
- **EDGE-001 (parse_error)**: a malformed line emits a `parse_error` canonical event and continues. We never drop a session because of one bad line.

### `@claude-sessions/cli`

- **chokidar v4 has named exports only**: `import { watch as chokidarWatch, type FSWatcher } from "chokidar"`. No default export. v3 patterns don't apply.
- **Biome `useLiteralKeys` vs TS `noUncheckedIndexedAccess`** clash on `process.env["X"]`. Biome wants dot access; TS still narrows `process.env.X` to `string | undefined`. Use dot access — the strict-mode safety isn't lost.
- **4xx is non-retryable**. The retry/backoff schedule has a `shouldRetry` predicate; auth (401) and RBAC (403) fail fast instead of burning all 3 attempts. Otherwise a misconfigured token wastes the entire backoff window per session.
- **Inode replacement (EDGE-002)**: when a watched JSONL is rotated or replaced, persisted `byte_offset` may exceed new file size. Detect and reset to 0 — re-emit all events. Server-side dedupe by `event_uuid` keeps the upstream idempotent.
- **Atomic config writes**: every JSON file under `~/.claude-sessions/` uses `proper-lockfile` + temp-file-then-rename. Two `claude-sessions watch` processes on the same machine won't corrupt state.
- **Summarization runs in CLI, not server**. The CLI invokes `claude -p` with the schema, mines PRs deterministically (regex + `gh pr list` fallback), then uploads the merged summary. Keeps the server stateless and avoids putting Anthropic creds in the server.
- **`execFile`-based tools (claude, gh)** are mocked via `vi.mock("node:child_process")` in tests. Don't introduce a heavyweight mock library — `vi.mock` + a typed `execFile` factory is enough.

### `@claude-sessions/server`

- **Postgres FTS index needs an IMMUTABLE wrapper function**. The naive form fails:
  ```sql
  -- FAILS: functions in index expression must be marked IMMUTABLE
  create index idx_summaries_fts on summaries
    using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || array_to_string(tags, ' ')));
  ```
  `to_tsvector(regconfig, text)` is STABLE, not IMMUTABLE, and `coalesce(...)` over `regconfig` taints the expression. Fix: declare a SQL function and index on it:
  ```sql
  create function summaries_fts_text(title text, summary text, tags text[])
    returns text language sql immutable as $$
      select coalesce($1,'') || ' ' || coalesce($2,'') || ' ' || array_to_string(coalesce($3, '{}'), ' ')
    $$;
  create index idx_summaries_fts on summaries
    using gin (to_tsvector('english', summaries_fts_text(title, summary, tags)));
  ```
- **`postgres-js` returns TIMESTAMPTZ as strings via raw template-literal queries**, not `Date`. The Drizzle query builder gives you `Date`. For tests that assert ISO `Z`-suffix, use the query builder; reserve raw SQL for schema-level checks.
- **`bytea` round-trips as a Node `Buffer`**, not `Uint8Array`. For `new Response(bufferFromPg)` byte-for-byte equality, copy into a fresh `Uint8Array` first. Otherwise Hono test handlers get confused by the Buffer's view semantics.
- **MCP SDK SSE transport is deprecated (1.29.0+)**. Use `WebStandardStreamableHTTPServerTransport` (stateless, `enableJsonResponse: true`). It's the official replacement and lands cleanly on Hono v4 + `app.request()`. The MCP client SDK's `StreamableHTTPClientTransport` is the matching counterpart for tests.
- **`db.query.<table>.findFirst` requires `relations(...)` declarations** in `schema.ts`. To keep the schema relation-free, use `db.select().from(...).where(...).limit(1)`. The trade-off is acceptable for v0; revisit when relation traversal would meaningfully simplify code.
- **Embedding provider is pluggable via `EMBED_PROVIDER` env**: `openai` (default; text-embedding-3-small via raw fetch — no SDK), `bge` (placeholder, throws), `fake` (deterministic SHA256-derived L2-normalized 1536-vector for tests, no API key). Tests use `fake`; CI doesn't need an OpenAI key.
- **Embedding is generated inline on `POST /api/sessions/:id/summary`**, not a worker. Search becomes immediately consistent. Acceptable because v0 traffic is single-user and summarization is already async on the CLI side.
- **Hybrid search uses Reciprocal Rank Fusion (k=60)** over FTS rank + pgvector cosine. RBAC-scoped at the SQL level via a `userId IN (...)` clause; do not push it down to a post-filter — leaks count and pagination would diverge.
- **`has_pr` filter is post-hoc in JS**, applied after RRF top-N hydration. The fast path stays SQL-only; only the small filter case pays the JS cost.
- **JWT `aud` claim distinguishes tokens**: `aud=api` for normal sessions, `aud=mcp` for MCP-server tokens (issued by `POST /api/auth/mcp-token`). Middleware checks `aud` per route.
- **Defense-in-depth redaction at the server**: phase 2 wraps `core.redact` in `redactDeep` for ingest payloads. CLI is the canonical redactor; server is a safety net for misbehaving / legacy clients.

### `@claude-sessions/web`

- **rehype-shiki broken under Node 25 + macOS clang**. The transitive `oniguruma` native build fails. Phase 6 dropped inline syntax highlighting; markdown still renders correctly. To re-add later, use `@shikijs/rehype` and pin a Node version that has prebuilt oniguruma binaries.
- **Tanstack-virtual + jsdom**: jsdom returns 0-height scroll containers, so virtualization renders zero items in tests. Phase 6's fix: render flat below 50 events, virtualize above. Bonus: short transcripts get faster TTI.
- **Vitest+plugin-react Plugin<any> mismatch under Vite 6**: one `biome-ignore` cast in `vitest.config.ts`. Will resolve when Vitest republishes against Vite 6 stable.

## Future Improvements (Deferred)

These were intentionally cut from v0 but are real and worth doing:

- **Daemon mode for the CLI**. Today `claude-sessions watch` is a foreground process. A long-running daemon (launchd / systemd) with `claude-sessions daemon start|status|stop` would survive shell exits.
- **Multi-user invite UI**. Server has the data model; web has only login. Add invite tokens + `/admin/users` to the web UI.
- **Cursor adapter**. The architecture is adapter-shaped (`@claude-sessions/adapter-claude`). A `@claude-sessions/adapter-cursor` would slot in next to it; CLI discovery would gain a `~/.cursor/...` path.
- **Intervention mining**. The `InterventionEvent` type exists in `core/types.ts` but is unused. v0 doesn't extract "user corrected the agent here" moments. Worth doing once we have enough sessions to train a heuristic.
- **GitHub OAuth for login**. Today auth is email/password (argon2 + JWT). GitHub OAuth would remove the password store entirely and gate access to repos by GH org membership.
- **Re-add `@shikijs/rehype` for code-block highlighting** in transcripts, with a Node version pin that has working oniguruma prebuilds.
- **pgvector index tuning**. v0 uses brute-force ANN; on > 100k summaries an `ivfflat` or `hnsw` index becomes worth the build time.
- **Streaming summary endpoint**. Today summaries are POSTed whole. For long sessions, an SSE/streaming summary writer would let the web UI render partial summaries.
- **Export / archive**. No CLI command for "give me everything I uploaded". Add `claude-sessions export <repo> --out=...` that walks the API.

## Architectural Invariants (Don't Break These)

- **Types are owned by `@claude-sessions/core`**. If you find yourself declaring `CanonicalEvent` or `SessionSummary` in any other package, stop and import.
- **Redaction is canonical at the CLI**. The CLI's `redact()` is what protects user data on the wire. The server runs `redactDeep` only as defense-in-depth.
- **Summarization runs in the CLI**. The server never calls `claude -p`. Keeps Anthropic creds local.
- **Embedding generation runs inline at upload time**. No worker, no queue. If this changes, the `POST /sessions/:id/summary` transaction needs to drop the embedding insert.
- **`event_uuid` is the dedupe key**. Any new ingest path must keep it unique per (session, line) — server upserts on it. Idempotent re-uploads depend on this.
- **JWT `aud` claim is load-bearing**. `aud=api` vs `aud=mcp` — never collapse them or MCP tokens become full session tokens.
- **TIMESTAMPTZ everywhere**. No naive timestamps. ISO strings on the wire end in `Z`.
- **Real Postgres in tests**. Don't migrate to pg-mem / sqlite — pgvector + FTS + IMMUTABLE indexes don't survive the substitution.
