# Phase 2: Server core (Hono + Postgres + auth + ingest)

> **Status:** pending
> **Depends on:** Phase 0
> **Traces to:** REQ-030, REQ-031, REQ-032, REQ-033, REQ-034, REQ-035, REQ-041, REQ-048, REQ-049, REQ-063

## Overview

Stand up the server: Hono + Postgres (with pgvector) + Drizzle + auth + the `/api/ingest` endpoint with dedupe, RBAC, redaction-at-rest. Single process, no worker, no Redis. After this phase: `docker compose up` starts Postgres; `npm run dev` starts the server; `curl -X POST /api/auth/login` works; `curl -X POST /api/ingest` with a token stores events.

## Files

```
packages/server/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── main.ts                       # Hono entry
│   ├── env.ts                        # Zod-validated env vars
│   ├── auth/
│   │   ├── argon.ts                  # password hashing
│   │   ├── jwt.ts                    # token sign/verify
│   │   └── middleware.ts             # bearer token + cookie
│   ├── db/
│   │   ├── client.ts                 # postgres-js + drizzle
│   │   ├── schema.ts                 # all tables
│   │   ├── repos.ts                  # canonicalize + upsert helpers
│   │   └── migrations/
│   │       └── 0001_init.sql
│   ├── routes/
│   │   ├── auth.ts                   # /api/auth/login, /api/auth/me
│   │   ├── ingest.ts                 # /api/ingest
│   │   └── health.ts                 # /health (no auth)
│   ├── redact.ts                     # re-export from core
│   └── lib/
│       └── canonicalize-repo.ts      # re-export from core
├── tests/
│   ├── auth.test.ts
│   ├── ingest.test.ts
│   └── helpers/
│       ├── pg-test-container.ts
│       └── seed.ts
docker-compose.yml                    # postgres:16 + pgvector ext
.env.example                          # DATABASE_URL, JWT_SECRET, EMBED_PROVIDER, OPENAI_API_KEY
```

## Schema

```sql
-- 0001_init.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',          -- 'user' | 'admin'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url  TEXT UNIQUE NOT NULL,                 -- "github.com/foo/bar"
  display_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_repos (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id    UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  access     TEXT NOT NULL,                            -- 'owner' | 'read'
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id              UUID REFERENCES repos(id),
  agent                TEXT NOT NULL,
  agent_version        TEXT NOT NULL,
  branch               TEXT,
  source_cwd_hint      TEXT NOT NULL,
  model                TEXT,
  started_at           TIMESTAMPTZ NOT NULL,
  ended_at             TIMESTAMPTZ NOT NULL,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
  permission_mode      TEXT,
  is_private           BOOLEAN NOT NULL DEFAULT false,
  name                 TEXT,
  has_blob             BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user_repo ON sessions(user_id, repo_id);
CREATE INDEX idx_sessions_repo_branch ON sessions(repo_id, branch);
CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);

CREATE TABLE events (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_uuid   TEXT NOT NULL,
  parent_uuid  TEXT,
  ts           TIMESTAMPTZ NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  PRIMARY KEY (session_id, event_uuid)
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);

CREATE TABLE summaries (
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  title             TEXT,
  summary           TEXT,
  tags              TEXT[] NOT NULL DEFAULT '{}',
  files_touched     TEXT[] NOT NULL DEFAULT '{}',
  prs_referenced    TEXT[] NOT NULL DEFAULT '{}',
  tool_call_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at      TIMESTAMPTZ,
  model             TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  error             TEXT
);
-- FTS index on title + summary + tags joined for /api/search later (phase 5)
CREATE INDEX idx_summaries_fts ON summaries USING gin (
  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || array_to_string(tags, ' '))
);

CREATE TABLE embeddings (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  embedding       vector(1536) NOT NULL,
  embedding_model TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_embeddings_cosine ON embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE session_blobs (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  jsonl_bytes   BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_pr_links (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pr_url        TEXT NOT NULL,
  source        TEXT NOT NULL,                        -- 'mined' | 'fallback' | 'manual'
  validated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, pr_url)
);

CREATE TABLE audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id       UUID REFERENCES users(id),
  action              TEXT NOT NULL,
  target_session_id   TEXT,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail              JSONB
);
CREATE INDEX idx_audit_actor_ts ON audit_log(actor_user_id, ts DESC);
```

## Auth

- Password hashing: `@node-rs/argon2` with a sane default (memory: 19 MiB, time: 2, parallelism: 1)
- JWT: HS256, 7-day expiry, audience `web` for cookie tokens, audience `cli`/`mcp` for bearer tokens
- Cookie: `httpOnly, Secure, SameSite=Lax, Path=/`
- CLI/bearer: `Authorization: Bearer <jwt>`

```ts
// auth/middleware.ts
import { createMiddleware } from "hono/factory";
import { verify } from "./jwt.js";

export const requireAuth = createMiddleware(async (c, next) => {
  const cookie = getCookie(c, "session");
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
  const token = cookie ?? bearer;
  if (!token) return c.text("unauthorized", 401);
  try {
    const payload = await verify(token);
    c.set("user", { id: payload.sub, email: payload.email, role: payload.role });
    await next();
  } catch {
    return c.text("unauthorized", 401);
  }
});
```

