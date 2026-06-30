# Phase 4: Summarizer + blob upload + inline embedding

> **Status:** pending
> **Depends on:** Phase 3
> **Traces to:** REQ-016, REQ-017, REQ-018, REQ-019, REQ-026, REQ-027, REQ-028, REQ-038, REQ-043, REQ-044, REQ-061, REQ-062, EDGE-004, EDGE-013

## Overview

Three workstreams that close the v0 loop:

1. **CLI summarizer**: detect session-end (60s silence), invoke `claude -p` per `summary-schema.md`, mine PRs, POST result to `/api/sessions/<id>/summary`
2. **CLI blob upload**: after summary success, PUT the raw JSONL to `/api/sessions/<id>/blob`
3. **Server inline embedding**: in the summary upload handler, generate `vector(1536)` from `title + summary + tags + files_touched` and write to `embeddings`

## Files (new + modified)

```
packages/cli/src/
├── summarizer/
│   ├── end-detect.ts                  # 60s silence timer
│   ├── claude-runner.ts               # claude -p invocation
│   ├── prompt.ts                      # transcript builder + truncation
│   ├── deterministic.ts               # files_touched, tool_call_counts, PR mining
│   ├── pr-mining.ts                   # gh pr fallback
│   └── pipeline.ts                    # end-to-end: detect → summarize → upload summary → upload blob
└── watcher/
    └── chokidar.ts                    # MODIFY: hook end-detect into watcher

packages/server/src/
├── routes/
│   └── sessions.ts                    # NEW: /api/sessions/<id>/summary, /blob
└── embed/
    ├── index.ts                       # provider switch
    ├── openai.ts
    └── bge.ts                         # ONNX runtime
```

## CLI: end detection + summary pipeline

Hook into the existing watcher: every batch flush, schedule a 60s timer for that session. New events cancel and reschedule. Timer fires → run summarizer.

```ts
// summarizer/end-detect.ts
const SILENCE_MS = 60_000;

export class SessionEndDetector {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private onEnded: (sessionId: string) => Promise<void>) {}

  schedule(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId));
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId);
      this.onEnded(sessionId).catch(err => console.error(`summarize failed for ${sessionId}:`, err));
    }, SILENCE_MS));
  }
}
```

```ts
// summarizer/pipeline.ts
export async function summarizeAndUpload(
  sessionId: string,
  ctx: { upload: UploadClient; jsonlPath: string; cache: SessionMemoryCache }
): Promise<void> {
  // 1. Read full session from disk (fresh — chokidar may have raced)
  const session = readSessionSync(ctx.jsonlPath);

  // 2. Compute deterministic fields
  const det = computeDeterministic(session);

  // 3. PR mining (deterministic + gh fallback)
  const prs = await minePrs(session, det);

  // 4. Build prompt + run claude -p
  const llm = await runClaude({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildPromptUserMessage(session, det),
    schema: SUMMARY_SCHEMA,
    model: "sonnet",
  });

  // 5. Merge
  const summary: SessionSummary = {
    session_id: sessionId,
    title: llm.title,
    summary: llm.summary,
    tags: llm.tags,
    files_touched: dedupe([...llm.files_touched, ...det.files_touched_raw]),
    prs_referenced: dedupe([...llm.prs_referenced, ...prs]),
    tool_call_counts: det.tool_call_counts,
    generated_at: new Date().toISOString(),
    model: "sonnet",
    status: "ok",
  };

  // 6. POST summary to server (server generates embedding inline)
  await ctx.upload.uploadSummary(sessionId, summary);

  // 7. PUT raw blob (after summary; REQ-061)
  const blob = await readFile(ctx.jsonlPath);
  await ctx.upload.uploadBlob(sessionId, blob);
}
```

## CLI: claude-runner

Same shape as `pin/pin.py`'s `call_claude`, ported to TS:

