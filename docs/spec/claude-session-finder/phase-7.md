# Phase 7: Fork + privacy + name

> **Status:** pending
> **Depends on:** Phase 4 (blob storage), Phase 2 (server core)
> **Traces to:** REQ-036, REQ-037, REQ-039, REQ-040, REQ-050, REQ-051, REQ-052, REQ-053, REQ-054, REQ-055, REQ-056, REQ-058, REQ-059, REQ-060, EDGE-018, EDGE-019, EDGE-021, EDGE-022, EDGE-023, EDGE-024

## Overview

Three CLI features and the matching server bits:

1. **`claude-sessions fork <session-id> --until <event-uuid> --cwd <path>`** — fetches blob, truncates, rewrites cwd, writes new JSONL, prints resume command
2. **`claude-sessions name <session-id> "<name>"`** — sets/clears the user-set display name
3. **Privacy**:
   - Sidecar file `~/.claude-sessions/sessions/<sessionId>.private` honored at upload time (REQ-040)
   - In-progress session marked private mid-stream → withdraw uploaded events (REQ-039, EDGE-018)
   - `claude-sessions disable <repo> --purge` deletes everything for that repo from the server (REQ-037)
4. **Audit log** for every session/blob read (REQ-036)

## Fork command

```ts
// commands/fork.ts
export async function forkCommand(opts: { sessionId: string; until: string; cwd?: string }) {
  const cred = await loadCredentials();
  const client = upload(cred);

  // 1. Fetch session metadata to find the source repo
  const session = await client.get(`/api/sessions/${opts.sessionId}`);

  // 2. Determine --cwd
  let cwd = opts.cwd;
  if (!cwd) {
    const repos = await reposConfig.load();
    const localPath = repos.repos[session.repo]?.local_path;
    if (!localPath) {
      console.error(`--cwd not provided and source repo (${session.repo}) is not enabled locally. Pass --cwd.`);
      process.exit(1);
    }
    cwd = localPath;
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    console.error(`cwd does not exist: ${cwd}`);
    process.exit(1);
  }

  // 3. Fetch blob
  const blobBytes = await client.getBytes(`/api/sessions/${opts.sessionId}/blob`);

  // 4. Parse + truncate + rewrite cwd
  const newSessionId = randomUUID();
  const lines = blobBytes.toString("utf8").split("\n").filter(Boolean);

  const truncated: string[] = [];
  let foundUntil = false;
  let isFirst = true;
  for (const line of lines) {
    let ev = JSON.parse(line);
    // Rewrite cwd
    if (typeof ev === "object" && ev !== null && "cwd" in ev) ev.cwd = cwd;
    // Replace sessionId throughout
    if (ev.sessionId === opts.sessionId) ev.sessionId = newSessionId;
    // First event: parentUuid null
    if (isFirst) { ev.parentUuid = null; isFirst = false; }
    // Replace this event's uuid: leave as-is (Claude treats them as opaque)
    truncated.push(JSON.stringify(ev));
    if (ev.uuid === opts.until) { foundUntil = true; break; }
  }
  if (!foundUntil) {
    console.error(`event uuid not found in session: ${opts.until}`);
    process.exit(1);
  }

  // 5. Write to ~/.claude/projects/<encoded-cwd>/<new-id>.jsonl
  const encodedCwd = cwd.replace(/\//g, "-");
  const outDir = join(homedir(), ".claude", "projects", encodedCwd);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${newSessionId}.jsonl`);
  if (existsSync(outPath)) {
    console.error(`refusing to overwrite existing file: ${outPath}`);
    process.exit(1);
  }
  writeFileSync(outPath, truncated.join("\n") + "\n");

  console.log(`forked → ${outPath}`);
  console.log();
  console.log(`Resume:`);
  console.log(`  cd ${cwd} && claude --resume ${newSessionId}`);
}
```

## Web UI: "fork from here" button (REQ-050)

In `SessionView`, every event row gets a small "Fork" affordance on hover. Click opens a modal:

```tsx
// components/transcript/ForkModal.tsx
export function ForkModal({ sessionId, eventUuid, sessionRepo, sessionCwd }: Props) {
  const [cwd, setCwd] = useState<string>("");
  const { data: localPath } = useEnabledRepoLocalPath(sessionRepo);  // queries CLI's local repos.json via a localhost endpoint OR just suggests session.source_cwd_hint as fallback hint

  useEffect(() => {
    if (localPath) setCwd(localPath);
    else setCwd("");  // user must fill in
  }, [localPath]);

  const cmd = `claude-sessions fork ${sessionId} --until ${eventUuid}${cwd ? ` --cwd ${cwd}` : ""}`;

  return (
    <Modal>
      <h3>Fork from this point</h3>
      <p className="text-sm text-muted-foreground">
        Run this command on your local machine. {!localPath && (
          <span>This session was originally at <code>{sessionCwd}</code>; on your machine, where do you have the corresponding repo?</span>
        )}
      </p>
      <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/your/local/repo" />
      <pre className="select-all bg-muted p-2 rounded">{cmd}</pre>
      <button onClick={() => navigator.clipboard.writeText(cmd)}>Copy</button>
    </Modal>
  );
}
```

## Name command

```ts
// commands/name.ts
export async function nameCommand(sessionId: string, name: string | null) {
  const client = await uploadClient();
  await client.patch(`/api/sessions/${sessionId}`, { name });
  console.log(`renamed: ${sessionId} → ${name ?? "(cleared)"}`);
}
```

Server `PATCH /api/sessions/:id` accepts `{ name?: string | null, is_private?: boolean }`.

## Privacy

### Sidecar file (REQ-040)

```ts
// watcher/consume.ts (modify)
private async consume(path: string): Promise<void> {
  const sessionId = inferSessionId(path);
  const sidecar = join(homedir(), ".claude-sessions", "sessions", `${sessionId}.private`);
  if (existsSync(sidecar)) {
    // Mark private; if the session was previously uploaded, withdraw
    await this.upload.markPrivate(sessionId);
    return;
  }
  // ... existing flow
}
```

### Server: PATCH /api/sessions/:id with `is_private: true`

When set to `true`: delete `events` rows for the session; delete `summaries`; delete `embeddings`; delete `session_blobs`; keep the `sessions` row with `is_private = true` so audit-log linkage survives, and write an audit row `{ action: "marked_private", target_session_id: ... }`. Subsequent reads of that session return 404 except for the owner who can see "(private)" placeholder.

### Disable + purge (REQ-037)

```ts
// commands/disable.ts (extend)
export async function disableCommand(path: string, opts: { purge?: boolean }) {
  const id = detectRepo(path);
  const client = await uploadClient();
  await client.post("/api/repos/disable", { canonical_url: id.canonical_url, purge: opts.purge ?? false });
  await reposConfig.update(id.canonical_url, { enabled: false });
  console.log(`disabled${opts.purge ? " + purged" : ""}: ${id.canonical_url}`);
}
```

Server `POST /api/repos/disable` with `purge: true` cascades: deletes all sessions for that user+repo within 60s (per REQ-037).

## Audit log (REQ-036)

Wrap session/blob read endpoints:

```ts
// helpers/audit.ts
export async function withAudit<T>(c: Context, action: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await db.insert(auditLog).values({
    actorUserId: c.get("user").id,
    action,
    targetSessionId: sessionId,
    detail: { ip: c.req.header("x-forwarded-for") ?? null },
  });
  return result;
}
```

Apply on `GET /api/sessions/:id`, `GET /api/sessions/:id/blob`, `GET /api/sessions/:id/events`.

## Tests

- **REQ-051**: fork against a fixture blob; resulting JSONL has expected event count, all `cwd` fields rewritten, first parentUuid is null
- **REQ-052**: stdout contains exact `cd <path> && claude --resume <id>` line
- **REQ-053**: bogus `--cwd` exits with code != 0 and message `cwd does not exist`
- **REQ-054**: omit `--cwd` for an unmapped repo → exits with code != 0 and instructive message
- **REQ-055**: omit `--cwd` for a mapped repo → uses registered local path
- **REQ-056**: bogus `--until` UUID → exits with code != 0
- **EDGE-022**: pre-create the target file; fork refuses to overwrite
- **EDGE-024**: fork at the very first event → JSONL has 1 line with parentUuid: null
- **REQ-039**: PATCH `is_private: true` deletes events/summary/embedding/blob; GET 404
- **REQ-040**: sidecar present → no upload happens for that session
- **REQ-058**: enable+sync, then `rm -rf` the local worktree, query the cloud → session still returned
- **REQ-036**: GET session writes one audit_log row
- **REQ-037**: `disable --purge` removes all data for that user+repo within 60s
- **REQ-059**: setting name → display_name = name; clearing → display_name = title
- **REQ-060**: name persists across CLI restart

## Done When

- [ ] All tests pass
- [ ] Manually: fork your own pin session, get a working `claude --resume`-able file
- [ ] Manually: mark a session private, confirm cloud rejects subsequent reads
- [ ] Manually: name a session, see the new name in the home feed

## Commit

`feat: fork + privacy + name + audit (phase 7)`
