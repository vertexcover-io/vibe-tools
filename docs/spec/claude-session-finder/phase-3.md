# Phase 3: CLI watcher + uploader

> **Status:** pending
> **Depends on:** Phase 1 (adapter+redaction), Phase 2 (server core)
> **Traces to:** REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-015, REQ-042, REQ-045, REQ-046, REQ-058

## Overview

The CLI gains its first real subcommands: `enable`, `disable`, `status`, `watch`, `sync`. Implements:

- **Login state**: reads JWT from `~/.claude-sessions/credentials.json` (mode 0600) or OS keychain
- **state.json**: per-file byte offset persistence at `~/.claude-sessions/state.json`
- **Repo registry**: a flat JSON `~/.claude-sessions/repos.json` mapping `canonical_url → local_path` (for fork's `--cwd` defaulting later, REQ-055; also tracks `enabled: true/false`)
- **chokidar watcher**: tails JSONL files for enabled repos
- **Debounced batch uploader**: collects events, POSTs to `/api/ingest` every 500ms or 100 events
- **Backfill on enable + on watcher start**: catches up unsynced bytes

After this phase: `claude-sessions enable .` from inside vibe-tools registers the repo, `claude-sessions watch` runs a long-lived process that tails `~/.claude/projects/` and uploads new events to the local server within ~1s of write.

## Files

```
packages/cli/
├── package.json                      # bin: { "claude-sessions": "./dist/main.js" }
├── tsconfig.json
├── src/
│   ├── main.ts                       # commander entry
│   ├── config/
│   │   ├── credentials.ts            # ~/.claude-sessions/credentials.json
│   │   ├── state.ts                  # ~/.claude-sessions/state.json
│   │   └── repos.ts                  # ~/.claude-sessions/repos.json
│   ├── commands/
│   │   ├── login.ts
│   │   ├── enable.ts
│   │   ├── disable.ts
│   │   ├── status.ts
│   │   ├── watch.ts
│   │   └── sync.ts                   # one-shot catch-up
│   ├── watcher/
│   │   ├── chokidar.ts
│   │   ├── consume.ts                # parse new bytes from offset
│   │   └── debouncer.ts              # batch + send
│   ├── upload/
│   │   ├── client.ts                 # fetch wrapper (auth, retry)
│   │   └── retry.ts                  # exp-backoff
│   └── discover.ts                   # find JSONL files for a repo
└── tests/
    ├── enable.test.ts
    ├── watch.test.ts
    └── helpers/
        ├── mock-server.ts
        └── tmp-jsonl.ts
```

## File layouts

`~/.claude-sessions/credentials.json` (mode 0600):
```json
{ "server_url": "http://localhost:3000", "token": "<jwt>", "user_email": "..." }
```

`~/.claude-sessions/state.json`:
```json
{
  "version": 1,
  "files": {
    "/Users/u/.claude/projects/-Users-u-foo/abc.jsonl": {
      "byte_offset": 12345,
      "last_event_uuid": "uuid-...",
      "session_id": "abc",
      "last_seen_at": "2026-05-09T12:00:00Z"
    }
  }
}
```

`~/.claude-sessions/repos.json`:
```json
{
  "version": 1,
  "repos": {
    "github.com/vertexcover-io/vibe-tools": {
      "local_path": "/Users/u/Projects/vibe-tools",
      "enabled": true,
      "manual_override_url": null,
      "enabled_at": "2026-05-09T12:00:00Z"
    }
  }
}
```

These are flat JSON files written atomically (write to `.tmp`, rename). Concurrent CLI invocations are rare (`watch` is the only long-running one); use a simple file-lock via `proper-lockfile`.

## Commands

### `claude-sessions enable [path]`

```ts
// commands/enable.ts
export async function enableCommand(path = process.cwd()) {
  const id = detectRepo(path);  // from packages/core
  if (!id) { console.error("not a git repository"); process.exit(1); }
  await reposConfig.upsert(id.canonical_url, { local_path: id.toplevel, enabled: true });

  // Tell server (so RBAC works on subsequent ingest)
  const client = await uploadClient();
  await client.post("/api/repos/enable", { canonical_url: id.canonical_url, local_path: id.toplevel });

  // Backfill: discover and consume all existing JSONLs for this repo
  const files = findSessionsForRepo(id.canonical_url);
  for (const f of files) await consumeFile(f, { fullScan: true });

  console.log(`enabled: ${id.canonical_url}`);
}
```

### `claude-sessions disable [path]`

Symmetric: marks repo `enabled: false` in repos.json, calls `/api/repos/disable`. With `--purge` flag, sends `purge: true`.

### `claude-sessions status`

Reads repos.json + state.json. Prints a table:

```
REPO                                     STATUS    LOCAL PATH                       LAST SYNC
github.com/vertexcover-io/vibe-tools     enabled   /Users/u/Projects/vibe-tools     2026-05-09 12:01
github.com/foo/bar                       disabled  /Users/u/Projects/bar            -
```

### `claude-sessions watch`

Long-running. Starts the chokidar watcher for all enabled repos. Stays alive until SIGINT.

### `claude-sessions sync`

One-shot. Same as the start of `watch` but exits after the catch-up pass. Useful for "I just installed this; ingest everything that exists now."

## Watcher

```ts
// watcher/chokidar.ts
export class JsonlWatcher {
  private watcher?: FSWatcher;
  private debouncer: BatchDebouncer;

  constructor(
    private state: StateConfig,
    private upload: UploadClient,
  ) {
    this.debouncer = new BatchDebouncer({
      maxEvents: 100,
      maxWaitMs: 500,
      flush: (sessionId, events) => this.upload.ingest(sessionId, events),
    });
  }

  async start(filePaths: string[]): Promise<void> {
    // Catch-up first
    for (const p of filePaths) await this.consume(p);

    // Then watch
    this.watcher = chokidar.watch(filePaths.map(dirname).filter(unique), {
      persistent: true,
      ignoreInitial: true,
      depth: 1,                                   // watch the project dir, see new JSONL files
    });
    this.watcher.on("change", (p) => p.endsWith(".jsonl") && this.consume(p));
    this.watcher.on("add",    (p) => p.endsWith(".jsonl") && this.consume(p));
  }

  private async consume(path: string): Promise<void> {
    const cur = await this.state.get(path);
    const offset = cur?.byte_offset ?? 0;
    const size = (await stat(path)).size;
    if (size <= offset) return;

    const session = await readSessionMeta(path);  // first line + last line for metadata
    if (!isRepoEnabled(session.cwd)) return;      // EDGE-005: unenabled, skip

    let lastUuid: string | null = cur?.last_event_uuid ?? null;
    for await (const ev of streamEvents(path, { byteOffset: offset })) {
      // Redact (CLI-side, REQ-005)
      ev.raw = redactDeep(ev.raw);
      this.debouncer.push(session.id, ev);
      lastUuid = ev.event_uuid;
    }
    await this.debouncer.flush(session.id);
    await this.state.set(path, { byte_offset: size, last_event_uuid: lastUuid, session_id: session.id, last_seen_at: new Date().toISOString() });
  }
}
```

The flush function in the debouncer calls the upload client. **If upload fails (network or 5xx), state.json is NOT updated** (REQ-045). Next watcher tick or next `sync` re-reads from the same offset, re-POSTs the same events, server dedupes.

## Upload client

```ts
// upload/client.ts
export class UploadClient {
  constructor(private serverUrl: string, private token: string) {}

  async ingest(sessionId: string, events: CanonicalEvent[]): Promise<void> {
    const session = buildSessionMetadata(sessionId, events);
    return retryWithBackoff(() =>
      fetch(`${this.serverUrl}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${this.token}` },
        body: JSON.stringify({ session, events }),
      }).then(r => {
        if (!r.ok) throw new HttpError(r.status, r.statusText);
      })
    );
  }
}

// upload/retry.ts
const DELAYS = [1_000, 4_000, 16_000, 60_000, 300_000];
export async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (attempt < DELAYS.length) await sleep(DELAYS[attempt]);
    }
  }
  throw lastErr;
}
```

## Tests

- **REQ-010/011**: `enable` in a git dir registers; `enable` in `/tmp` exits non-zero with the expected stderr
- **REQ-012**: `disable` removes from repos.json + calls server
- **REQ-013**: pre-populate 5 JSONLs, run `enable`, assert mock server received 5 ingest calls
- **REQ-014**: live append + 5s assertion (use a tmp dir, real chokidar)
- **REQ-015**: kill watcher mid-file, restart, assert events past the offset only
- **REQ-045**: mock server returns 500 thrice then 200; assert state.json offset advanced only after success; assert no duplicate events on the server
- **REQ-046**: `status` output format check
- **EDGE-002**: replace JSONL inode; new events still ingest, no duplicates by event_uuid
- **EDGE-009**: write 3 events, run `enable`, write 3 more — all 6 ingested

## Done When

- [ ] All tests pass with a real `testcontainers` server (or mock)
- [ ] Manual: enable vibe-tools, run `claude` for a minute, observe ingested events in DB
- [ ] `tsc --noEmit` passes

## Commit

`feat(cli): watcher + uploader + enable/disable/status/watch/sync (phase 3)`
