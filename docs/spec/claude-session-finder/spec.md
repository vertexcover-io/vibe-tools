# SPEC: Claude Session Finder & Cloud Sync

**Source:** docs/plans/2026-05-09-claude-session-finder-design.md
**Generated:** 2026-05-09
**Spec name:** claude-session-finder

## Scope of this SPEC

This SPEC covers the **personal-cloud product cut**: phases 0–2 in the
design doc (skeleton + personal local + cloud sync), plus the MCP surface
and the per-repo opt-in privacy model. Phase 3 (multi-user admin UI),
phase 4 (polish), and the Cursor/Codex/OpenCoder adapters are tracked as
separate, out-of-scope items.

Each phase from the design map to:
- **Phase 0 (skeleton)**: REQ-001 to REQ-006
- **Phase 1 (personal local)**: REQ-010 to REQ-029
- **Phase 2 (cloud sync)**: REQ-030 to REQ-049
- **Phase 3 (team v0)** + **Phase 4 (polish)**: deferred — see Out of Scope

## Requirements

### Foundation: canonical schema, adapter, redaction

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Ubiquitous | The system shall expose a canonical session model with fields `{id, agent, agent_version, repo, branch, started_at, ended_at, model, total_input_tokens, total_output_tokens, total_cost_usd, permission_mode, events[], raw_jsonl_blob_url, source_cwd_hint}` where `source_cwd_hint` is the original capturing machine's cwd kept only for fork-time defaulting. | A TypeScript type `CanonicalSession` exports those exact field names; a JSON-schema validator accepts a fixture matching those fields. | Must |
| REQ-002 | Ubiquitous | The system shall expose canonical event variants `user_msg`, `assistant_msg`, `tool_use`, `summary`, `system`, each with a `ts` and a `raw` field. | TypeScript discriminated union covers exactly those 5 variants; round-trip JSON encode→decode preserves all fields. | Must |
| REQ-003 | Event-driven | When the Claude adapter is given a Claude Code JSONL file path, the system shall emit a stream of canonical events in chronological order. | Adapter run on a fixture JSONL of N events emits exactly N canonical events with monotonically non-decreasing `ts`. | Must |
| REQ-004 | Event-driven | When the Claude adapter encounters an unknown JSONL `type`, the system shall emit a `system` canonical event with `kind="unknown"` rather than dropping the line. | Adapter run on a JSONL containing one `type:"future_unknown"` line emits one `system` event with that raw payload. | Must |
| REQ-005 | Event-driven | When given any text input, the redaction library shall replace strings matching AWS access keys, GitHub tokens, OpenAI keys, JWTs, OAuth bearer tokens, and lines starting with `[A-Z_]+=` (env-var assignments) with a fixed placeholder `[REDACTED:<kind>]`. | A test fixture containing one of each pattern outputs a string where each pattern is replaced by `[REDACTED:<kind>]` and no original characters remain for those patterns. | Must |
| REQ-006 | Event-driven | When given a string with Shannon entropy ≥ 4.5 bits/char and length ≥ 32, the redaction library shall replace it with `[REDACTED:high-entropy]`. | A 40-char base64-looking random blob in a sentence is replaced; a 40-char repeated `aaaa…` is not. | Must |

