// AI-generated. See PROMPT.md for the prompts and model used.

import { canonicalizeRepo } from "@claude-sessions/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { findUserRepoAccess, grantUserRepo, revokeUserRepo, upsertRepo } from "../db/repos.js";
import { repos, sessions, summaries, userRepos } from "../db/schema.js";
import type { Env } from "../env.js";

const enableSchema = z.object({
  canonical_url: z.string().min(1),
  local_path: z.string().optional(),
});

const disableSchema = z.object({
  canonical_url: z.string().min(1),
  purge: z.boolean().optional().default(false),
});

export const buildReposRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  /**
   * GET /api/repos — list every enabled repo for the calling user with
   * a session count and last-activity timestamp. Drives the Home grid.
   */
  router.get("/", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({
        id: repos.id,
        canonicalUrl: repos.canonicalUrl,
        displayName: repos.displayName,
        access: userRepos.access,
        sessionCount: sql<number>`coalesce(count(${sessions.id})::int, 0)`,
        lastActivity: sql<Date | null>`max(${sessions.startedAt})`,
      })
      .from(userRepos)
      .innerJoin(repos, eq(repos.id, userRepos.repoId))
      .leftJoin(sessions, and(eq(sessions.repoId, repos.id), eq(sessions.userId, user.id)))
      .where(eq(userRepos.userId, user.id))
      .groupBy(repos.id, userRepos.access)
      .orderBy(desc(sql`max(${sessions.startedAt})`));

    return c.json({
      repos: rows.map((r) => ({
        id: r.id,
        canonical_url: r.canonicalUrl,
        display_name: r.displayName,
        access: r.access,
        session_count: r.sessionCount ?? 0,
        last_activity: r.lastActivity ? r.lastActivity.toISOString() : null,
      })),
    });
  });

  /**
   * GET /api/repos/:canonical/sessions — list sessions for a single repo,
   * newest first. `:canonical` is URL-encoded canonical_url.
   */
  router.get("/:canonical/sessions", async (c) => {
    const user = c.get("user");
    const canonical = decodeURIComponent(c.req.param("canonical"));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

    const repoRow = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.canonicalUrl, canonical))
      .limit(1);
    if (!repoRow[0]) return c.json({ repo: null, sessions: [] }, 404);

    const access = await findUserRepoAccess(db, user.id, repoRow[0].id);
    if (!access) return c.json({ error: "forbidden" }, 403);

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
        title: summaries.title,
        summary: summaries.summary,
        tags: summaries.tags,
        prsReferenced: summaries.prsReferenced,
      })
      .from(sessions)
      .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
      .where(and(eq(sessions.userId, user.id), eq(sessions.repoId, repoRow[0].id)))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);

    return c.json({
      repo: { canonical_url: canonical },
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
        title: r.title ?? null,
        summary: r.summary ?? null,
        tags: r.tags ?? [],
        prs_referenced: r.prsReferenced ?? [],
        display_name: r.name ?? r.title ?? `Session ${r.id.slice(0, 8)}`,
      })),
    });
  });

  router.post("/enable", async (c) => {
    const user = c.get("user");
    const parsed = enableSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const repo = await upsertRepo(db, parsed.data.canonical_url);
    await grantUserRepo(db, user.id, repo.id, "owner");
    return c.json({
      ok: true,
      repo: { id: repo.id, canonical_url: repo.canonicalUrl },
    });
  });

  router.post("/disable", async (c) => {
    const user = c.get("user");
    const parsed = disableSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const canonical = canonicalizeRepo(parsed.data.canonical_url);
    const repo = await upsertRepo(db, canonical);
    const access = await findUserRepoAccess(db, user.id, repo.id);
    if (!access) return c.json({ ok: true, removed: false });
    await revokeUserRepo(db, user.id, repo.id);
    let purgedSessions = 0;
    if (parsed.data.purge) {
      const deleted = await db
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), eq(sessions.repoId, repo.id)))
        .returning({ id: sessions.id });
      purgedSessions = deleted.length;
    }
    return c.json({ ok: true, removed: true, purged_sessions: purgedSessions });
  });

  return router;
};
