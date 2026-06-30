// AI-generated. See PROMPT.md for the prompts and model used.

import { atomicWriteJson, readJsonOr, withFileLock } from "./atomic.js";
import { reposPath } from "./paths.js";

export interface RepoEntry {
  local_path: string;
  enabled: boolean;
  manual_override_url: string | null;
  enabled_at: string;
}

export interface ReposFile {
  version: 1;
  repos: Record<string, RepoEntry>;
}

const empty = (): ReposFile => ({ version: 1, repos: {} });

const readAll = (): ReposFile => {
  const raw = readJsonOr<ReposFile | null>(reposPath(), null);
  if (!raw || raw.version !== 1 || typeof raw.repos !== "object" || raw.repos === null) {
    return empty();
  }
  return raw;
};

export const getRepo = (canonicalUrl: string): RepoEntry | null => {
  const all = readAll();
  return all.repos[canonicalUrl] ?? null;
};

export const upsertRepo = async (
  canonicalUrl: string,
  patch: Partial<RepoEntry> & { local_path: string },
): Promise<RepoEntry> => {
  let result!: RepoEntry;
  await withFileLock(reposPath(), () => {
    const all = readAll();
    const existing = all.repos[canonicalUrl];
    const next: RepoEntry = {
      local_path: patch.local_path,
      enabled: patch.enabled ?? existing?.enabled ?? true,
      manual_override_url: patch.manual_override_url ?? existing?.manual_override_url ?? null,
      enabled_at:
        patch.enabled === false
          ? (existing?.enabled_at ?? new Date().toISOString())
          : new Date().toISOString(),
    };
    all.repos[canonicalUrl] = next;
    atomicWriteJson(reposPath(), all);
    result = next;
  });
  return result;
};

export const setEnabled = async (
  canonicalUrl: string,
  enabled: boolean,
): Promise<RepoEntry | null> => {
  let result: RepoEntry | null = null;
  await withFileLock(reposPath(), () => {
    const all = readAll();
    const existing = all.repos[canonicalUrl];
    if (!existing) return;
    const next: RepoEntry = { ...existing, enabled };
    all.repos[canonicalUrl] = next;
    atomicWriteJson(reposPath(), all);
    result = next;
  });
  return result;
};

export const listRepos = (): Array<{ canonical_url: string; entry: RepoEntry }> => {
  const all = readAll();
  return Object.entries(all.repos).map(([canonical_url, entry]) => ({ canonical_url, entry }));
};

export const findRepoByLocalPath = (
  path: string,
): { canonical_url: string; entry: RepoEntry } | null => {
  for (const r of listRepos()) {
    if (r.entry.local_path === path) return r;
  }
  return null;
};