### Phase 1: personal local — sync agent, summarizer, web app, search

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-010 | Event-driven | When `claude-sessions enable <path>` is run, the system shall record the path's repo identity (canonical remote URL) and start a sync watcher for that repo. | After `enable`, `claude-sessions status` lists the repo as `enabled`; the watcher process is detectable via PID file or process registry. | Must |
| REQ-011 | Event-driven | When `claude-sessions enable <path>` runs against a path with no `.git` ancestor, the system shall exit with non-zero status and a message containing the substring `not a git repository`. | Running in `/tmp` exits with code != 0 and stderr matches `/not a git repository/`. | Must |
| REQ-012 | Event-driven | When `claude-sessions disable <path>` is run, the system shall stop the watcher for that repo's identity and stop uploading new events for it. | After `disable`, `status` shows `disabled`; new JSONL events written under that cwd produce no upload requests within 30 s. | Must |
| REQ-013 | Event-driven | When the sync agent watcher starts for an enabled repo, the system shall backfill all existing sessions whose `cwd` resolves to that repo identity. | Given N pre-existing JSONL sessions for the repo, after backfill `status` reports `synced=N`. | Must |
| REQ-014 | Event-driven | When a JSONL file under an enabled repo gains new bytes, the sync agent shall parse those new bytes as canonical events and ingest them within 5 s of the write. | Append a 1-line event to a watched JSONL; within 5 s the local SQLite cache contains the new event. | Must |
| REQ-015 | Ubiquitous | The sync agent shall persist a per-file last-byte-offset so that restarts resume from the last processed position. | Stop the agent mid-file; restart; only events after the last offset are reprocessed (no duplicates by `(session_id, event_uuid)`). | Must |
| REQ-016 | Event-driven | When a session's last event has been silent for ≥ 60 s, the system shall consider that session "ended" and enqueue it for summarization. | Append last event, wait 60 s, observe one summarizer enqueue. | Must |
| REQ-017 | Event-driven | When a session is enqueued for summarization, the summarizer shall invoke `claude -p` with a JSON schema containing fields `{title, summary, tags, files_touched, prs_referenced, tool_call_counts}` (see `summary-schema.md` for definitions) and store the parsed result on the session. `summary` is a 4-6 sentence paragraph; `tags` is 3-8 lowercase kebab-case labels. | After summarization, the local SQLite `summaries` row for that session has all 6 fields populated and is non-null; `summary` is ≥ 200 chars; `tags.length ≥ 3`. | Must |
| REQ-059 | Ubiquitous | The system shall support a user-set `name` field per session. The display name resolution order is: user-set `name` → LLM-generated `title` → `Session <first-8-chars-of-id>`. | Setting `name` then GET-ing the session returns it as `display_name`; clearing `name` falls back to `title`; if both null, falls back to `Session <prefix>`. | Must |
| REQ-060 | Event-driven | When `claude-sessions name <session-id> "<name>"` is run, the system shall persist the name on the session locally and (if cloud is configured) upload it. | After the command, `status`/UI shows the new name; restart the agent — name persists. | Should |
| REQ-018 | Unwanted | If the `claude` CLI exits non-zero or returns invalid JSON, then the system shall mark the session's summary as `failed` with the error captured and retry up to 3 times with exponential backoff. | Mock claude returning rc=1 thrice; fourth attempt is not made within the window; session has `summary_status='failed'`. | Must |
| REQ-019 | Ubiquitous | The summarizer shall serialize at most 2 concurrent `claude -p` calls. | Enqueue 10 sessions; observe at most 2 simultaneous child processes via process count. | Must |
| REQ-020 | Event-driven | When `claude-sessions find <query>` is run, the system shall open the user's default browser to `https://<host>/search?q=<urlencoded query>` (or the local web app URL if cloud is not configured). | After the command, the browser has navigated to that URL. (Verify via mock open(); CI uses dry-run flag.) | Must |
| REQ-021 | Event-driven | When `claude-sessions open` is run, the system shall open the dashboard URL in the user's default browser. | As above with no `q=`. | Must |
| REQ-022 | Event-driven | When the web app receives a search request `q=<text>`, the system shall return ranked sessions using a hybrid search combining Postgres FTS and pgvector cosine similarity (Reciprocal Rank Fusion). | Curl `/api/search?q=foo` returns JSON `{ results: [{session_id, score, ...}], strategy: "rrf" }`; results are stably ordered. | Must |
| REQ-023 | Ubiquitous | The web app's home view shall present sessions grouped by repo, with each repo showing the count of sessions, last activity time, and a click-through to the session list for that repo. | Visit `/`; HTML contains a repo tile per enabled repo with `data-session-count` attribute matching the DB count. | Must |
| REQ-024 | Ubiquitous | The web app's session-detail view shall render the session as a Claude.ai-style chat: alternating user/assistant cards, tool calls as collapsible blocks showing `tool name + 1-line preview`, a sticky header containing `repo, branch, PR badge (if linked), model, duration, total cost`, AND an expandable summary panel directly under the header showing `title (or name), summary paragraph, tags as clickable chips, files-touched list, prs-referenced badges`. The summary panel is open by default and collapses on click. | Visit `/session/<id>` for a fixture; assert structural classes `.msg-user`, `.msg-assistant`, `.tool-call.collapsed`, header with all 6 spans, and a `.session-summary-panel` containing all 5 inner sections. | Must |
| REQ-025 | Ubiquitous | The web app shall expose filter chips for `repo, branch, agent, model, has_pr, date-range`. | DOM contains 6 filter chip components; selecting each updates the URL query and the result list. | Should |
| REQ-026 | Event-driven | When a session ends, the system shall extract `pr_url` by scanning `tool_use` events whose tool is `Bash` and whose input matches `^gh pr create|^git push -u`, then taking any `https://github.com/.+/pull/\d+` from the result. | Fixture session containing such a tool call: `session.pr_urls[0]` equals the URL in the result. | Must |
| REQ-027 | Unwanted | If PR mining finds no URL but a `git push` occurred, then the system shall query `gh pr list --head <branch> --state=all --limit 1 --json url` against the cwd's remote and store the result as a `fallback`-source PR link. | Fixture with a `git push` tool call but no `gh pr create`; mock `gh pr list` returns one URL; `session_pr_links` has one row with `source='fallback'`. | Should |
| REQ-028 | Unwanted | If a discovered PR's repo does not match the session's cwd canonical remote, then the system shall not link that PR. | Fixture: gh pr create output points to `org/other`, session cwd resolves to `org/this`; no PR link stored. | Must |
| REQ-029 | Ubiquitous | The system shall expose an MCP server with tools `search_sessions`, `get_session`, `find_sessions_for_pr`, `get_my_recent_sessions`, `mark_current_session_private`, `mark_current_session_public`. | Connect via the official MCP client SDK; `tools/list` returns exactly those 6 tool names. | Must |

