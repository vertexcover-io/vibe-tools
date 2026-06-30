# CLI reference

`claude-sessions` is the long-running indexer. The compiled binary lives at `packages/cli/dist/main.js` (`bun run --filter @claude-sessions/cli build`). Run it as `node packages/cli/dist/main.js <subcommand>` or `npm link` it as `claude-sessions`.

State directory: `~/.claude-sessions/` (override with `CLAUDE_SESSIONS_HOME`).

```
~/.claude-sessions/
├── credentials.json       # { server_url, token, user_email }, mode 0600
├── repos.json             # enabled repos: { canonical_url → { local_path, enabled } }
├── state.json             # per-JSONL byte offsets and last-seen timestamps
└── sessions/
    └── <session-id>.private    # zero-byte sidecar to withdraw a session
```

The Claude Code transcripts directory is `~/.claude/projects/` by default (override with `CLAUDE_PROJECTS_DIR`). Source: `packages/cli/src/discover.ts`.

## Commands

### `login`

Authenticate against a server and persist the bearer token.

```sh
claude-sessions login \
  --server http://localhost:3000 \
  --email you@example.com \
  --password '...'
```

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--server <url>` | yes | `http://localhost:3000` | Trailing slashes stripped |
| `--email <email>` | yes | — | |
| `--password <password>` | yes | — | Sent only over the login POST |

Writes `credentials.json` with mode `0600` (REQ-030, REQ-031). On failure: stderr `invalid email or password`, exit 1.

Implementation: `packages/cli/src/commands/login.ts`.

### `enable`

Register a repo for sync.

```sh
claude-sessions enable                  # current cwd
claude-sessions enable /path/to/repo
```

Behavior:

1. `core.detectRepo(path)` walks up looking for a git root + remote → canonical URL (e.g. `github.com/owner/repo`)
2. Local registry: upsert `{ canonical_url, local_path, enabled: true }` in `repos.json`
3. Server: `POST /api/repos/enable { canonical_url, local_path }` — grants `owner` access
4. Backfill: discover every JSONL with `cwd === local_path` under `~/.claude/projects/*` and run the consume pipeline once (REQ-013). Skip with the internal `skipBackfill` option (test-only).

Exits 1 with stderr `not a git repository` if `path` has no git remote.

### `disable`

```sh
claude-sessions disable                 # current cwd
claude-sessions disable /path/to/repo
claude-sessions disable . --purge       # also delete events from server
```

| Flag | Default | Notes |
|---|---|---|
| `--purge` | `false` | Server deletes every session/event for this user+repo (REQ-037) |

Flips `enabled: false` in `repos.json`, calls `POST /api/repos/disable`. The watcher then ignores any new JSONL writes for this repo.

### `status`

```sh
claude-sessions status
```

Prints a fixed-width table:

```
REPO                       STATUS      LOCAL PATH                LAST SYNC
github.com/me/proj         enabled     /Users/me/proj            2026-05-09 12:30
github.com/me/other        disabled    /Users/me/other           -
```

`LAST SYNC` is the most-recent `last_seen_at` across all tracked files (REQ-046). Source: `packages/cli/src/commands/status.ts`.

### `sync`

```sh
claude-sessions sync
```

One-shot catch-up. Iterates every JSONL we know about for an enabled repo and runs the consume pipeline (no chokidar, no end-detect, no summarization). Useful after a fresh install or a long offline window before starting `watch`.

### `watch`

```sh
claude-sessions watch
```

Long-lived foreground tail.

- Initial pass equivalent to `sync` (catch-up before installing chokidar)
- Watches parent directories of every known JSONL with `depth: 1`
- New `.jsonl` adds are picked up automatically
- Per-file consume is serialized so a burst of writes doesn't race on `state.json`
- `SessionEndDetector` fires summarization 60s after the last event for a session
- `SIGINT` / `SIGTERM` closes chokidar + drains in-flight uploads cleanly

The summarizer is gated by a global semaphore (capacity 2, REQ-019).

### `fork`

```sh
claude-sessions fork <session-id> --until <event-uuid> [--cwd <path>]
```

| Flag | Required | Notes |
|---|---|---|
| `--until <event-uuid>` | yes | Truncate at this UUID inclusive |
| `--cwd <path>` | no | Defaults to the source repo's registered `local_path` |

Steps (REQ-050–REQ-056):

1. `GET /api/sessions/<id>` to resolve the source repo URL
2. Resolve `--cwd` (default → registered local path; error if neither is set)
3. `GET /api/sessions/<id>/blob` for the raw NDJSON
4. Walk lines; for each: `cwd ← <new cwd>`, `sessionId ← <new>`; first line `parentUuid: null`; stop after the line whose `uuid === --until`
5. Write `~/.claude/projects/<encoded-cwd>/<new-session-id>.jsonl` (encoded-cwd replaces `/` with `-`)
6. Refuse to overwrite an existing file (EDGE-022)
7. Print resume command: `cd <cwd> && claude --resume <new-session-id>`

If the chosen UUID isn't in the blob, exits 1 with `event uuid not found in session: ...`.

### `name`

```sh
claude-sessions name <session-id> "Auth bug fix"
claude-sessions name <session-id>          # clear (revert to LLM title)
```

`PATCH /api/sessions/<id>` with `{ name }`. The server's `display_name` resolution prefers user `name` → LLM `title` → `Session <prefix>` (REQ-059, REQ-060).

### `find`

```sh
claude-sessions find auth bug last week
```

Opens the dashboard search page in the default browser: `<server_url>/search?q=<urlencoded query>` (REQ-020). Does not call the API directly.

### `open`

Opens `<server_url>` in the default browser (REQ-021).

### `mcp`

```sh
claude-sessions mcp
```

`POST /api/auth/mcp-token` with the bearer to mint a fresh JWT scoped to audience `mcp`. Prints the install command:

```
Run this to register the MCP server in Claude Code:

  claude mcp add claude-sessions http://localhost:3000/mcp/<token>
```

The token is the URL path segment, not a header — Claude Code's MCP client treats the URL as opaque.

## Exit codes

- `0` — success
- `1` — auth failure, missing repo, missing UUID, or any unrecoverable runtime error
- Watch parks indefinitely; SIGINT/SIGTERM exit `0`.

## Privacy controls

- **Per-repo opt-in**: only `enable`d repos are watched, ingested, or summarized. Everything else stays on disk.
- **Per-session sidecar**: drop a zero-byte file at `~/.claude-sessions/sessions/<sessionId>.private`. The watcher's next consume tick PATCHes the cloud copy to `is_private: true` (which hard-deletes events/summary/embedding/blob server-side) and then advances the byte offset to current EOF so further appends are ignored. Source: `packages/cli/src/watcher/privacy.ts` + `packages/cli/src/watcher/consume.ts`.
- **Defense-in-depth redaction**: `core.redact()` runs on every string leaf before upload; the server runs the same `redact()` again at write time (`packages/server/src/redact.ts`).
