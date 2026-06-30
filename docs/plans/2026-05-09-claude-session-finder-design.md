# Design: Claude Session Finder & Cloud Sync

**Date:** 2026-05-09
**Spec name:** `claude-session-finder`
**Status:** Design (post-brainstorm), ready for spec generation

---

## Problem Statement

Coding agents (Claude Code, Cursor, Codex, OpenCoder, Continue, Aider) generate
hundreds of conversational sessions per developer per month. Today these sessions:

1. Live as opaque JSONL files under each agent's local data directory
   (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` for Claude Code).
2. Are not searchable beyond `grep`.
3. Are not summarized — finding "the session where I built the bookmark CLI" is
   manual archaeology.
4. Are siloed per laptop — teammates can't see each other's sessions, can't
   learn from each other's prompting style, can't audit how AI assistance
   contributed to a PR.
5. Have no link from session → PR → review feedback → outcome.

We want a system that:

- **Indexes every session** across all agents with a beautiful Claude.ai-style
  transcript view.
- **Summarizes each session** with a single LLM prompt (title, 2-line summary,
  topics, files, PRs, action items).
- **Searches by NLP, repo, branch, worktree, agent, model, date, has-PR** etc.
- **Auto-links PRs** to sessions by mining `gh pr create` / `git push` /
  branch + commit SHAs from the transcript.
- **Syncs sessions to a cloud backend** so teammates with appropriate access
  can browse each other's sessions and we can build analytics on top
  ("how can $person improve their Claude usage?").
- **Per-repo opt-in** with secret redaction by default.
- **MCP server** so any agent (Claude Code, Cursor, Codex, …) can search and
  reference past sessions in-flow.

---

## Context

### Repo conventions (vibe-tools)

This repo is a flat collection of small standalone tools. Each tool has its
own folder with a `README.md`, `PROMPT.md`, and a main script. Existing tools
are CLI scripts (`aibash`, `pin`). **This new project is bigger than any
existing vibe-tools tool** (web app + cloud backend + sync agent + CLI + MCP)
and may eventually warrant its own repo, but for v0 it lives at
`claude-sessions/` inside vibe-tools.

### Claude Code session JSONL shape (verified from a sample)

- One JSONL file per session at
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- `<encoded-cwd>` = absolute path with `/` replaced by `-`
  (e.g. `/Users/foo/proj` → `-Users-foo-proj`).
- Each line is a JSON event. Discriminator field: `type`.

**Event types observed:**

- `user`: `{ type: "user", message: { role: "user", content: string | array }, sessionId, cwd, gitBranch, version, permissionMode, uuid, parentUuid, timestamp }`
- `assistant`: `{ type: "assistant", message: { model, id, role, content: [{type: "text"|"tool_use", ...}] }, requestId, usage: {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, ...}, ... }`
- `system`: telemetry-ish (`subtype: "local_command" | "stop_hook_summary" | "turn_duration"`)
- `attachment`: `hook_success`, `task_reminder`, `auto_mode`, `deferred_tools_delta`, `mcp_instructions_delta`, `skill_listing` — context injection events
- `file-history-snapshot`: file backup tracking
- `last-prompt`: cached pointer to the last user prompt

**Key facts the schema gives us for free:**
- `cwd`, `gitBranch`, `sessionId`, `version`, `permissionMode` per event
- token usage per assistant message → easy cost calc
- tool calls (`type: "tool_use"`) and their results (`tool_use_id` matches
  in subsequent `tool_result`)
- summary lines for session naming
- timestamp on every event → duration calc

### User constraints (collected during brainstorm)

- **Cross-platform** (Mac/Win/Linux). No Tauri — web app only for v0, opened
  via `claude-sessions open`.
- **Local sync agent** runs in foreground while CLI/dashboard is open; opt-in
  daemon install for always-on.
- **Cloud-first** for the team angle, but auth and tenancy stay simple
  (email + password, admin UI invites users). No team/org concept yet.
- **Per-repo opt-in.** `claude-sessions enable <repo>` backfills + tails
  forever. `claude-sessions disable <repo>` stops sync and deletes (or
  withdraws) cloud copies. From within Claude, the user can mark the *current
  session* as private (or un-private).
- **Adapters per agent** — design schema for all agents, but only ship the
  Claude adapter in v0.
- **Summarization runs locally** via `claude -p` (matches `aibash`/`pin`),
  cloud only stores the result.
- **Repo mapping**: auto-detect from `cwd → nearest .git → remote URL`,
  with a manual override per cwd in the dashboard.
- **Worktrees**: index sessions from any worktree of a repo, but the only
  surfaced axes are `repo + branch`. `worktree_path` and `cwd` are local
  machine details, not useful in the UI. Sessions persist after the local
  worktree is deleted (cloud-side artifact).
- **Fork from checkpoint**: any event in the transcript can be a fork
  point. Web UI shows a "fork from here" button; clicking it generates a
  CLI command (`claude-sessions fork <id> --until <event-uuid> --cwd
  <path>`). The CLI fetches the truncated JSONL, rewrites every `cwd`
  field to the user-supplied `--cwd` (since teammate's path won't exist
  locally), assigns a new sessionId, writes it under
  `~/.claude/projects/<encoded-cwd>/<new-id>.jsonl`, and prints the
  resume command. CLI auto-fills `--cwd` from the local enabled-repo
  registry when possible.
- **Visualization**: Claude.ai-style chat with collapsible tool calls.
- **Home view**: repo-first grid, click a repo → session list.
- **MCP** is the in-session API (also expose CLI; everything else lives in
  the web UI).
- **PR linking**: mine session events (`gh pr create`, `git push`, branch
  name + cwd remote URL).
- **Backend**: TypeScript (Hono) + Postgres + pgvector.

---

## Requirements

### Functional

1. **Index** every Claude Code session JSONL into a structured store.
2. **Summarize** each session with one `claude -p` call producing a strict
   JSON schema: `title`, `summary` (2 lines), `topics[]`, `action_items[]`,
   `files_touched[]`, `prs_referenced[]`, `errors[]` (stagnation/repeated
   failures).
3. **Sync** opted-in repos to a cloud backend; survive restarts; resume from
   last-synced timestamp.
4. **Search** sessions by NLP (Claude `-p` over a candidate set, or pgvector
   semantic search) AND by structured filters (repo, branch, worktree, agent,
   model, has-PR, date, file-touched).
5. **Visualize** a single session in a beautiful Claude.ai-style transcript
   with collapsible tool calls, sticky header (repo, branch, PR badge, model,
   duration, cost), file-diff and terminal-output formatting.
6. **Per-repo controls**: `enable <path>`, `disable <path>`, list status.
7. **Per-session privacy**: in-session `mark private` / `mark public` toggles
   stored in a sidecar file Claude can write to.
8. **Multi-user (phase 2)**: simple email+password login, admin UI to create
   users and grant per-repo read access.
9. **MCP server**: `search_sessions`, `get_session`, `find_sessions_for_pr`,
   `get_my_recent_sessions`, `mark_current_session_private`,
   `mark_current_session_public`.
10. **CLI**: `login`, `enable`, `disable`, `find`, `open`, `mcp`, `daemon
    install/uninstall`, `status`.
11. **PR linking**: per session, infer `pr_url` by mining `gh pr create`
    output and matching `branch + cwd-remote → gh pr list`.
12. **Cost & token analytics** per session, per repo, per user (signals
    needed for the future "improve Claude usage" agent).

### Non-functional

- **Privacy first**: default-deny; only enabled repos sync. Secret redaction
  before upload (env vars, `.env` contents, cloud keys via regex + entropy).
- **Performance**: backfill of 800 MB / 385 sessions on a laptop in <10
  minutes; per-session summary in <30 s; UI search responses in <300 ms p95.
- **Resilience**: sync resumable across restarts; idempotent upload (each
  event has a stable `uuid`).
- **Cross-platform**: web UI in any browser; agent + CLI on macOS/Linux/Win.
- **Auditability**: every cloud read of a session by another user is logged.
- **Cost**: backend on a single $20/month box for the personal-cloud phase.
  Storage: blob store for raw JSONL, Postgres for indexed/summary data.
- **Extensibility**: adapter interface lets us add Cursor/Codex/OpenCoder
  later without schema changes.

### Edge cases (caught during brainstorm)

- Session has **no `cwd` git ancestor** → store as "unassigned"; never auto-sync.
- **Worktree at non-repo path** → resolves to the worktree's main repo via
  `git rev-parse --show-toplevel`.
- **Repo with multiple remotes** → use `origin` if present, else first remote.
- **Session is interrupted mid-tool-use** → still indexable; summarizer
  notes "interrupted" in `errors[]`.
- **Session is huge** (1M tokens) → summarizer truncates to last 200k tokens
  + first 50k tokens of context for the prompt.
- **Same session ID exists locally and in cloud with different content**
  (e.g. user resumed an old session that grew) → merge by event UUID.
- **Repo renamed on GitHub** → store both old and current remote URLs;
  match by canonical (lowercased, no `.git`) form.
- **Secret accidentally appears in transcript** → regex+entropy redaction
  pass before upload AND on read (defense in depth).
- **PR linking false positive**: `gh pr create` ran but the PR was for a
  different repo because user `cd`-ed mid-session → require cwd's remote to
  match the PR repo.
- **`enable` race vs. live session** → on enable, the watcher attaches to
  the live JSONL and starts at the current byte offset (backfill the rest).
- **`disable` while sessions are queued** → drop queued items, keep already-
  uploaded items (with a separate `purge` command for hard delete).
- **User logs in on second machine** → both sync agents push; cloud
  deduplicates by `(user_id, session_uuid)`.
- **Adapter for other agents later** has different event shapes → canonical
  event model decouples search/UI from raw shape.
- **Local clock skew** → use UTC throughout; store both event-ts and
  ingestion-ts.

---

## Key Insights

1. **Every interesting signal is already in the JSONL.** `cwd` gives the
   project, `gitBranch` gives the branch, tool-use events give files
   touched and `gh pr create` gives the PR URL, `usage` blocks give cost.
   We don't need separate instrumentation — we just need a careful
   adapter.
2. **Local summarization is a feature**, not a compromise. It uses the
   user's free Claude Code subscription, runs in parallel across many
   sessions, and keeps the cloud's compute cost ~zero. The cloud is
   "just" Postgres + a thin API.
3. **Per-repo is the right granularity.** Per-session opt-in is too
   tedious; per-user is too coarse. Repos already have permission
   semantics on GitHub which we can mirror.
4. **MCP makes the whole thing recursive**: agents searching past
   sessions to inform new ones is the dream UX. This means session →
   PR → review-feedback links become valuable training data for the
   "improve your Claude usage" feature later.
5. **The transcript is the artifact, the summary is the index — but the
   summary is also a useful header.** Show the full transcript verbatim
   and use the summary fields for: search, the home/repo feed cards, AND
   a sticky/expandable summary panel above the transcript itself. The
   summary panel surfaces title, summary paragraph, tags, files-touched
   and PR badges so a reader can decide if the session is worth scrolling.

---

## Architectural Challenges

### 1. Adapter abstraction for multi-agent

Different agents have wildly different log formats:
- Claude Code: JSONL events with rich metadata
- Cursor: SQLite chat history with linked editor state
- Codex / OpenCoder / Continue / Aider: variable

**Resolution:** Define a **canonical session event** model. Each adapter
converts its native events into canonical events. Search, UI, summarizer
work only on canonical events.

```
CanonicalEvent =
  | { type: "user_msg",      ts, content_md, raw }
  | { type: "assistant_msg", ts, content_md, raw }
  | { type: "tool_use",      ts, tool, input_summary, output_summary, raw }
  | { type: "summary",       ts, content }
  | { type: "system",        ts, kind, content }     # hook output, errors, etc.

CanonicalSession =
  { id, agent, agent_version, cwd, repo, branch, worktree_path,
    started_at, ended_at, model, total_tokens, total_cost_usd,
    permission_mode, events[], raw_jsonl_blob_url }
```

Raw JSONL is also archived in the blob store so we never lose info we
didn't think to model.

### 2. Sync agent's lifecycle

Three modes coexist:
- **Foreground**: while `claude-sessions open` or any CLI command runs
- **On-demand background**: spawned for a configurable duration after a
  command runs (default 1 hour) so a `claude` session started right
  after still gets tailed
- **Persistent daemon**: opt-in via `claude-sessions daemon install`

All three share the same code path; the difference is who supervises
the process.

### 3. Privacy boundary

Three layers of secret redaction:
1. **Pre-upload**: regex (AWS keys, API keys, OAuth tokens, `.env` lines,
   private SSH key headers) + entropy heuristic for high-entropy strings
   that look like secrets.
2. **At-rest**: encrypted blob store; Postgres at-rest encryption.
3. **At-read**: server re-runs redaction on egress in case rule set has
   tightened since upload.

In-session privacy: a Claude tool (or a magic string in the user's
message) writes to `~/.claude-sessions/sessions/<sessionId>.private` —
the sync agent honors this file and either skips the session or
withdraws it from the cloud.

### 4. Cloud schema vs. local schema

The local SQLite is a write-through cache for offline read. Cloud
Postgres is canonical. They share the same tables but the cloud has
extra `user_id`, `org_id`, `acl` columns. The sync agent treats local
as ephemeral; can be wiped and resynced.

### 5. PR linking heuristic

Per session:
1. Walk events, find every `tool_use` where `tool=="Bash"` and the input
   command starts with `gh pr create` or `git push -u`.
2. From the corresponding `tool_result`, extract any URL matching
   `https://github.com/.+/pull/\d+`.
3. If none found but a `git push` happened, run `gh pr list --head
   <branch> --state=all --json url --limit 1` against the session's
   cwd remote → match.
4. Validate: PR's repo must equal session's cwd-remote-canonical.
5. Store as `session.pr_url`. If multiple, store as `pr_urls[]` with the
   most-recent first.

User can correct via `claude-sessions link-pr` (phase 1.5).

---

## Approaches Considered

### A. Single-binary Tauri app + cloud sync

Local app + cloud backend. Beautiful native UX. **Rejected**: user
explicitly wanted "web app + CLI" with no Tauri to keep the v0 small.

### B. Local-only personal app first, cloud as v2

Ship just the local SQLite + browser app first; add cloud later.
**Rejected**: user's primary use case is the team-cloud angle.

### C. **Web app + local sync agent + cloud + MCP (chosen)**

Local agent does file watching, repo detection, redaction,
summarization, upload. Cloud holds canonical store + serves web UI +
MCP. CLI is a thin wrapper that opens the web app and toggles the agent.

**Trade-offs:**
- Easy: web UI iteration, cross-platform, single backend codebase.
- Hard: requires the user to have a running sync agent for new sessions
  to appear; backfill is a one-shot.
- Chosen because it matches the team-product north star while being
  buildable in a few weeks.

---

## Chosen Approach: High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                          Each laptop                            │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              claude-sessions CLI (single binary)        │   │
│   │                                                         │   │
│   │  - chokidar watcher on ~/.claude/projects/              │   │
│   │  - parse JSONL → canonical events                       │   │
│   │  - secret redaction (regex + entropy)                   │   │
│   │  - debounced batch POST → /api/ingest                   │   │
│   │  - 60s-silence end detection                            │   │
│   │  - claude -p summarizer (max 2 concurrent)              │   │
│   │  - PUT raw JSONL bytes after summary                    │   │
│   │  - fork: GET blob → truncate → rewrite cwd → write file │   │
│   │  - state.json: per-file byte offset (~/.claude-sessions)│   │
│   └─────────────────────────────────────────────────────────┘   │
│                                ▲                                │
│                                │                                │
└────────────────────────────────┼────────────────────────────────┘
                                 │ HTTPS (auth: bearer JWT)
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │                       Cloud                          │
        │                                                      │
        │   API (Hono on Node) — single process, no worker     │
        │   - /api/auth/login, /me                             │
        │   - /api/ingest          (events, dedupe by uuid)    │
        │   - /api/sessions/<id>/summary  (stores summary +    │
        │                          generates embedding INLINE) │
        │   - /api/sessions/<id>/blob     (PUT raw bytes)      │
        │   - /api/sessions/<id>          (read, audit-logged) │
        │   - /api/search                 (FTS + pgvector RRF) │
        │   - /api/repos/enable           (registers repo)     │
        │   - /mcp/<token>                (MCP server endpoint)│
        │                                                      │
        │   Embedding model (pluggable):                       │
        │   - default: OpenAI text-embedding-3-small           │
        │   - alt: self-hosted bge-small-en-v1.5 (CPU, ONNX)   │
        │                                                      │
        │   Postgres 16 + pgvector                             │
        │   - users, repos, user_repos                         │
        │   - sessions, events                                 │
        │   - summaries, embeddings (vector(1536))             │
        │   - session_blobs (bytea, raw JSONL)                 │
        │   - session_pr_links, audit_log                      │
        │                                                      │
        │   Web app (Vite SPA, served by same Hono process)    │
        │   - repo-first home                                  │
        │   - transcript viewer (sticky header + summary panel │
        │                       + Claude.ai-style chat)        │
        │   - admin (phase 3+: invite users, repo grants)      │
        └──────────────────────────────────────────────────────┘
                                 ▲
                                 │ MCP (HTTPS)
                                 │
        ┌────────────────────────┴──────────────────────────────┐
        │   Other Claude / Cursor / Codex sessions              │
        │   `claude mcp add claude-sessions <user-token-url>`   │
        │   Tools: search_sessions, get_session,                │
        │          find_sessions_for_pr, ...                    │
        └───────────────────────────────────────────────────────┘
```

**Single-process server**: no worker, no queue, no Redis. The summary upload
endpoint generates the embedding synchronously in the request handler
(~50–200ms depending on model). This collapses the deployment to: one Hono
process + one Postgres database. That's it.

**Blob storage**: raw JSONL stored as `bytea` in a separate `session_blobs`
table (split from `sessions` so the small frequently-read sessions row
isn't TOAST'd by the blob). Migrate to S3-compatible later if storage hurts.

### Components

**`packages/core`** (TS) — canonical schema, adapter interface,
redaction, repo detection. Used by both the CLI and the cloud
backend.

**`packages/adapter-claude`** (TS) — reads JSONL, emits canonical events.

**`packages/cli`** (TS) — single binary `claude-sessions`. Owns:
chokidar watcher, parsing, redaction, debounced batch upload, session-end
detection, `claude -p` summarizer, fork command, `state.json` for byte
offsets at `~/.claude-sessions/state.json`. Subcommands: `login`,
`enable`, `disable`, `find`, `open`, `mcp`, `fork`, `name`, `status`,
`watch` (long-running mode), `sync` (one-shot catch-up).

**`packages/server`** (TS, Hono) — single process. REST API + MCP +
web SPA assets. Auth, RBAC, ingest, summary upload (with **inline
embedding generation**), search (Postgres FTS + pgvector RRF), audit log.
**No worker, no queue, no Redis.**

**`packages/web`** (TS, Vite + React + Tailwind) — SPA. Repo-first
home, session transcript viewer (sticky header + expandable summary
panel + Claude.ai-style chat), admin UI (phase 3+). Renders Markdown
+ collapsible tool calls.

### Data flow: a new session appears

```
1. Claude Code writes a new line to ~/.claude/projects/.../<id>.jsonl
2. CLI (chokidar watcher) sees the file change
3. CLI reads new bytes from the recorded byte offset in state.json
4. CLI parses events, checks repo opt-in, checks session privacy sidecar
5. CLI redacts text payloads (regex + entropy)
6. CLI debounces 500ms / 100 events, then POSTs batch to /api/ingest
7. Server: dedupes by (user_id, session_id, event_uuid), inserts into events
8. CLI advances state.json offset on POST 200
9. After 60s of silence: CLI marks session "ended", invokes claude -p
10. CLI POSTs summary to /api/sessions/<id>/summary
11. Server: stores summary, generates embedding INLINE in handler (~50-200ms),
    updates embeddings table
12. CLI PUTs raw JSONL bytes to /api/sessions/<id>/blob (bytea storage)
13. Web UI / MCP can now find the session
```

### Data flow: search

```
1. User types "the bookmark cli session" in web UI
2. Frontend hits /api/search?q=...
3. Server embeds the query (same model as session embeddings)
4. Server runs hybrid: pgvector cosine top-K + Postgres FTS top-K, RRF merge
5. Server applies RBAC filter (only sessions for repos the user can read)
6. Returns ranked sessions with summary previews
7. Click → /session/<id> → server returns canonical events + summary
8. Audit log row written
9. Frontend renders transcript with Claude.ai-style components
```

### Data flow: PR linking (CLI-side, deterministic)

```
1. CLI's summarizer step computes deterministic fields including PR mining
2. Walk canonical events; find tool_use with input matching ^gh pr create|^git push
3. Extract PR URL from output_summary
4. If absent but a `git push` happened: shell out to local `gh pr list --head <branch>`
5. Validate cwd-remote == PR repo (canonical match)
6. Include validated PR URLs in the summary's prs_referenced field
7. Server stores them on session row when summary is uploaded
```

### Data flow: fork from checkpoint

```
1. User in web UI clicks "fork from here" on event <event-uuid>
2. UI shows: claude-sessions fork <session-id> --until <event-uuid> --cwd <auto-suggested>
3. User copies, optionally edits --cwd, runs locally
4. CLI: GET /api/sessions/<id>/blob → server streams JSONL bytea
5. CLI: parse, truncate at <event-uuid>, rewrite every event's `cwd` to <path>,
   assign new sessionId (UUID v4), set first event's parentUuid: null
6. CLI: write to ~/.claude/projects/<encoded-cwd>/<new-sessionId>.jsonl
7. CLI: print `cd <path> && claude --resume <new-sessionId>`
```

### Schema (Postgres, abbreviated)

```sql
users(id, email, password_hash, role, created_at)
repos(id, canonical_url, display_name, created_at)
user_repos(user_id, repo_id, access: "owner|read", granted_at)
sessions(id, user_id, repo_id, agent, agent_version, branch,
         source_cwd_hint, model, started_at, ended_at,
         total_input_tokens, total_output_tokens, total_cost_usd,
         is_private, name, has_blob, created_at, updated_at)
events(session_id, event_uuid, parent_uuid, ts, type, payload jsonb,
       PRIMARY KEY (session_id, event_uuid))
summaries(session_id, title, summary, tags text[], files_touched text[],
          prs_referenced text[], tool_call_counts jsonb,
          generated_at, model, status, error)
embeddings(session_id, embedding vector(1536), embedding_model, version)
session_blobs(session_id, jsonl_bytes bytea, byte_size, uploaded_at)
session_pr_links(session_id, pr_url, source, validated_at)
audit_log(id, actor_user_id, action, target_session_id, ts)
```

`session_blobs` is a separate table from `sessions` so blob TOAST'ing
doesn't slow down `sessions` row scans. `has_blob` on `sessions` is a
denormalized flag for cheap queries.

### MCP tool surface

- `search_sessions(query, repo?, agent?, has_pr?, since?, limit?)`
- `get_session(session_id)`
- `find_sessions_for_pr(pr_url)`
- `get_my_recent_sessions(limit?, agent?, repo?)`
- `mark_current_session_private(session_id)`
- `mark_current_session_public(session_id)`

### CLI surface (v0)

```
claude-sessions login                         # interactive: email+password
claude-sessions enable [path]                  # enables repo containing path
claude-sessions disable [path]                 # disables repo
claude-sessions status                         # what's enabled/syncing/queued
claude-sessions find <query>                   # opens browser to search results
claude-sessions open                           # opens dashboard in browser
claude-sessions mcp                            # prints MCP config to install
claude-sessions daemon install|uninstall       # opt-in always-on daemon
```

---

## Open Questions

1. **Hosting**: where does the cloud live (Fly.io, Railway, self-hosted on a
   VPS, the user's own infra)? Affects auth callbacks and TLS setup. Will
   defer to planning stage.
2. **Local summarizer concurrency**: how many parallel `claude -p` calls
   are safe for the user's CC subscription? Likely 1–2; configurable.
3. **Embedding model**: OpenAI `text-embedding-3-small` (cheap, decent) vs.
   local `nomic-embed-text` via Ollama (free, offline, slightly worse).
   Defaulting to OpenAI for v0; revisit.
4. **Web app routing**: SPA vs. server-rendered? SPA chosen for simplicity;
   may revisit once the team-feature load grows.
5. **Cursor/Codex/OpenCoder adapters**: schema reverse-engineering needed.
   Out of scope for v0.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Secret leak via redaction miss | Medium | High | Defense-in-depth: pre-upload, at-rest, at-read; opt-in only; audit log |
| Sync agent eats user's CC quota | High | Medium | Rate-limit summarizer to 1–2 parallel; daily caps; user-visible counter |
| 800 MB backfill is slow | High | Low | Stream-parse; show progress; backfill in background while UI is usable |
| PR linking false positives | Medium | Medium | Strict repo-match validation; user can override; mark `source: "fallback"` |
| Cloud bill spirals | Low | Medium | Single small box for personal-cloud; alert on cost; cap blob retention |
| Multi-machine sync conflicts | Medium | Low | Idempotent upload by event UUID; cloud is canonical |
| User regrets enabling a repo | Medium | Medium | `disable + purge` flow that hard-deletes from cloud |
| MCP server abuse (token leak) | Medium | High | Per-token scope; revocation UI; short token lifetimes |
| `claude -p` quality varies | Medium | Low | Structured JSON schema + retries + regen on demand |

---

## Assumptions

- User has a working `claude` CLI installed and authenticated (matches
  existing vibe-tools assumption).
- User can run a Node-based binary on their machine (we'll ship via
  `npm install -g` or a single-file binary built with `bun build`).
- Cloud-hosted Postgres + object store will be available; specific
  vendor chosen at planning.
- The Claude Code session JSONL format is stable enough to depend on
  for v0 (the schema we observed has been consistent through Claude
  Code 2.x).
- Initial users will be friends + the user's own team; no scaling
  concerns until phase 2.
- Other agents (Cursor/Codex/...) are out of v0 scope but the schema
  shouldn't preclude them.

---

## Phase plan

| Phase | Scope | Time |
|---|---|---|
| **0: skeleton** | Repo layout, packages, canonical schema, claude adapter, redaction lib, local SQLite cache, CLI shell | 1 week |
| **1: personal local** | Sync agent (foreground), summarizer (claude -p), web app skeleton (Vite), session list + transcript view, NLP search via local SQLite FTS, MCP server stub | 2 weeks |
| **2: cloud sync** | Hono API + Postgres + pgvector, auth (email+password), `enable`/`disable`, ingest, RBAC table, web app talks to cloud, hybrid search | 2 weeks |
| **3: team v0** | Admin UI to create users, per-repo grant UI, audit log, multi-user transcript view, in-session private toggle | 1 week |
| **4: polish** | Beautiful transcript renderer (file diffs, terminal output, collapsible tool calls), repo-first dashboard, PR badges, cost analytics dashboard | 1 week |

Total: **~7 weeks** to a usable team product. v0 (phases 0–1) is shippable
in 3 weeks as a personal local tool.