### Phase 2: cloud sync — auth, ingest, RBAC, redaction at rest

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-030 | Event-driven | When `claude-sessions login` is run with valid credentials, the system shall store an auth token in the OS keychain (or `~/.claude-sessions/credentials.json` with mode 0600 as fallback) and exit with code 0. | After login, the file exists with mode `0600` or a keychain entry exists; subsequent CLI calls use the token. | Must |
| REQ-031 | Event-driven | When `claude-sessions login` is run with invalid credentials, the system shall exit with code != 0 and stderr containing `invalid email or password`. | Mock server returns 401; CLI exits with the expected message. | Must |
| REQ-032 | Ubiquitous | The cloud API shall require an Authorization bearer token on every endpoint except `/auth/login` and `/health`. | Curl any other path with no token returns HTTP 401. | Must |
| REQ-033 | Event-driven | When the sync agent uploads events for a session, the system shall POST them in batches of ≤ 100 events to `/api/ingest` with idempotency key = `(user_id, event_uuid)`. | Send the same batch twice; the cloud DB stores each event row exactly once. | Must |
| REQ-034 | Ubiquitous | The cloud shall apply the redaction library to every payload before persisting to Postgres or blob storage. | Upload an event whose content contains `AKIA0123456789ABCDEF`; the persisted row's payload contains `[REDACTED:aws-access-key]`. | Must |
| REQ-035 | Event-driven | When the cloud receives an ingest for a repo the calling user has not enabled (no `user_repos` row with `access`), the system shall reject with HTTP 403 and message `repo not enabled for user`. | POST ingest with unknown `repo_id`; observe 403. | Must |
| REQ-036 | Event-driven | When a user reads a session via `/api/session/<id>`, the system shall write an `audit_log` row with `(actor_user_id, action='read_session', target_session_id, ts)`. | After GET, audit_log row count for that session increments by 1. | Must |
| REQ-037 | Event-driven | When `claude-sessions disable <path>` runs and is followed by `--purge`, the system shall delete all events, summaries, and blobs for that repo from the cloud within 60 s. | After purge, sessions for that repo return 404; blob URLs return 404. | Should |
| REQ-038 | Event-driven | When a summary is uploaded to `/api/sessions/<id>/summary`, the system shall generate a `pgvector(1536)` embedding inline in the request handler from `title + summary + tags.join(' ') + files_touched.join(' ')` and store it in `embeddings`. The handler shall return after both summary AND embedding are persisted. | After POST returns 200, the `embeddings` row exists with a non-zero vector. p95 handler latency ≤ 500ms with OpenAI embedding model. | Must |
| REQ-061 | Event-driven | When a session's summary is uploaded and ≥ 30s have elapsed since the last assistant event, the CLI shall PUT the raw JSONL bytes to `/api/sessions/<id>/blob`; the server shall persist them to `session_blobs.jsonl_bytes` (bytea) and set `sessions.has_blob = true`. | After PUT, `SELECT byte_size FROM session_blobs WHERE session_id=$1` returns the size of the original JSONL. | Must |
| REQ-062 | Event-driven | When `GET /api/sessions/<id>/blob` is requested by an authorized user, the system shall stream the bytea content as `application/x-ndjson` with `Content-Length` matching `byte_size`. | Curl returns the original bytes byte-for-byte. | Must |
| REQ-063 | Ubiquitous | The system shall not require a worker process, queue (Redis or otherwise), or background job runner. All write-side work happens inline in the request handler that triggered it. | `docker compose up` starts only `postgres` + `server`. `ps` on the server host shows one Node process. | Must |
| REQ-039 | Event-driven | When a session is marked private (sidecar file or MCP `mark_current_session_private`), the system shall withdraw it from the cloud (delete events + summary, keep an audit-log entry of the action). | Mark private; sessions endpoint returns 404; audit_log records the privacy change. | Must |
| REQ-040 | Event-driven | When a sidecar `<sessionId>.private` file exists at sync time, the system shall not upload that session. | Place sidecar; trigger sync; no `/api/ingest` request for that session is made. | Must |
| REQ-041 | Ubiquitous | The cloud shall enforce RBAC such that `GET /api/session/<id>` returns 200 only if the requesting user has a `user_repos` row for that session's `repo_id` OR is the session's owner. | User A cannot read User B's session under a repo A is not granted; 403. | Must |
| REQ-042 | Ubiquitous | The system shall allow each user to set per-cwd → repo manual overrides via `claude-sessions config set-repo <cwd> <canonical_url>`. | After set, sessions in that cwd are tagged with the override repo even if the cwd's `.git` remote points elsewhere. | Should |
| REQ-043 | Ubiquitous | The system shall track and store `total_input_tokens, total_output_tokens, total_cost_usd, model` per session, computed from the assistant `usage` blocks. | Session with 3 assistant turns of known token counts has matching aggregates in the DB. | Must |
| REQ-044 | Ubiquitous | The system shall track tool-call counts per tool per session (e.g., `{Bash: 12, Edit: 4, Read: 9}`). | Fixture with known counts produces a matching JSONB blob in `summaries.tool_call_counts`. | Should |
| REQ-045 | Event-driven | When the CLI's POST to `/api/ingest` fails (network or 5xx), the system shall NOT advance the per-file byte offset in `state.json`, then retry on the next watcher tick with exponential backoff (1s, 4s, 16s, capped at 5 min). On retry, the same events are re-parsed from the JSONL and re-POSTed; the server dedupes by `(user_id, session_id, event_uuid)`. | Mock server returning 500; observe state.json offset unchanged; retry attempts at backoff intervals; on recovery, exactly-once event count in the DB. | Must |
| REQ-046 | Ubiquitous | The CLI shall provide `claude-sessions status` showing per-repo state (`enabled/disabled`), local pending events count, and last successful upload timestamp. | Output matches a parseable table format with at least those 4 columns. | Should |
| REQ-047 | Event-driven | When `claude-sessions mcp` is run, the system shall print exactly one shell command that adds the cloud's MCP server to the user's Claude Code config, including a per-user token. | Output starts with `claude mcp add` and contains both the URL and a token query parameter. | Must |
| REQ-048 | Ubiquitous | The system shall canonicalize repo URLs by lowercasing host and path, stripping trailing `.git`, and normalizing `git@host:path` ↔ `https://host/path`. | All four equivalent forms of `vertexcover-io/vibe-tools` produce the same canonical string. | Must |
| REQ-049 | Ubiquitous | The system shall use UTC for all stored timestamps and emit ISO 8601 with `Z` suffix. | All `created_at`/`ts` columns are TIMESTAMPTZ; API responses serialize with trailing `Z`. | Must |

