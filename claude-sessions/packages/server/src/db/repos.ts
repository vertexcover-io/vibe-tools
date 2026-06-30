// AI-generated. See PROMPT.md for the prompts and model used.

import { canonicalizeRepo } from "@claude-sessions/core";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "./client.js";
import { repos, userRepos } from "./schema.js";

export interface RepoRow {
  id: string;
  canonicalUrl: string;
  displayName: string | null;
}

export const upsertRepo = async (db: DbClient, rawUrl: string): Promise<RepoRow> => {
  const canonical = canonicalizeRepo(rawUrl);
  const inserted = await db
    .insert(repos)
    .values({ canonicalUrl: canonical })
    .onConflictDoNothing({ target: repos.canonicalUrl })
    .returning();
  if (inserted[0]) {
    return {
      id: inserted[0].id,
      canonicalUrl: inserted[0].canonicalUrl,
      displayName: inserted[0].displayName,
    };
  }
  const found = await db.select().from(repos).where(eq(repos.canonicalUrl, canonical)).limit(1);
  const row = found[0];
  if (!row) throw new Error(`Failed to upsert repo: ${canonical}`);
  return { id: row.id, canonicalUrl: row.canonicalUrl, displayName: row.displayName };
};

export const grantUserRepo = async (
  db: DbClient,
  userId: string,
  repoId: string,
  access: "owner" | "read" = "owner",
): Promise<void> => {
  await db
    .insert(userRepos)
    .values({ userId, repoId, access })
    .onConflictDoUpdate({
      target: [userRepos.userId, userRepos.repoId],
      set: { access },
    });
};

export const revokeUserRepo = async (
  db: DbClient,
  userId: string,
  repoId: string,
): Promise<void> => {
  await db.delete(userRepos).where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, repoId)));
};

export const findUserRepoAccess = async (
  db: DbClient,
  userId: string,
  repoId: string,
): Promise<{ access: string } | null> => {
  const rows = await db
    .select({ access: userRepos.access })
    .from(userRepos)
    .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
};
