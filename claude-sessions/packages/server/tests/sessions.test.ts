// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import {
  events,
  auditLog,
  embeddings,
  sessionBlobs,
  sessions,
  summaries,
} from "../src/db/schema.js";
import { resetEmbedProvider } from "../src/embed/index.js";
import type { Env } from "../src/env.js";
import { type TestPgHandle, startTestPostgres, truncateAll } from "./helpers/pg-test-container.js";
import { seedUser } from "./helpers/seed.js";

const TEST_ENV: Env = {
  DATABASE_URL: "",
  JWT_SECRET: "test-secret-test-secret-test",
  EMBED_PROVIDER: "fake",
  OPENAI_EMBED_MODEL: "text-embedding-3-small",
  PORT: 0,
  NODE_ENV: "test",
};

let pg: TestPgHandle;
let db: Db;
let app: Hono;
let env: Env;

const insertSession = async (sessionId: string, userId: string, repoId: string): Promise<void> => {
  await db.db.insert(sessions).values({
    id: sessionId,
    userId,
    repoId,
    agent: "claude-code",
    agentVersion: "1.0.0",
    branch: "main",
    sourceCwdHint: "/tmp/work",
    model: "claude-3-5-sonnet",
    permissionMode: "default",
    startedAt: new Date("2026-05-01T10:00:00.000Z"),
    endedAt: new Date("2026-05-01T10:30:00.000Z"),
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: "0.01",
  });
};

beforeAll(async () => {
  process.env.EMBED_PROVIDER = "fake";
  resetEmbedProvider();
  pg = await startTestPostgres();
  db = pg.db;
  env = { ...TEST_ENV, DATABASE_URL: pg.url };
  app = buildApp(db.db, env);
}, 180_000);

afterAll(async () => {
  await pg.stop();
  resetEmbedProvider();
});

beforeEach(async () => {
  await truncateAll(db);
});

