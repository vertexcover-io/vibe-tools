# Development

## Prerequisites

- Bun 1.2+
- Docker (or Podman) for the Postgres container
- Node 22+ in PATH (`tsx` and the running server use it)
- An OpenAI API key if you want real embeddings (otherwise `EMBED_PROVIDER=fake`)

## Bootstrap

```sh
cd claude-sessions
docker compose up -d postgres
cp .env.example .env             # set JWT_SECRET, OPENAI_API_KEY (optional)
bun install
bun run db:migrate               # idempotent; runs every new file in src/db/migrations
```

## Run

In separate terminals:

```sh
# Terminal 1 — server (tsx watch)
bun run --filter @claude-sessions/server dev

# Terminal 2 — web (vite, port 5173, proxies /api to :3000)
bun run --filter @claude-sessions/web dev

# Terminal 3 — CLI watcher
bun run --filter @claude-sessions/cli build
node packages/cli/dist/main.js login --server http://localhost:3000 --email ... --password ...
node packages/cli/dist/main.js enable .
node packages/cli/dist/main.js watch
```

For a "production-shaped" run, build the SPA into `packages/web/dist` and let the server serve it at `http://localhost:3000`:

```sh
bun run --filter @claude-sessions/web build
bun run --filter @claude-sessions/server dev
```

The static handler (`packages/server/src/routes/static.ts`) auto-detects the dist directory; reserved prefixes (`/api/`, `/mcp`, `/health`) bypass it.

## Seeding a user

There is no public registration endpoint. Two ways to create a user:

### From a quick Node script

```ts
import postgres from "postgres";
import { hashPassword } from "./packages/server/src/auth/argon.js";

const sql = postgres(process.env.DATABASE_URL!);
await sql`INSERT INTO users (email, password_hash, role)
          VALUES (${email}, ${await hashPassword(password)}, 'user')`;
await sql.end();
```

### Reuse the test helper

`packages/server/tests/helpers/seed.ts` exports `seedUser(db, jwtSecret, opts)`. Useful in repl/test contexts.

## Scripts (root)

| Script | What it does |
|---|---|
| `bun install` | Workspace install (Bun resolves `packages/*`) |
| `bun run dev` | `turbo run dev` (server + web in parallel) |
| `bun run build` | `turbo run build` |
| `bun run test` | `turbo run test` (vitest in every package) |
| `bun run typecheck` | `turbo run typecheck` (tsc --noEmit in every package) |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |
| `bun run db:migrate` | Forwarded into the server package |

## Per-package scripts

### `@claude-sessions/core`

Pure types + helpers. `build` (tsc), `test`, `typecheck`. No runtime deps beyond the standard library.

### `@claude-sessions/adapter-claude`

JSONL-to-canonical streaming. Test fixtures under `packages/adapter-claude/__fixtures__`.

### `@claude-sessions/server`

| Script | What it does |
|---|---|
| `dev` | `tsx watch src/main.ts` — restarts on change |
| `build` | tsc, then `node dist/index.js` is runnable |
| `test` | vitest; uses `testcontainers` to spin up a temporary Postgres for DB-touching suites |
| `db:migrate` | `tsx src/db/migrate.ts` |
| `db:generate` | `drizzle-kit generate` to create new migrations from schema changes |

### `@claude-sessions/cli`

| Script | What it does |
|---|---|
| `build` | tsc + `chmod +x dist/main.js` so it can be invoked as a bin |
| `test` | vitest; uses `undici` MockAgent to fake the server |

CLI tests rely on `CLAUDE_SESSIONS_HOME` and `CLAUDE_PROJECTS_DIR` env vars to redirect state and project directories away from the developer's real home.

### `@claude-sessions/web`

| Script | What it does |
|---|---|
| `dev` | `vite` on port 5173 with HMR; proxies `/api` to `:3000` |
| `build` | `tsc -p tsconfig.build.json && vite build` → `dist/` |
| `test` | vitest with jsdom + Testing Library |

## Testing

- **Unit-level**: vitest in each package
- **DB-backed integration**: server tests start a `pgvector/pgvector:pg16` container via `testcontainers`, run migrations, and tear down at the end
- **CLI integration**: tests inject mock `UploadClient`s and stub `chokidar` / `claude` runners so no network or child-process work happens
- **Fakes**: `EMBED_PROVIDER=fake` returns deterministic 1536-dim vectors so search behavior is reproducible without an OpenAI key

Run the full suite:

```sh
bun run test
```

Single package:

```sh
bun run --filter @claude-sessions/server test
```

## Package map

```
packages/
├── core/                      Canonical types, pricing table, redaction,
│                              git repo detection. Zero runtime deps.
├── adapter-claude/            Stream Claude Code JSONL → CanonicalEvent[].
├── cli/                       commander binary; commands/, watcher/,
│                              summarizer/, upload/, config/.
├── server/                    Hono app, routes/, lib/, embed/, auth/,
│                              db/ (drizzle schema + migrations).
├── web/                       React 18 + Vite + Tailwind v4 SPA.
│                              Pages: Login, Home, RepoView, SessionView,
│                              Search.
└── test-config/               Shared vitest config for consistent
                               coverage thresholds, reporters, etc.
```

## Migrations

- Add a new SQL file to `packages/server/src/db/migrations/` named `NNNN_<name>.sql` (sorted lexicographically)
- `bun run db:migrate` is idempotent: each filename is recorded in `schema_migrations`; only new files run
- `db:generate` produces a candidate migration from drizzle schema diffs — review the SQL before committing

## Common gotchas

- **`pgvector` extension missing**: `db:migrate` runs `CREATE EXTENSION IF NOT EXISTS vector` in `0001_init.sql`. The `pgvector/pgvector:pg16` image already ships the extension; vanilla Postgres does not.
- **Port 5433**: the docker-compose service maps host `5433 → 5432` to avoid clashing with a system Postgres on 5432. The default `DATABASE_URL` in `.env.example` matches this.
- **`EMBED_PROVIDER=openai` without a key**: the summary handler will throw at embed time. Either set `OPENAI_API_KEY` or set `EMBED_PROVIDER=fake`.
- **`node packages/cli/dist/main.js` not running**: make sure you ran `bun run --filter @claude-sessions/cli build` first; the bin shebang is `#!/usr/bin/env node` and `chmod +x` is part of the build step.
- **CLI never finds my JSONL**: the discovery path is `~/.claude/projects/<encoded-cwd>/*.jsonl` where `<encoded-cwd>` replaces `/` with `-`. The fallback walks every project directory and validates by reading the first line's `cwd`. If your sessions are on a non-default path, set `CLAUDE_PROJECTS_DIR`.
