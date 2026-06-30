// AI-generated. See PROMPT.md for the prompts and model used.

import { type SQL, and, eq, gte, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { repos, sessions, summaries, userRepos } from "../db/schema.js";
import { getEmbedProvider } from "../embed/index.js";

export interface SearchFilters {
  repo?: string;
  branch?: string;
  agent?: string;
  hasPr?: boolean;
  since?: string;
  limit?: number;
}

export interface SearchResultRow {
  session_id: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  repo: string | null;
  branch: string | null;
  agent: string;
  started_at: string;
  ended_at: string;
  total_cost_usd: string;
}

export interface SearchResponse {
  results: SearchResultRow[];
  strategy: "rrf";
}

const RRF_K = 60;
const TOP_K = 50;

/**
 * Reciprocal Rank Fusion — combines ranked lists by summing 1/(k + rank + 1)
 * for each id present across lists. Stable order: ties break by insertion order.
 */
const reciprocalRankFusion = (
  rankedLists: ReadonlyArray<ReadonlyArray<{ id: string; rank: number }>>,
  k: number,
): Array<{ id: string; score: number }> => {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const { id, rank } of list) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
};

/**
 * Run hybrid Postgres FTS + pgvector cosine search, merge with RRF, hydrate
 * top-N with summary + repo metadata. Reused by HTTP and MCP entry points.
 */
export const searchInternal = async (
  db: DbClient,
  userId: string,
  query: string,
  filters: SearchFilters = {},
): Promise<SearchResponse> => {
  const limit = filters.limit ?? 20;
  const provider = getEmbedProvider();
  const qVec = await provider.embed(query);
  const qVecLiteral = `[${qVec.join(",")}]`;

  const accessibleRepos = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  const accessibleRepoIds = accessibleRepos.map((r) => r.repoId);

  if (accessibleRepoIds.length === 0) {
    return { results: [], strategy: "rrf" };
  }

  const baseFilters: SQL[] = [
    eq(sessions.userId, userId),
    inArray(sessions.repoId, accessibleRepoIds),
  ];
  if (filters.branch) baseFilters.push(eq(sessions.branch, filters.branch));
  if (filters.agent) baseFilters.push(eq(sessions.agent, filters.agent));
  if (filters.since) baseFilters.push(gte(sessions.startedAt, new Date(filters.since)));

  let repoIdForFilter: string | null = null;
  if (filters.repo) {
    const found = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.canonicalUrl, filters.repo))
      .limit(1);
    if (!found[0]) {
      return { results: [], strategy: "rrf" };
    }
    repoIdForFilter = found[0].id;
    baseFilters.push(eq(sessions.repoId, repoIdForFilter));
  }

  const filterSql = and(...baseFilters);

  // FTS top-K — weighted ts_rank over title + summary + tags.
  const ftsRows = await db
    .select({
      id: sessions.id,
      rank: sql<number>`ts_rank(summaries_fts_text(${summaries.title}, ${summaries.summary}, ${summaries.tags}), plainto_tsquery('english', ${query}))`,
    })
    .from(sessions)
    .innerJoin(summaries, eq(summaries.sessionId, sessions.id))
    .where(
      and(
        filterSql,
        sql`summaries_fts_text(${summaries.title}, ${summaries.summary}, ${summaries.tags}) @@ plainto_tsquery('english', ${query})`,
      ),
    )
    .orderBy(
      sql`ts_rank(summaries_fts_text(${summaries.title}, ${summaries.summary}, ${summaries.tags}), plainto_tsquery('english', ${query})) DESC`,
    )
    .limit(TOP_K);

  // Vector top-K — cosine distance via the <=> operator. We reuse the same
  // `filterSql` constructed from drizzle column refs (which qualify as
  // "sessions"."*"), so the FROM clause must use the unaliased table name.
  const vecRows = await db.execute(sql`
    SELECT sessions.id::text AS id
    FROM sessions
    JOIN embeddings ON embeddings.session_id = sessions.id
    WHERE ${filterSql}
    ORDER BY embeddings.embedding <=> ${qVecLiteral}::vector
    LIMIT ${TOP_K}
  `);

  const vecIds = (vecRows as unknown as Array<{ id: string }>).map((r, i) => ({
    id: r.id,
    rank: i,
  }));
  const ftsIds = ftsRows.map((r, i) => ({ id: r.id, rank: i }));

  const merged = reciprocalRankFusion([ftsIds, vecIds], RRF_K).slice(0, limit);
  if (merged.length === 0) {
    return { results: [], strategy: "rrf" };
  }

  // Hydrate top-N with summary + repo. Apply has_pr filter post-hoc since it
  // joins prs_referenced (small set, not worth a SQL-side filter).
  const hydrated = await db
    .select({
      sessionId: sessions.id,
      branch: sessions.branch,
      agent: sessions.agent,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      totalCostUsd: sessions.totalCostUsd,
      title: summaries.title,
      summary: summaries.summary,
      tags: summaries.tags,
      prsReferenced: summaries.prsReferenced,
      repoUrl: repos.canonicalUrl,
    })
    .from(sessions)
    .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
    .leftJoin(repos, eq(repos.id, sessions.repoId))
    .where(
      inArray(
        sessions.id,
        merged.map((m) => m.id),
      ),
    );

  const byId = new Map(hydrated.map((h) => [h.sessionId, h]));
  const ordered = merged
    .map((m) => byId.get(m.id))
    .filter((h): h is (typeof hydrated)[number] => Boolean(h))
    .filter((h) => {
      if (filters.hasPr === undefined) return true;
      const has = (h.prsReferenced?.length ?? 0) > 0;
      return filters.hasPr ? has : !has;
    });

  return {
    results: ordered.map((h) => ({
      session_id: h.sessionId,
      title: h.title ?? null,
      summary: h.summary ?? null,
      tags: h.tags ?? [],
      repo: h.repoUrl ?? null,
      branch: h.branch,
      agent: h.agent,
      started_at: h.startedAt.toISOString(),
      ended_at: h.endedAt.toISOString(),
      total_cost_usd: h.totalCostUsd,
    })),
    strategy: "rrf",
  };
};
