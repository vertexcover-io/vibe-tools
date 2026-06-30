# API reference

The server is a single Hono app (`packages/server/src/app.ts`) exposing REST routes under `/api/*`, an MCP transport at `/mcp/:token`, a `GET /health` probe, and a static SPA fallback for everything else.

## Auth

| Audience | Used by | How to obtain |
|---|---|---|
| `cli` | `claude-sessions` CLI (bearer header) | `POST /api/auth/login` returns `{ token }` |
| `web` | Browser SPA (httpOnly cookie `session`) | Same `POST /api/auth/login` sets the cookie |
| `mcp` | Claude Code MCP client (URL path token) | `POST /api/auth/mcp-token` (must be authenticated) |

`requireAuth` (`packages/server/src/auth/middleware.ts`) reads the `Authorization: Bearer ...` header OR the `session` cookie, verifies the JWT, and exposes `c.get("user")` as `{ id, email, role }`. The MCP route requires `aud === "mcp"`; everything else accepts `cli` or `web`.

JWTs are signed with HS256 via `jose`; secret comes from `JWT_SECRET` (8+ chars).

Errors are `401 { error: "unauthorized" }` for missing/invalid tokens.

## REST

### `POST /api/auth/login`

Public.

Request:

```json
{ "email": "you@example.com", "password": "..." }
```

Responses:

- `200 { token, user: { id, email, role } }` — bearer token in body (`aud: cli`); cookie set (`aud: web`, httpOnly, sameSite=Lax, 7d)
- `400 { error }` — invalid request shape
- `401 { error: "invalid email or password" }`

### `GET /api/auth/me`

Auth required. `200 { user }`.

### `POST /api/auth/logout`

Clears the `session` cookie. `200 { ok: true }`.

### `POST /api/auth/mcp-token`

Auth required. Mints a fresh JWT with `aud: "mcp"`. `200 { token }`.

### `GET /api/repos`

Auth required. Lists enabled repos for the calling user.

```json
{
  "repos": [
    {
      "id": "uuid",
      "canonical_url": "github.com/me/proj",
      "display_name": null,
      "access": "owner",
      "session_count": 12,
      "last_activity": "2026-05-09T12:00:00.000Z"
    }
  ]
}
```

### `GET /api/repos/:canonical/sessions`

Auth required. `:canonical` is URL-encoded canonical_url.

Query: `limit` (1–200, default 50).

Returns `{ repo, sessions: [...] }`. Each session includes resolved `display_name` (user `name` → LLM `title` → `Session <prefix>`).

`404 { repo: null, sessions: [] }` if repo unknown; `403 { error: "forbidden" }` if user has no access.

### `POST /api/repos/enable`

Auth required.

Request: `{ canonical_url, local_path? }`. Upserts repo, grants `owner` access.

Response: `{ ok: true, repo: { id, canonical_url } }`.

### `POST /api/repos/disable`

Auth required.

Request: `{ canonical_url, purge?: boolean }`. Revokes access; with `purge: true`, deletes all sessions for this user+repo.

Response: `{ ok, removed, purged_sessions }`.

### `POST /api/ingest`

Auth required. Primary CLI watcher target.

Request:

```json
{
  "session": {
    "id": "uuid",
    "agent": "claude-code",
    "agent_version": "1.0.0",
    "repo": { "canonical_url": "github.com/me/proj", "branch": null },
    "source_cwd_hint": "/Users/me/proj",
    "started_at": "2026-05-09T12:00:00.000Z",
    "ended_at": "2026-05-09T12:30:00.000Z",
    "model": "claude-sonnet-4",
    "permission_mode": null,
    "total_input_tokens": 1234,
    "total_output_tokens": 5678,
    "total_cost_usd": 0.12
  },
  "events": [
    {
      "event_uuid": "...",
      "parent_uuid": null,
      "ts": "2026-05-09T12:00:01.000Z",
      "type": "user_msg",
      "payload": { "text": "..." }
    }
  ]
}
```

Behavior:

- Max 500 events per call (server-side zod cap)
- `redactDeep` runs on every event payload
- `sessions` row is upserted (last-write-wins on metadata)
- `events` rows are bulk-inserted with `ON CONFLICT (session_id, event_uuid) DO NOTHING` — natural dedup keyed by event UUID

Response:

```json
{ "ok": true, "session_id": "...", "accepted_events": 7, "skipped_duplicates": 3 }
```

Errors: `400` (zod), `403 { error: "repo not enabled for user" }`.

### `GET /api/sessions`

Auth required. Recent sessions across all enabled repos.

Query: `limit` (1–100, default 20), `repo`, `branch`, `agent`.

Response: `{ sessions: [...] }` with `display_name` resolution.

### `GET /api/sessions/:id`

Auth required. Owner-only RBAC.

Returns full session metadata + summary + `display_name`. If `is_private`, returns only `{ id, is_private: true, display_name: "(private)" }`.

Writes an `audit_log` row with action `read_session`.

### `GET /api/sessions/:id/events`

Auth required. Owner-only.