### Fork from checkpoint

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-050 | Event-driven | When the web UI's "fork from here" button is clicked on an event, the system shall display a copy-able command of the form `claude-sessions fork <session-id> --until <event-uuid> --cwd <path>` with `--cwd` pre-filled from the user's enabled-repo registry if the source session's repo is locally mapped. | DOM contains a `<code>` element whose text matches that template; if the user has the repo enabled, `--cwd` value equals the registered local path. | Must |
| REQ-051 | Event-driven | When `claude-sessions fork <session-id> --until <event-uuid> --cwd <path>` is run, the CLI shall: GET the raw JSONL via `/api/sessions/<session-id>/blob`, parse it line-by-line, keep only lines whose event uuid is ≤ `<event-uuid>` in chronological order, rewrite every line's `cwd` field to `<path>`, assign a new `sessionId` (UUID v4) replacing the original sessionId throughout, set the first line's `parentUuid: null`, and write the result to `~/.claude/projects/<encoded-cwd>/<new-sessionId>.jsonl` where `<encoded-cwd>` is `<path>` with `/` replaced by `-`. | After the command, the new file exists at the expected path; reading it back, every event's `cwd` equals `<path>`, the file ends at the chosen event, the first event has `parentUuid: null`, and the new sessionId is consistent. | Must |
| REQ-052 | Event-driven | When the fork command completes successfully, the system shall print to stdout the exact resume command: `cd <path> && claude --resume <new-sessionId>`. | Captured stdout contains that exact line. | Must |
| REQ-053 | Unwanted | If `--cwd <path>` does not exist or is not a directory, then the system shall exit with code != 0 and a message `cwd does not exist: <path>`. | Run with a bogus path; expected exit and message. | Must |
| REQ-054 | Unwanted | If `--cwd` is omitted AND the source session's repo is not in the local enabled-repo registry, then the system shall exit with code != 0 and a message instructing the user to pass `--cwd`. | Run without `--cwd` and without enabling the source repo first; expected exit and message. | Must |
| REQ-055 | Event-driven | When `--cwd` is omitted AND the source session's repo IS in the local enabled-repo registry, the system shall use the registered local path. | Pre-register a repo; run fork without `--cwd`; resulting file lands under the registered path. | Must |
| REQ-056 | Unwanted | If `<event-uuid>` is not present in the source session's blob, then the CLI shall exit with code != 0 and message `event uuid not found in session: <event-uuid>`. | Run fork with a bogus uuid against a fixture blob; expected exit and stderr. | Must |
| REQ-058 | Ubiquitous | The system shall preserve sessions in the cloud independently of the source machine's worktree lifecycle: deleting the local worktree shall not affect the cloud copy. | Enable repo, sync session, delete the worktree on disk, query the cloud — session still returned. | Must |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | JSONL line is malformed JSON | Skip the line, increment a `parse_errors` counter, continue stream | REQ-003 |
| EDGE-002 | JSONL file is rotated/replaced (inode change) | Reattach watcher to new inode, do not reprocess overlap (compare by event_uuid) | REQ-014, REQ-015 |
| EDGE-003 | Same session ID grows after backfill (resumed session) | Append new events idempotently by event_uuid | REQ-013, REQ-033 |
| EDGE-004 | Session larger than 1M tokens | Truncate to first 50k + last 200k tokens for summarizer prompt; note truncation in `errors[]` | REQ-017 |
| EDGE-005 | `cwd` has no `.git` ancestor | Tag session as `unassigned`; do not auto-sync | REQ-010, REQ-013 |
| EDGE-006 | Repo has multiple remotes | Prefer `origin`; if absent, first remote alphabetically | REQ-048 |
| EDGE-007 | Worktree path differs from main repo path | Resolve worktree to its main repo via `git rev-parse --show-toplevel`; do NOT expose worktree_path in the UI; only `repo + branch` are surfaced | REQ-001 |
| EDGE-021 | User forks a session whose source machine's cwd doesn't exist locally | UI suggests `--cwd` from enabled-repo registry; CLI rewrites cwd in every event to `--cwd` value | REQ-050, REQ-051 |
| EDGE-022 | Forked file lands at a path where a session with the new UUID already exists | Astronomically unlikely (UUID v4) but if it does, refuse to overwrite — exit with error | REQ-051 |
| EDGE-023 | User deletes a worktree after sessions are synced | Cloud copies remain; UI continues to surface them under the same `repo + branch` | REQ-058 |
| EDGE-024 | Fork target event-uuid is the very first event | Resulting JSONL has exactly one event with `parentUuid: null`; valid for `claude --resume` | REQ-051 |
| EDGE-008 | Two laptops upload the same session | Cloud dedupes by `(user_id, session_id, event_uuid)`; no duplicate rows | REQ-033 |
| EDGE-009 | User runs `enable` while a Claude session is in progress | Watcher attaches at current byte offset; backfill the prior portion | REQ-013, REQ-014 |
| EDGE-010 | User runs `disable` while events are queued | Drop queued items; previously-uploaded items remain unless `--purge` is added | REQ-012, REQ-037 |
| EDGE-011 | `claude -p` returns malformed JSON | Up to 3 retries; on final failure mark `summary_status='failed'` and surface in the UI | REQ-018 |
| EDGE-012 | Secret regex misses a real key | At-read redaction applies the latest ruleset before serving; admin re-scan job rewrites stored payloads | REQ-005, REQ-034 |
| EDGE-013 | `gh pr create` succeeded but session ended before its `tool_result` was captured | Fall back to `gh pr list --head <branch>`; mark `source='fallback'` | REQ-026, REQ-027 |
| EDGE-014 | PR linked to a different repo than the session's cwd remote | Reject the link; do not store | REQ-028 |
| EDGE-015 | User clears `~/.claude-sessions/credentials.json` while agent is running | Next upload returns 401; agent prompts for `claude-sessions login` and stops uploading | REQ-030, REQ-032 |
| EDGE-016 | User enables a repo, then renames it on GitHub | Both old and new remote URLs map to the same canonical entry; sessions remain accessible | REQ-048 |
| EDGE-017 | Session contains no assistant turns (interrupted on first user message) | Still indexable; summary is `title=user_msg first 60 chars`, `summary='session was interrupted'` | REQ-017 |
| EDGE-018 | User marks current session private mid-stream | Withdraw any already-uploaded events for that session; do not upload further events | REQ-039 |
| EDGE-019 | Sidecar `.private` file exists but session was already uploaded | Withdraw cloud copy on next sync tick | REQ-039, REQ-040 |
| EDGE-020 | OS clock skews backward during a session | Store both event-ts and ingestion-ts; UI displays event-ts; sort uses ingestion-ts as tiebreaker | REQ-049 |