const post = async (path: string, token: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const put = async (path: string, token: string, bytes: Uint8Array): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${token}`,
    },
    body: bytes,
  });

const get = async (path: string, token: string): Promise<Response> =>
  app.request(path, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });

const buildSummaryBody = (sessionId: string): Record<string, unknown> => ({
  session_id: sessionId,
  title: "Phase 4 summarizer wiring",
  summary:
    "Wired the CLI summarizer to detect session-end and POST the result to the server, which generates an embedding inline. The server upserts the summary row alongside the embedding row in a single transaction so search is immediately consistent. PR mining mines URLs from gh pr create / git push tool outputs and falls back to gh pr list.",
  tags: ["phase-4", "summarizer", "embedding"],
  files_touched: [
    "packages/cli/src/summarizer/pipeline.ts",
    "packages/server/src/routes/sessions.ts",
  ],
  prs_referenced: [],
  tool_call_counts: { Bash: 3, Read: 7, Write: 2 },
  generated_at: "2026-05-09T12:00:00.000Z",
  model: "sonnet",
  status: "ok",
});

describe("POST /api/sessions/:id/summary", () => {
  it("REQ-038: stores summary AND embedding inline before responding 200", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-1@example.test",
      repoUrl: "github.com/example/summary-1",
    });
    const sessionId = "session-summary-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const res = await post(
      `/api/sessions/${sessionId}/summary`,
      seed.token,
      buildSummaryBody(sessionId),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; embedded: boolean };
    expect(json.ok).toBe(true);
    expect(json.embedded).toBe(true);

    // Both rows must exist by the time the response is returned.
    const summaryRows = await db.db
      .select()
      .from(summaries)
      .where(eq(summaries.sessionId, sessionId));
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]?.status).toBe("ok");
    expect(summaryRows[0]?.title).toBe("Phase 4 summarizer wiring");
    expect(summaryRows[0]?.tags).toEqual(["phase-4", "summarizer", "embedding"]);

    const embedRows = await db.db
      .select()
      .from(embeddings)
      .where(eq(embeddings.sessionId, sessionId));
    expect(embedRows).toHaveLength(1);
    const vec = embedRows[0]?.embedding ?? [];
    expect(vec).toHaveLength(1536);
    const sumSq = vec.reduce((acc, v) => acc + v * v, 0);
    expect(sumSq).toBeGreaterThan(0);
  });

  it("redacts secrets in title and summary (defense-in-depth REQ-034)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-redact@example.test",
      repoUrl: "github.com/example/summary-redact",
    });
    const sessionId = "session-summary-redact";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.title = "leaked AKIA0123456789ABCDEF in the title";
    body.summary = "no secret here, but consider AKIA9876543210FEDCBA happened.";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);

    const row = (await db.db.select().from(summaries).where(eq(summaries.sessionId, sessionId)))[0];
    expect(row?.title).not.toContain("AKIA0123456789ABCDEF");
    expect(row?.title).toContain("[REDACTED:");
    expect(row?.summary).not.toContain("AKIA9876543210FEDCBA");
    expect(row?.summary).toContain("[REDACTED:");
  });

  it("404 when the session does not exist for this user", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-404@example.test",
      repoUrl: "github.com/example/summary-404",
    });
    const res = await post(
      "/api/sessions/missing-session/summary",
      seed.token,
      buildSummaryBody("missing-session"),
    );
    expect(res.status).toBe(404);
  });

  it("skips embedding generation when status='failed'", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-failed@example.test",
      repoUrl: "github.com/example/summary-failed",
    });
    const sessionId = "session-summary-failed";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.status = "failed";
    body.error = "claude binary returned rc=1";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { embedded: boolean };
    expect(json.embedded).toBe(false);

    const embedRows = await db.db
      .select()
      .from(embeddings)
      .where(eq(embeddings.sessionId, sessionId));
    expect(embedRows).toHaveLength(0);
  });
});

describe("PUT /api/sessions/:id/blob (REQ-061) and GET (REQ-062)", () => {
  it("byte-for-byte round-trip via PUT then GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-rt@example.test",
      repoUrl: "github.com/example/blob-rt",
    });
    const sessionId = "session-blob-rt";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const ndjson = [
      JSON.stringify({ type: "user", uuid: "1", text: "hello" }),
      JSON.stringify({ type: "assistant", uuid: "2", text: "hi" }),
      "",
    ].join("\n");
    const original = new TextEncoder().encode(ndjson);

    const putRes = await put(`/api/sessions/${sessionId}/blob`, seed.token, original);
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { ok: boolean; byte_size: number };
    expect(putJson.byte_size).toBe(original.byteLength);

    // sessions.has_blob flipped
    const sessRow = await db.db
      .select({ hasBlob: sessions.hasBlob })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessRow[0]?.hasBlob).toBe(true);

    const getRes = await get(`/api/sessions/${sessionId}/blob`, seed.token);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("application/x-ndjson");
    expect(getRes.headers.get("content-length")).toBe(String(original.byteLength));
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(got.byteLength).toBe(original.byteLength);
    expect(Buffer.from(got).equals(Buffer.from(original))).toBe(true);
  });

  it("RBAC: another user cannot GET the blob (returns 404)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-rbac-a@example.test",
      repoUrl: "github.com/example/blob-rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-rbac-b@example.test",
      repoUrl: "github.com/example/blob-rbac-b",
    });
    const sessionId = "session-blob-rbac";
    await insertSession(sessionId, a.user.id, a.repoId);
    await put(
      `/api/sessions/${sessionId}/blob`,
      a.token,
      new TextEncoder().encode("private bytes\n"),
    );

    const res = await get(`/api/sessions/${sessionId}/blob`, b.token);
    expect(res.status).toBe(404);
  });

  it("audit_log row written on GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-audit@example.test",
      repoUrl: "github.com/example/blob-audit",
    });
    const sessionId = "session-blob-audit";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await put(
      `/api/sessions/${sessionId}/blob`,
      seed.token,
      new TextEncoder().encode("audit me\n"),
    );

    const before = await db.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(before.length).toBe(0);

    const res = await get(`/api/sessions/${sessionId}/blob`, seed.token);
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const after = await db.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(after.length).toBe(1);
    expect(after[0]?.action).toBe("read_blob");
  });

  it("PUT then re-PUT replaces the bytes (idempotent overwrite)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-overwrite@example.test",
      repoUrl: "github.com/example/blob-overwrite",
    });
    const sessionId = "session-blob-overwrite";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const v1 = new TextEncoder().encode("v1 content\n");
    const v2 = new TextEncoder().encode("v2 different and longer content here\n");
    await put(`/api/sessions/${sessionId}/blob`, seed.token, v1);
    await put(`/api/sessions/${sessionId}/blob`, seed.token, v2);

    const got = new Uint8Array(
      await (await get(`/api/sessions/${sessionId}/blob`, seed.token)).arrayBuffer(),
    );
    expect(Buffer.from(got).toString("utf8")).toBe("v2 different and longer content here\n");
  });
});

const patch = async (path: string, token: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("GET /api/sessions/:id (REQ-036, REQ-059)", () => {
  it("returns session metadata + summary with display_name resolution", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "get-meta@example.test",
      repoUrl: "github.com/example/get-meta",
    });
    const sessionId = "session-get-meta";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    // Seed a summary with title only — no user-set name yet.
    await db.db.insert(summaries).values({
      sessionId,
      title: "auto-generated title",
      summary: "summary body",
      tags: ["a"],
      filesTouched: ["x.ts"],
      prsReferenced: [],
      toolCallCounts: { Bash: 1 },
      generatedAt: new Date(),
      model: "sonnet",
      status: "ok",
    });

    const r1 = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { display_name: string; summary: { title: string } };
    expect(j1.display_name).toBe("auto-generated title");
    expect(j1.summary?.title).toBe("auto-generated title");

    // Set a user-set name → should win over title.
    await patch(`/api/sessions/${sessionId}`, seed.token, { name: "user override" });
    const r2 = await get(`/api/sessions/${sessionId}`, seed.token);
    const j2 = (await r2.json()) as { display_name: string; name: string | null };
    expect(j2.display_name).toBe("user override");
    expect(j2.name).toBe("user override");

    // Clear name → falls back to title.
    await patch(`/api/sessions/${sessionId}`, seed.token, { name: null });
    const r3 = await get(`/api/sessions/${sessionId}`, seed.token);
    const j3 = (await r3.json()) as { display_name: string; name: string | null };
    expect(j3.name).toBeNull();
    expect(j3.display_name).toBe("auto-generated title");
  });

  it("REQ-059: display_name falls back to `Session <prefix>` when neither name nor title exist", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "fallback@example.test",
      repoUrl: "github.com/example/fallback",
    });
    const sessionId = "abcd1234-fallback";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    const j = (await r.json()) as { display_name: string };
    expect(j.display_name).toBe(`Session ${sessionId.slice(0, 8)}`);
  });

  it("REQ-036: GET writes one audit_log row with action=read_session", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "audit-get@example.test",
      repoUrl: "github.com/example/audit-get",
    });
    const sessionId = "session-audit-get";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const before = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(before.length).toBe(0);
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r.status).toBe(200);
    const after = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(after.length).toBe(1);
    expect(after[0]?.action).toBe("read_session");
  });

  it("404 for another user's session (RBAC)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "rbac-a@example.test",
      repoUrl: "github.com/example/rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "rbac-b@example.test",
      repoUrl: "github.com/example/rbac-b",
    });
    const sessionId = "session-rbac-cross";
    await insertSession(sessionId, a.user.id, a.repoId);
    const r = await get(`/api/sessions/${sessionId}`, b.token);
    expect(r.status).toBe(404);
  });
});

describe("PATCH /api/sessions/:id name (REQ-059, REQ-060)", () => {
  it("sets and clears name", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "name@example.test",
      repoUrl: "github.com/example/name",
    });
    const sessionId = "session-name-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const r1 = await patch(`/api/sessions/${sessionId}`, seed.token, { name: "my fork" });
    expect(r1.status).toBe(200);
    const row1 = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row1?.name).toBe("my fork");

    const r2 = await patch(`/api/sessions/${sessionId}`, seed.token, { name: null });
    expect(r2.status).toBe(200);
    const row2 = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row2?.name).toBeNull();
  });

  it("400 with no fields", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-empty@example.test",
      repoUrl: "github.com/example/patch-empty",
    });
    const sessionId = "session-patch-empty";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const r = await patch(`/api/sessions/${sessionId}`, seed.token, {});
    expect(r.status).toBe(400);
  });

  it("404 for another user's session (RBAC)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-rbac-a@example.test",
      repoUrl: "github.com/example/patch-rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-rbac-b@example.test",
      repoUrl: "github.com/example/patch-rbac-b",
    });
    const sessionId = "session-patch-rbac";
    await insertSession(sessionId, a.user.id, a.repoId);
    const r = await patch(`/api/sessions/${sessionId}`, b.token, { name: "intruder" });
    expect(r.status).toBe(404);
  });
});

describe("PATCH /api/sessions/:id privacy (REQ-039, EDGE-018)", () => {
  it("is_private=true cascades: deletes events/summary/embedding/blob and keeps sessions row", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "priv@example.test",
      repoUrl: "github.com/example/priv",
    });
    const sessionId = "session-priv-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    // Seed events, summary, embedding, blob.
    await db.db.insert(events).values({
      sessionId,
      eventUuid: "ev-1",
      parentUuid: null,
      ts: new Date(),
      type: "user_msg",
      payload: { text: "secret" },
    });
    await db.db.insert(summaries).values({
      sessionId,
      title: "t",
      summary: "s",
      tags: [],
      filesTouched: [],
      prsReferenced: [],
      toolCallCounts: {},
      generatedAt: new Date(),
      model: "sonnet",
      status: "ok",
    });
    await db.db.insert(embeddings).values({
      sessionId,
      embedding: new Array(1536).fill(0.01),
      embeddingModel: "fake",
      version: 1,
    });
    await db.db.insert(sessionBlobs).values({
      sessionId,
      jsonlBytes: Buffer.from("hello\n"),
      byteSize: 6,
    });

    const r = await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    expect(r.status).toBe(200);

    const sessRow = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(sessRow?.isPrivate).toBe(true);
    expect(sessRow?.hasBlob).toBe(false);

    expect(await db.db.select().from(events).where(eq(events.sessionId, sessionId))).toHaveLength(
      0,
    );
    expect(
      await db.db.select().from(summaries).where(eq(summaries.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await db.db.select().from(embeddings).where(eq(embeddings.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await db.db.select().from(sessionBlobs).where(eq(sessionBlobs.sessionId, sessionId)),
    ).toHaveLength(0);

    // Audit log row.
    const audits = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("marked_private");
  });

  it("is_private=true session subsequently GETs as a placeholder (owner only)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "priv-get@example.test",
      repoUrl: "github.com/example/priv-get",
    });
    const sessionId = "session-priv-get";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { is_private: boolean; display_name: string };
    expect(j.is_private).toBe(true);
    expect(j.display_name).toBe("(private)");
  });

  it("is_private=false unsets the flag without recreating data", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "unpriv@example.test",
      repoUrl: "github.com/example/unpriv",
    });
    const sessionId = "session-unpriv";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    const r = await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: false });
    expect(r.status).toBe(200);
    const row = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row?.isPrivate).toBe(false);
  });
});

describe("disable + purge cascade (REQ-037)", () => {
  it("POST /api/repos/disable with purge:true cascades all sessions/events/summaries/blobs for user+repo", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "purge@example.test",
      repoUrl: "github.com/example/purge",
    });
    const s1 = "purge-session-1";
    const s2 = "purge-session-2";
    await insertSession(s1, seed.user.id, seed.repoId);
    await insertSession(s2, seed.user.id, seed.repoId);
    await db.db.insert(events).values([
      {
        sessionId: s1,
        eventUuid: "p1-1",
        parentUuid: null,
        ts: new Date(),
        type: "user_msg",
        payload: {},
      },
      {
        sessionId: s2,
        eventUuid: "p2-1",
        parentUuid: null,
        ts: new Date(),
        type: "user_msg",
        payload: {},
      },
    ]);
    await db.db.insert(sessionBlobs).values([
      { sessionId: s1, jsonlBytes: Buffer.from("a"), byteSize: 1 },
      { sessionId: s2, jsonlBytes: Buffer.from("b"), byteSize: 1 },
    ]);

    const start = Date.now();
    const r = await app.request("/api/repos/disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${seed.token}`,
      },
      body: JSON.stringify({ canonical_url: seed.repoCanonical, purge: true }),
    });
    expect(r.status).toBe(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60_000);

    const remaining = await db.db.select().from(sessions).where(eq(sessions.userId, seed.user.id));
    expect(remaining).toHaveLength(0);
    // Cascade also removed events + blobs.
    expect(await db.db.select().from(events).where(eq(events.sessionId, s1))).toHaveLength(0);
    expect(await db.db.select().from(events).where(eq(events.sessionId, s2))).toHaveLength(0);
    expect(
      await db.db.select().from(sessionBlobs).where(eq(sessionBlobs.sessionId, s1)),
    ).toHaveLength(0);
  });
});