```ts
// summarizer/claude-runner.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const DISALLOWED = ["Bash","Read","Edit","Write","Glob","Grep","WebFetch","WebSearch","Agent"];

export async function runClaude(opts: {
  systemPrompt: string;
  userMessage: string;
  schema: object;
  model?: string;
}): Promise<any> {
  const args = [
    "-p",
    "--model", opts.model ?? "sonnet",
    "--append-system-prompt", opts.systemPrompt,
    "--json-schema", JSON.stringify(opts.schema),
    "--output-format", "json",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--disallowedTools", ...DISALLOWED,
    "--",
  ];
  const { stdout } = await execFileAsync("claude", args, {
    input: opts.userMessage,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  } as any);
  const env = JSON.parse(stdout);
  return env.structured_output ?? JSON.parse(env.result);
}
```

Concurrency cap: a global semaphore allowing 2 in flight (REQ-019). Retries: 3× exp backoff (1s, 4s, 16s) on any throw (REQ-018). After exhaustion: POST a `status: "failed"` summary so it shows up in the UI for retry.

## CLI: deterministic computation + prompt builder

Same logic as the previous phase-4 draft (see prior phase-4 in this folder for `computeDeterministic`, `buildPromptUserMessage`, truncation policy for >1M tokens at first 50k + last 200k tokens). No changes from that draft.

## CLI: PR mining

```ts
// summarizer/pr-mining.ts
const GH_PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

export async function minePrs(session: CanonicalSession, det: DeterministicFields): Promise<string[]> {
  const found = new Set<string>(det.prs_referenced_mined);

  // Fallback: if a `git push` happened but no PR URL captured, query gh
  const sawPush = session.events.some(ev =>
    ev.type === "tool_use" && /^git push/.test((ev as any).input_summary)
  );
  if (sawPush && found.size === 0 && session.repo) {
    try {
      const { stdout } = await execFileAsync("gh", [
        "pr", "list", "--head", session.branch ?? "HEAD",
        "--state", "all", "--limit", "1",
        "--json", "url",
      ], { cwd: getLocalPathForRepo(session.repo) });
      const arr = JSON.parse(stdout);
      if (arr[0]?.url) {
        // Validate canonical match (REQ-028)
        const m = arr[0].url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull/);
        if (m && m[1].toLowerCase() === session.repo.replace(/^github\.com\//, "")) {
          found.add(arr[0].url);
        }
      }
    } catch {/* gh not installed or no PR */}
  }
  return [...found];
}
```

## Server: /api/sessions/<id>/summary

```ts
// routes/sessions.ts
sessionsRouter.post("/:id/summary", requireAuth, async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("id");
  const body = await SummaryBody.parseAsync(await c.req.json());

  const sess = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), eq(sessions.userId, user.id))
  });
  if (!sess) return c.text("session not found", 404);

  // Redact (defense in depth)
  body.title = redactDeep(body.title);
  body.summary = redactDeep(body.summary);

  await db.transaction(async (tx) => {
    await tx.insert(summaries).values({
      sessionId,
      title: body.title,
      summary: body.summary,
      tags: body.tags,
      filesTouched: body.files_touched,
      prsReferenced: body.prs_referenced,
      toolCallCounts: body.tool_call_counts,
      generatedAt: body.generated_at,
      model: body.model,
      status: body.status,
      error: body.error,
    }).onConflictDoUpdate({ target: summaries.sessionId, set: { /* ... */ } });

    if (body.status === "ok") {
      // INLINE EMBEDDING (REQ-038)
      const embedText = [body.title, body.summary, body.tags.join(" "), body.files_touched.join(" ")].join(" ");
      const vector = await embed(embedText);
      await tx.insert(embeddings).values({
        sessionId,
        embedding: vector,
        embeddingModel: getEmbedProvider().name,
        version: 1,
      }).onConflictDoUpdate({ target: embeddings.sessionId, set: { embedding: vector, embeddingModel: getEmbedProvider().name } });
    }
  });

  return c.json({ ok: true });
});
```