## Verification Matrix

| ID | Unit | Integration | Manual | Notes |
|----|------|-------------|--------|-------|
| REQ-001 | Yes | No | No | TS type + JSON-schema fixture |
| REQ-002 | Yes | No | No | Discriminated union test |
| REQ-003 | Yes | Yes | No | Adapter against fixture JSONL |
| REQ-004 | Yes | No | No | Unknown type fixture |
| REQ-005 | Yes | No | No | Pattern table fixture |
| REQ-006 | Yes | No | No | Entropy threshold tests |
| REQ-010 | Yes | Yes | No | CLI + watcher process check |
| REQ-011 | Yes | No | No | Non-git path |
| REQ-012 | Yes | Yes | No | Watcher teardown |
| REQ-013 | No | Yes | No | Backfill against fixture dir |
| REQ-014 | No | Yes | Yes | Live append + 5 s assert |
| REQ-015 | Yes | Yes | No | Restart simulation |
| REQ-016 | Yes | No | No | Time-mocked end detection |
| REQ-017 | Yes | Yes | No | Mocked claude binary |
| REQ-018 | Yes | No | No | rc=1 mock × 3 |
| REQ-019 | Yes | No | No | Process counter |
| REQ-020 | Yes | No | Yes | Mock `open` |
| REQ-021 | Yes | No | Yes | Mock `open` |
| REQ-022 | Yes | Yes | No | RRF returns ordered list |
| REQ-023 | No | Yes | Yes | DOM snapshot |
| REQ-024 | No | Yes | Yes | Component test + visual review |
| REQ-025 | No | Yes | Yes | Filter chip behaviors |
| REQ-026 | Yes | Yes | No | Fixture session with PR tool call |
| REQ-027 | Yes | Yes | No | Mock `gh` binary |
| REQ-028 | Yes | No | No | Mismatched-repo fixture |
| REQ-029 | Yes | Yes | No | MCP `tools/list` |
| REQ-030 | Yes | Yes | No | Keychain or 0600 file |
| REQ-031 | Yes | No | No | 401 mock |
| REQ-032 | Yes | Yes | No | Curl matrix |
| REQ-033 | Yes | Yes | No | Idempotency key |
| REQ-034 | Yes | Yes | No | Pre-store redaction |
| REQ-035 | Yes | Yes | No | 403 path |
| REQ-036 | No | Yes | No | DB row check |
| REQ-037 | No | Yes | Yes | Purge timing |
| REQ-038 | No | Yes | No | Embedding refresh |
| REQ-039 | Yes | Yes | No | Privacy withdraw |
| REQ-040 | Yes | Yes | No | Sidecar honor |
| REQ-041 | Yes | Yes | No | RBAC matrix |
| REQ-042 | Yes | No | No | Override config |
| REQ-043 | Yes | No | No | Aggregate calc |
| REQ-044 | Yes | No | No | Tool-count fixture |
| REQ-045 | Yes | Yes | No | Network blackhole |
| REQ-046 | No | Yes | Yes | Status output |
| REQ-047 | Yes | No | No | Output format |
| REQ-048 | Yes | No | No | URL canonicalization table |
| REQ-049 | Yes | Yes | No | TZ checks |
| EDGE-001 | Yes | No | No | Malformed JSONL fixture |
| EDGE-002 | No | Yes | No | Rotate inode in test |
| EDGE-003 | Yes | Yes | No | Resumed-session fixture |
| EDGE-004 | Yes | No | No | Synthetic >1M-token session |
| EDGE-005 | Yes | No | No | `/tmp` cwd |
| EDGE-006 | Yes | No | No | Multi-remote git |
| EDGE-007 | Yes | Yes | No | Worktree fixture |
| EDGE-008 | Yes | Yes | No | Two-machine sim |
| EDGE-009 | No | Yes | Yes | Mid-session enable |
| EDGE-010 | Yes | Yes | No | Disable race |
| EDGE-011 | Yes | No | No | Malformed-JSON mock |
| EDGE-012 | Yes | Yes | No | At-read redaction |
| EDGE-013 | Yes | Yes | No | Interrupt before tool_result |
| EDGE-014 | Yes | No | No | Mismatched-repo PR |
| EDGE-015 | Yes | Yes | No | Cleared credentials |
| EDGE-016 | Yes | No | No | Repo rename |
| EDGE-017 | Yes | No | No | Empty-assistant session |
| EDGE-018 | Yes | Yes | No | Mid-stream privacy |
| EDGE-019 | No | Yes | No | Late sidecar |
| EDGE-020 | Yes | No | No | Clock skew |

