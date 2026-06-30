// AI-generated. See PROMPT.md for the prompts and model used.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { auditLog, repos, sessions, summaries, userRepos } from "../db/schema.js";

export interface SessionDetail {
  session_id: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  files_touched: string[];
  prs_referenced: string[];
  repo: string | null;
  branch: string | null;
  agent: string;
  agent_version: string;
  model: string | null;
  started_at: string;
  ended_at: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: string;
  is_private: boolean;
  name: string | null;
}

const buildAccessibleRepoIds = async (db: DbClient, userId: string): Promise<string[]> => {
  const rows = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  return rows.map((r) => r.repoId);
};

const ensureRowAccess = async (
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<{
  ownerUserId: string;
  repoId: string | null;
} | null> => {
  const rows = await db
    .select({ ownerUserId: sessions.userId, repoId: sessions.repoId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.ownerUserId === userId) return row;
  if (!row.repoId) return null;
  const accessible = await buildAccessibleRepoIds(db, userId);
  if (accessible.includes(row.repoId)) return row;
  return null;
};

export const getSessionForUser = async (
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<SessionDetail | null> => {
  const access = await ensureRowAccess(db, userId, sessionId);
  if (!access) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      branch: sessions.branch,
      agent: sessions.agent,
      agentVersion: sessions.agentVersion,
      model: sessions.model,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      totalInputTokens: sessions.totalInputTokens,
      totalOutputTokens: sessions.totalOutputTokens,
      totalCostUsd: sessions.totalCostUsd,
      isPrivate: sessions.isPrivate,
      name: sessions.name,
      title: summaries.title,
      summary: summaries.summary,
      tags: summaries.tags,
      filesTouched: summaries.filesTouched,
      prsReferenced: summaries.prsReferenced,
      repoUrl: repos.canonicalUrl,
    })
    .from(sessions)
    .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
    .leftJoin(repos, eq(repos.id, sessions.repoId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  await db.insert(auditLog).values({
    actorUserId: userId,
    action: "read_session",
    targetSessionId: sessionId,
  });

  return {
    session_id: row.sessionId,
    title: row.title ?? null,
    summary: row.summary ?? null,
    tags: row.tags ?? [],
    files_touched: row.filesTouched ?? [],
    prs_referenced: row.prsReferenced ?? [],
    repo: row.repoUrl ?? null,
    branch: row.branch,
    agent: row.agent,
    agent_version: row.agentVersion,
    model: row.model,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt.toISOString(),
    total_input_tokens: row.totalInputTokens,
    total_output_tokens: row.totalOutputTokens,
    total_cost_usd: row.totalCostUsd,
    is_private: row.isPrivate,
    name: row.name,
  };
};

export const findSessionsForPr = async (
  db: DbClient,
  userId: string,
  prUrl: string,
): Promise<SessionDetail[]> => {
  const accessible = await buildAccessibleRepoIds(db, userId);
  if (accessible.length === 0) return [];

  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(summaries, eq(summaries.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.userId, userId),
        inArray(sessions.repoId, accessible),
        sql`${prUrl} = ANY(${summaries.prsReferenced})`,
      ),
    );

  const out: SessionDetail[] = [];
  for (const r of rows) {
    const detail = await getSessionForUser(db, userId, r.id);
    if (detail) out.push(detail);
  }
  return out;
};

export interface ListRecentOpts {
  limit?: number;
  agent?: string;
  repo?: string;
}

export const listRecent = async (
  db: DbClient,
  userId: string,
  opts: ListRecentOpts = {},
): Promise<SessionDetail[]> => {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const accessible = await buildAccessibleRepoIds(db, userId);
  if (accessible.length === 0) return [];

  const filters = [eq(sessions.userId, userId), inArray(sessions.repoId, accessible)];
  if (opts.agent) filters.push(eq(sessions.agent, opts.agent));
  if (opts.repo) {
    const repoRow = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.canonicalUrl, opts.repo))
      .limit(1);
    if (!repoRow[0]) return [];
    filters.push(eq(sessions.repoId, repoRow[0].id));
  }

  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(...filters))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);

  const out: SessionDetail[] = [];
  for (const r of rows) {
    const detail = await getSessionForUser(db, userId, r.id);
    if (detail) out.push(detail);
  }
  return out;
};

export const setSessionPrivate = async (
  db: DbClient,
  userId: string,
  sessionId: string,
  isPrivate: boolean,
): Promise<void> => {
  // Only the session owner can flip privacy.
  await db
    .update(sessions)
    .set({ isPrivate })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  await db.insert(auditLog).values({
    actorUserId: userId,
    action: isPrivate ? "mark_private" : "mark_public",
    targetSessionId: sessionId,
  });
};