Returns `{ events: [...] }` in chronological order. Empty array for private sessions (after they've been wiped).

### `POST /api/sessions/:id/summary`

Auth required. CLI summarizer target.

Request:

```json
{
  "session_id": "must match :id",
  "title": "Auth bug fix",
  "summary": "...",
  "tags": ["auth", "bug"],
  "files_touched": ["src/auth.ts"],
  "prs_referenced": ["https://github.com/me/proj/pull/42"],
  "tool_call_counts": { "Read": 5, "Edit": 2 },
  "generated_at": "2026-05-09T12:30:00.000Z",
  "model": "sonnet",
  "status": "ok",
  "error": null
}
```

Behavior (REQ-038):

- `redactDeep(title)` and `redactDeep(summary)` before insert
- Embedding generated inline by the configured `EMBED_PROVIDER`
- Single transaction upserts both `summaries` and `embeddings` rows; route returns 200 only after both commit

Response: `{ ok: true, embedded: <bool> }`. `embedded: false` when `status !== "ok"`.

### `PUT /api/sessions/:id/blob`

Auth required. Body: raw NDJSON bytes (`application/x-ndjson`).

Cap: 100MB (REQ-061). Larger payloads → `413 { error: "blob too large" }`.

Side effects: stores the bytes in `session_blobs`, sets `sessions.has_blob = true`.

### `GET /api/sessions/:id/blob`

Auth required. Owner-only. Writes `audit_log` row with action `read_blob`.

Returns `application/x-ndjson` body byte-for-byte (REQ-062).

### `PATCH /api/sessions/:id`

Auth required. Owner-only.

Request: `{ name?: string | null, is_private?: boolean }` (at least one field required).

Behavior:

- `name`: stored in `sessions.name`, audit `renamed`
- `is_private: true`: hard-deletes `events`, `summaries`, `embeddings`, `session_blobs` rows; sets `sessions.is_private = true`, `has_blob = false`; audit `marked_private`
- `is_private: false`: flips the flag back; audit `marked_public` (no events come back — they're gone)

Response: `{ ok: true }`.

### `GET /api/search`

Auth required.

Query:

| Param | Type | Notes |
|---|---|---|
| `q` | string (required, min 1) | |
| `repo` | canonical_url | filter |
| `branch` | string | filter |
| `agent` | string | filter |
| `has_pr` | boolean | post-hoc filter on `summaries.prs_referenced` |
| `since` | ISO datetime | `started_at >= since` |
| `limit` | int 1–50, default 20 | |

Algorithm (`packages/server/src/lib/search-internal.ts`):

1. Embed `q` via `EMBED_PROVIDER` → 1536-dim vector
2. Resolve user's accessible `repo_id` set
3. FTS top-50: `ts_rank(summaries_fts_text(title, summary, tags), plainto_tsquery('english', q))`
4. Vector top-50: `ORDER BY embedding <=> <qvec> ASC` (cosine)
5. Reciprocal Rank Fusion (`k = 60`) merges the two lists
6. Hydrate top-N with summaries + repo metadata
7. Apply `has_pr` post-hoc

Response:

```json
{
  "results": [
    {
      "session_id": "...",
      "title": "...",
      "summary": "...",
      "tags": ["..."],
      "repo": "github.com/me/proj",
      "branch": null,
      "agent": "claude-code",
      "started_at": "...",
      "ended_at": "...",
      "total_cost_usd": "0.12"
    }
  ],
  "strategy": "rrf"
}
```

### `GET /health`

Public. `200 { status: "ok" }`.

## MCP

Mount: `/mcp/:token`. Token is an MCP-scoped JWT (see `POST /api/auth/mcp-token`). Transport: `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, with `enableJsonResponse: true` and no session ID.

Each request builds a fresh `McpServer` instance bound to the calling user's id. Six tools (`packages/server/src/routes/mcp.ts`):

### `search_sessions`

```json
{ "query": "auth bug", "limit": 10 }
```

Hybrid FTS + vector search via `searchInternal`. Returns the same shape as the REST `/api/search` response, JSON-stringified inside an MCP `text` content block.

### `get_session`

```json
{ "session_id": "..." }
```

Owner OR cross-user repo access (the MCP variant uses `ensureRowAccess` which lets a user read sessions in repos they have access to, even if they don't own them). Writes an `audit_log` row.

### `find_sessions_for_pr`

```json
{ "pr_url": "https://github.com/me/proj/pull/42" }
```

Returns all sessions whose `summaries.prs_referenced` array contains the given URL.

### `get_my_recent_sessions`

```json
{ "limit": 10, "agent": "claude-code", "repo": "github.com/me/proj" }
```

Returns up to 50 most-recent sessions for the user.

### `mark_current_session_private`

```json
{ "session_id": "..." }
```

Owner-only. Equivalent to `PATCH /api/sessions/:id { is_private: true }` but written into the MCP control-plane so the model can pull a session out of the index.

### `mark_current_session_public`

Inverse of the above.

## Error shape

All routes return JSON bodies on error:

```json
{ "error": "<message>" }
```

zod validation errors return the flattened error object: `{ "error": { "fieldErrors": {...}, "formErrors": [...] } }`.

`onError` in `app.ts` catches uncaught throws and returns `500 { error: "internal_error" }`.
