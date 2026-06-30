// AI-generated. See PROMPT.md for the prompts and model used.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { events, embeddings, repos, sessionBlobs, sessions, summaries } from "../db/schema.js";
import { getEmbedProvider } from "../embed/index.js";
import type { Env } from "../env.js";
import { writeAudit } from "../lib/audit.js";
import { redactDeep } from "../redact.js";

const summarySchema = z.object({
  session_id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  files_touched: z.array(z.string()),
  prs_referenced: z.array(z.string()),
  tool_call_counts: z.record(z.number().int().nonnegative()),
  generated_at: z.string().datetime(),
  model: z.string(),
  status: z.enum(["pending", "ok", "failed"]),
  error: z.string().optional(),
});

const patchSchema = z.object({
  name: z.string().nullable().optional(),
  is_private: z.boolean().optional(),
});

const MAX_BLOB_BYTES = 100 * 1024 * 1024;

const ensureString = (s: unknown): string => (typeof s === "string" ? s : "");

const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  repo: z.string().optional(),
  branch: z.string().optional(),
  agent: z.string().optional(),
});

export const buildSessionsRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  /**
   * GET /api/sessions — recent sessions for the user across all enabled repos.
   * Used by the web Home / Recent feed. Owner-only (sessions.user_id = user.id).
   */
  router.get("/", async (c) => {
    const user = c.get("user");
    const raw = Object.fromEntries(new URL(c.req.url).searchParams);
    const parsed = recentQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const params = parsed.data;

    const filters = [eq(sessions.userId, user.id)];
    if (params.agent) filters.push(eq(sessions.agent, params.agent));
    if (params.branch) filters.push(eq(sessions.branch, params.branch));
    if (params.repo) {
      const r = await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.canonicalUrl, params.repo))
        .limit(1);
      if (!r[0]) return c.json({ sessions: [] });
      filters.push(eq(sessions.repoId, r[0].id));
    }

    const rows = await db
      .select({
        id: sessions.id,
        agent: sessions.agent,
        branch: sessions.branch,
        model: sessions.model,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        totalCostUsd: sessions.totalCostUsd,
        isPrivate: sessions.isPrivate,
        name: sessions.name,
        repoCanonicalUrl: repos.canonicalUrl,
        title: summaries.title,
        summary: summaries.summary,
        tags: summaries.tags,
        prsReferenced: summaries.prsReferenced,
      })
      .from(sessions)
      .leftJoin(repos, eq(repos.id, sessions.repoId))
      .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
      .where(and(...filters))
      .orderBy(desc(sessions.startedAt))
      .limit(params.limit);

    return c.json({
      sessions: rows.map((r) => ({
        id: r.id,
        agent: r.agent,
        branch: r.branch,
        model: r.model,
        started_at: r.startedAt.toISOString(),
        ended_at: r.endedAt.toISOString(),
        total_cost_usd: r.totalCostUsd,
        is_private: r.isPrivate,
        name: r.name,
        repo: r.repoCanonicalUrl,
        title: r.title ?? null,
        summary: r.summary ?? null,
        tags: r.tags ?? [],
        prs_referenced: r.prsReferenced ?? [],
        display_name: r.name ?? r.title ?? `Session ${r.id.slice(0, 8)}`,
      })),
    });
  });

  /**
   * GET /api/sessions/:id/events — return the canonical event stream for a
   * session in chronological order. Owner-only RBAC. Used by the transcript
   * view on the web UI.
   */
  router.get("/:id/events", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ events: [] });

    const rows = await db
      .select({
        eventUuid: events.eventUuid,
        parentUuid: events.parentUuid,
        ts: events.ts,
        type: events.type,
        payload: events.payload,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.ts));

    return c.json({
      events: rows.map((r) => ({
        event_uuid: r.eventUuid,
        parent_uuid: r.parentUuid,
        ts: r.ts.toISOString(),
        type: r.type,
        payload: r.payload,
      })),
    });
  });

  /**
   * POST /api/sessions/:id/summary — store the LLM summary AND the inline
   * embedding in one transaction (REQ-038). Defense-in-depth redaction is
   * applied to title and summary before they hit the table.
   */
  router.post("/:id/summary", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const parsed = summarySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    if (body.session_id !== sessionId) {
      return c.json({ error: "session_id mismatch" }, 400);
    }

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const safeTitle = ensureString(redactDeep(body.title));
    const safeSummary = ensureString(redactDeep(body.summary));

    const provider = getEmbedProvider();
    let vector: number[] | null = null;
    if (body.status === "ok") {
      const embedText = [safeTitle, safeSummary, body.tags.join(" "), body.files_touched.join(" ")]
        .filter((s) => s.length > 0)
        .join(" ");
      vector = await provider.embed(embedText);
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(summaries)
        .values({
          sessionId,
          title: safeTitle,
          summary: safeSummary,
          tags: body.tags,
          filesTouched: body.files_touched,
          prsReferenced: body.prs_referenced,
          toolCallCounts: body.tool_call_counts,
          generatedAt: new Date(body.generated_at),
          model: body.model,
          status: body.status,
          error: body.error ?? null,
        })
        .onConflictDoUpdate({
          target: summaries.sessionId,
          set: {
            title: safeTitle,
            summary: safeSummary,
            tags: body.tags,
            filesTouched: body.files_touched,
            prsReferenced: body.prs_referenced,
            toolCallCounts: body.tool_call_counts,
            generatedAt: new Date(body.generated_at),
            model: body.model,
            status: body.status,
            error: body.error ?? null,
          },
        });

      if (vector) {
        await tx
          .insert(embeddings)
          .values({
            sessionId,
            embedding: vector,
            embeddingModel: provider.name,
            version: 1,
          })
          .onConflictDoUpdate({
            target: embeddings.sessionId,
            set: { embedding: vector, embeddingModel: provider.name },
          });
      }
    });

    return c.json({ ok: true, embedded: vector !== null });
  });

  /**
   * PUT /api/sessions/:id/blob — store the raw NDJSON bytes. Limit 100MB
   * (REQ-061). Body is consumed as `arrayBuffer` so this works for any
   * `application/x-ndjson` upload.
   */
  router.put("/:id/blob", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BLOB_BYTES) {
      return c.json({ error: "blob too large" }, 413);
    }
    const bytes = Buffer.from(body);

    await db.transaction(async (tx) => {
      await tx
        .insert(sessionBlobs)
        .values({ sessionId, jsonlBytes: bytes, byteSize: bytes.byteLength })
        .onConflictDoUpdate({
          target: sessionBlobs.sessionId,
          set: {
            jsonlBytes: bytes,
            byteSize: bytes.byteLength,
            uploadedAt: sql`now()`,
          },
        });
      await tx.update(sessions).set({ hasBlob: true }).where(eq(sessions.id, sessionId));
    });
    return c.json({ ok: true, byte_size: bytes.byteLength });
  });

  /**
   * GET /api/sessions/:id/blob — return the original NDJSON bytes
   * byte-for-byte (REQ-062). Writes an audit_log row before responding
   * (REQ-036 generalized to blob reads).
   */
  router.get("/:id/blob", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const blobRows = await db
      .select({
        jsonlBytes: sessionBlobs.jsonlBytes,
        byteSize: sessionBlobs.byteSize,
      })
      .from(sessionBlobs)
      .where(eq(sessionBlobs.sessionId, sessionId))
      .limit(1);
    const blob = blobRows[0];
    if (!blob) return c.json({ error: "blob not found" }, 404);

    await writeAudit(db, c, "read_blob", sessionId);

    const bytes = blob.jsonlBytes;
    // Drizzle's `bytea` custom type returns a Node Buffer; copy into a
    // plain Uint8Array so `Response` doesn't see a SharedArrayBuffer or
    // a slice of the postgres driver's pool buffer.
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "content-length": String(blob.byteSize),
      },
    });
  });

  /**
   * GET /api/sessions/:id — return session metadata + summary, resolved
   * `display_name` (user-set name → LLM title → `Session <prefix>`), and
   * the `is_private` flag. Owner-only RBAC. Writes an audit_log row
   * before responding (REQ-036).
   */
  router.get("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");

    const rows = await db
      .select({
        session: sessions,
        repoCanonicalUrl: repos.canonicalUrl,
      })
      .from(sessions)
      .leftJoin(repos, eq(repos.id, sessions.repoId))
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "session not found" }, 404);
    const sess = row.session;

    if (sess.isPrivate) {
      await writeAudit(db, c, "read_session", sessionId);
      return c.json({
        id: sess.id,
        is_private: true,
        display_name: "(private)",
      });
    }

    const summaryRows = await db
      .select()
      .from(summaries)
      .where(eq(summaries.sessionId, sessionId))
      .limit(1);
    const summary = summaryRows[0] ?? null;

    const displayName = sess.name ?? summary?.title ?? `Session ${sess.id.slice(0, 8)}`;

    await writeAudit(db, c, "read_session", sessionId);

    return c.json({
      id: sess.id,
      agent: sess.agent,
      agent_version: sess.agentVersion,
      repo_id: sess.repoId,
      repo: row.repoCanonicalUrl
        ? { canonical_url: row.repoCanonicalUrl, branch: sess.branch }
        : null,
      branch: sess.branch,
      source_cwd_hint: sess.sourceCwdHint,
      model: sess.model,
      started_at: sess.startedAt.toISOString(),
      ended_at: sess.endedAt.toISOString(),
      total_input_tokens: sess.totalInputTokens,
      total_output_tokens: sess.totalOutputTokens,
      total_cost_usd: sess.totalCostUsd,
      permission_mode: sess.permissionMode,
      is_private: sess.isPrivate,
      name: sess.name,
      has_blob: sess.hasBlob,
      display_name: displayName,
      summary: summary
        ? {
            title: summary.title,
            summary: summary.summary,
            tags: summary.tags,
            files_touched: summary.filesTouched,
            prs_referenced: summary.prsReferenced,
            tool_call_counts: summary.toolCallCounts,
            status: summary.status,
          }
        : null,
    });
  });

  /**
   * PATCH /api/sessions/:id — update `name` and/or `is_private`. Owner-only.
   *
   * `is_private: true` triggers a hard scrub: events, summary, embedding,
   * and blob rows are deleted; only the `sessions` row remains so audit
   * entries continue to FK-resolve. We always write an audit_log row
   * (`marked_private` for the privacy flip, `renamed` for name changes).
   */
  router.patch("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");

    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    if (body.name === undefined && body.is_private === undefined) {
      return c.json({ error: "no fields to update" }, 400);
    }

    const rows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    const sess = rows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);

    await db.transaction(async (tx) => {
      if (body.name !== undefined) {
        await tx
          .update(sessions)
          .set({ name: body.name, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      }
      if (body.is_private === true) {
        await tx.delete(events).where(eq(events.sessionId, sessionId));
        await tx.delete(summaries).where(eq(summaries.sessionId, sessionId));
        await tx.delete(embeddings).where(eq(embeddings.sessionId, sessionId));
        await tx.delete(sessionBlobs).where(eq(sessionBlobs.sessionId, sessionId));
        await tx
          .update(sessions)
          .set({ isPrivate: true, hasBlob: false, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      } else if (body.is_private === false) {
        await tx
          .update(sessions)
          .set({ isPrivate: false, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      }
    });

    if (body.is_private === true) {
      await writeAudit(db, c, "marked_private", sessionId);
    } else if (body.is_private === false) {
      await writeAudit(db, c, "marked_public", sessionId);
    }
    if (body.name !== undefined) {
      await writeAudit(db, c, "renamed", sessionId, { name: body.name });
    }

    return c.json({ ok: true });
  });

  return router;
};