## Out of Scope

- **Cursor / Codex / OpenCoder / Continue / Aider adapters.** Only the
  Claude Code adapter ships in v0. The canonical schema is designed to
  accommodate them, but reverse-engineering their formats is deferred.
- **Team / org abstractions.** No GitHub-org-driven tenancy, no GitHub
  team mapping, no multi-tenant billing. Just users and per-repo grants.
- **GitHub OAuth.** Auth is email + password only in v0. OAuth deferred.
- **Self-hosted single-tenant deployment.** v0 is SaaS-only on a single
  cloud deployment.
- **Always-on launchd/systemd daemon.** v0 ships the foreground +
  on-demand watcher; persistent daemon install is an opt-in stretch goal.
- **End-to-end client-side encryption.** v0 stores plaintext (after
  redaction) in the cloud. E2EE deferred — would block server-side
  summarization and search.
- **Slack/Linear/external integrations** beyond GitHub PR linking.
- **The "improve your Claude usage" agent.** v0 captures the signals
  (tool counts, errors, stagnation moments) but doesn't ship the agent
  itself.
- **In-app session editing or commenting.** Sessions are read-only in
  the UI.
- **Cost analytics dashboard.** Per-session cost is stored and shown in
  the session header; aggregate dashboards are phase 4.
- **Tauri / Electron desktop app.** Web app + CLI only for v0.
- **Embedding model alternatives.** v0 uses OpenAI
  `text-embedding-3-small`. Local embedding via Ollama deferred.