## Server: /api/sessions/<id>/blob (PUT and GET)

```ts
sessionsRouter.put("/:id/blob", requireAuth, async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("id");
  const sess = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), eq(sessions.userId, user.id))
  });
  if (!sess) return c.text("session not found", 404);

  const body = await c.req.arrayBuffer();
  if (body.byteLength > 100 * 1024 * 1024) return c.text("blob too large", 413);

  await db.transaction(async (tx) => {
    await tx.insert(sessionBlobs).values({
      sessionId,
      jsonlBytes: Buffer.from(body),
      byteSize: body.byteLength,
    }).onConflictDoUpdate({
      target: sessionBlobs.sessionId,
      set: { jsonlBytes: Buffer.from(body), byteSize: body.byteLength, uploadedAt: sql`now()` },
    });
    await tx.update(sessions).set({ hasBlob: true }).where(eq(sessions.id, sessionId));
  });
  return c.json({ ok: true, byte_size: body.byteLength });
});

sessionsRouter.get("/:id/blob", requireAuth, async (c) => {
  // RBAC: same as session read
  const user = c.get("user");
  const blob = await db.query.sessionBlobs.findFirst({
    where: eq(sessionBlobs.sessionId, c.req.param("id")),
    with: { session: true }
  });
  if (!blob || !canRead(user, blob.session)) return c.text("not found", 404);

  // Audit log read
  await db.insert(auditLog).values({ actorUserId: user.id, action: "read_blob", targetSessionId: c.req.param("id") });

  return new Response(blob.jsonlBytes, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-length": String(blob.byteSize),
    }
  });
});
```

## Embedding provider

```ts
// embed/index.ts
export interface EmbedProvider { name: string; embed(text: string): Promise<number[]> }

export function getEmbedProvider(): EmbedProvider {
  switch (process.env.EMBED_PROVIDER ?? "openai") {
    case "openai": return openaiProvider();
    case "bge":    return bgeProvider();
    default: throw new Error("EMBED_PROVIDER must be openai or bge");
  }
}

// embed/openai.ts — uses OpenAI SDK; model "text-embedding-3-small" (1536 dims)
// embed/bge.ts — onnxruntime-node + bge-small-en-v1.5; runs CPU; 384 dims (pad/project to 1536, or change schema)
```

NOTE: If using `bge-small-en-v1.5` the dim is 384 not 1536. Either:
- Change schema to `vector(384)` (cleanest if you only ever use bge)
- Project up to 1536 with a fixed random matrix (not great)
- Use `bge-large-en-v1.5` (1024 dims)
- Keep dim flexible: `vector(1536)` allowing zero-padding

For v0, **default to OpenAI 1536, fail loudly if EMBED_PROVIDER=bge with dim mismatch**, and document the schema-change requirement for bge users in the README.

## Tests

- **REQ-016**: append events, advance fake timers 60s, summarizer fires
- **REQ-017**: mock `runClaude` returning valid JSON; assert summary row populated, tool_call_counts comes from deterministic
- **REQ-018**: mock `runClaude` throwing 3× then succeeding; assert success on attempt 4
- **REQ-019**: enqueue 10 sessions; assert max 2 concurrent
- **REQ-026/027/028**: fixture sessions with various PR scenarios
- **REQ-038**: POST summary; assert embedding row created within request response
- **REQ-061/062**: PUT blob then GET blob → byte-for-byte equal
- **EDGE-004**: synthetic 1M-token session → prompt has truncation marker
- **EDGE-013**: session ending mid-tool → summarizer still runs, marks "interrupted" implicitly via deterministic tool count

## Done When

- [ ] All tests pass
- [ ] Manually: end a session → CLI summarizes → server has summary + embedding + blob
- [ ] `pgvector cosine` query returns the right session for a sample query (smoke test for phase 5)

## Commit

`feat: summarizer + blob upload + inline embedding (phase 4)`