Endpoints:
- `POST /api/auth/login` — body `{ email, password }`, returns `{ token, user }` and sets cookie
- `GET /api/auth/me` — returns the current user
- `POST /api/auth/logout` — clears cookie
- `GET /health` — no auth

## /api/ingest

Body schema (Zod):
```ts
const IngestBody = z.object({
  session: z.object({
    id: z.string(),
    agent: z.literal("claude-code"),  // v0
    agent_version: z.string(),
    repo: z.object({ canonical_url: z.string(), branch: z.string().nullable() }),
    source_cwd_hint: z.string(),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime(),
    model: z.string().nullable(),
    permission_mode: z.string().nullable(),
    total_input_tokens: z.number().int().nonnegative(),
    total_output_tokens: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
  }),
  events: z.array(z.object({
    event_uuid: z.string(),
    parent_uuid: z.string().nullable(),
    ts: z.string().datetime(),
    type: z.enum(["user_msg", "assistant_msg", "tool_use", "summary", "system"]),
    payload: z.unknown(),
  })).max(500),
});
```

Handler logic:
1. **Auth check** (middleware).
2. **RBAC** (REQ-035): look up `user_repos` by `(user_id, repo)`; if absent or `is_repo_enabled = false` for the user → 403 with `repo not enabled for user`. Special case: if `user_repos` doesn't exist yet, the CLI must have called `/api/repos/enable` first; reject with 403.
3. **Redaction at rest** (REQ-034): for each event, recursively walk `payload` strings, apply `redact()`. Also redact `summary` field in any aggregate. Even though CLI redacts before upload, server re-runs as defense in depth.
4. **Upsert session** with `ON CONFLICT (id) DO UPDATE`. `session.id` is the source-truth ID.
5. **Insert events** with `ON CONFLICT (session_id, event_uuid) DO NOTHING` (idempotency, REQ-033).
6. Return `{ ok: true, session_id, accepted_events: <count>, skipped_duplicates: <count> }`.

```ts
// routes/ingest.ts (sketch)
ingestRouter.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await IngestBody.parseAsync(await c.req.json());

  const repo = await upsertRepo(body.session.repo.canonical_url);
  const access = await db.query.userRepos.findFirst({
    where: and(eq(userRepos.userId, user.id), eq(userRepos.repoId, repo.id))
  });
  if (!access) return c.json({ error: "repo not enabled for user" }, 403);

  // Redact in place
  for (const ev of body.events) ev.payload = redactDeep(ev.payload);

  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: body.session.id,
      userId: user.id,
      repoId: repo.id,
      agent: body.session.agent,
      agentVersion: body.session.agent_version,
      branch: body.session.repo.branch,
      sourceCwdHint: body.session.source_cwd_hint,
      startedAt: body.session.started_at,
      endedAt: body.session.ended_at,
      model: body.session.model,
      permissionMode: body.session.permission_mode,
      totalInputTokens: body.session.total_input_tokens,
      totalOutputTokens: body.session.total_output_tokens,
      totalCostUsd: body.session.total_cost_usd,
    }).onConflictDoUpdate({
      target: sessions.id,
      set: { /* updatable fields */ updatedAt: sql`now()` },
    });

    if (body.events.length > 0) {
      await tx.insert(events).values(body.events.map(e => ({
        sessionId: body.session.id,
        eventUuid: e.event_uuid,
        parentUuid: e.parent_uuid,
        ts: e.ts,
        type: e.type,
        payload: e.payload,
      }))).onConflictDoNothing();
    }
  });

  return c.json({ ok: true, session_id: body.session.id, accepted_events: body.events.length });
});
```

## Repo enable/disable endpoints (lightweight; CLI uses these in phase 3)

- `POST /api/repos/enable` — body `{ canonical_url, local_path? }` → upserts repo + user_repos with `access='owner'`
- `POST /api/repos/disable` — body `{ canonical_url, purge?: boolean }` → removes user_repos row; if `purge`, deletes all sessions/events/blobs for that repo for that user

## Tests

- **REQ-030/031**: login with valid + invalid creds; cookie set/not set
- **REQ-032**: any other route without token → 401
- **REQ-033**: POST same batch twice; events table count is original (idempotent)
- **REQ-034**: post event whose payload contains `AKIA...`; DB row's payload contains `[REDACTED:...]`
- **REQ-035**: POST ingest for a repo the user hasn't enabled → 403
- **REQ-041**: User A cannot read user B's session via API → 403
- **REQ-048**: canonicalization via core lib (already tested in phase 0/1 but smoke-test in server)
- **REQ-049**: all created_at columns are TIMESTAMPTZ; API responses have ISO Z
- **REQ-063**: only one Node process; no Redis container in compose

## Done When

- [ ] `docker compose up postgres` boots Postgres + pgvector
- [ ] `npm run db:migrate` applies the schema
- [ ] `npm run dev` starts the server
- [ ] All listed tests pass against a `testcontainers` Postgres
- [ ] `tsc --noEmit` passes

## Commit

`feat(server): Hono + Postgres + auth + /api/ingest (phase 2)`
