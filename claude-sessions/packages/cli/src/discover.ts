// AI-generated. See PROMPT.md for the prompts and model used.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Claude Code stores per-cwd JSONL transcripts. Override via the
 * `CLAUDE_PROJECTS_DIR` env var so tests don't scrub the user's real
 * `~/.claude/projects/`.
 */
export const claudeProjectsRoot = (): string =>
  process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");

/**
 * Claude Code names project directories by replacing `/` with `-` in the
 * cwd. Used as a coarse glob; the source of truth is each JSONL's first
 * line `cwd` field, which we validate before claiming a file.
 */
const encodeCwd = (path: string): string => path.replace(/\//g, "-");

const readFirstJsonLine = (path: string): Record<string, unknown> | null => {
  try {
    const buf = Buffer.alloc(8 * 1024);
    const fd = openSync(path, "r");
    try {
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString("utf8");
      const newline = text.indexOf("\n");
      const line = (newline === -1 ? text : text.slice(0, newline)).trim();
      if (!line) return null;
      return JSON.parse(line) as Record<string, unknown>;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
};

export interface DiscoveredFile {
  path: string;
  cwd: string;
  session_id: string | null;
}

const listJsonlInDir = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // ignore
    }
  }
  return out;
};

/**
 * Find every JSONL whose `cwd` matches one of the repo's local paths.
 *
 * Two passes: (1) glob the encoded-cwd directory under
 * `~/.claude/projects/` (cheap), (2) walk every project dir and validate
 * by reading the first line. The second pass catches edge cases where
 * the user moved a worktree or Claude rewrote the directory name.
 */
export const findSessionsForRepo = (
  _canonicalUrl: string,
  localPaths: string[],
): DiscoveredFile[] => {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) return [];

  const candidates = new Set<string>();
  for (const p of localPaths) {
    const dir = join(root, encodeCwd(p));
    for (const f of listJsonlInDir(dir)) candidates.add(f);
  }

  for (const sub of readdirSync(root)) {
    const subDir = join(root, sub);
    let isDir = false;
    try {
      isDir = statSync(subDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const f of listJsonlInDir(subDir)) candidates.add(f);
  }

  const results: DiscoveredFile[] = [];
  for (const path of candidates) {
    const first = readFirstJsonLine(path);
    if (!first) continue;
    const cwdRaw = first.cwd;
    const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
    if (!cwd) continue;
    if (!localPaths.includes(cwd)) continue;
    const sidRaw = first.sessionId;
    const session_id = typeof sidRaw === "string" ? sidRaw : null;
    results.push({ path, cwd, session_id });
  }
  return results;
};

/**
 * Read the first JSONL line for session metadata — used by the watcher
 * to decide whether a file belongs to an enabled repo (EDGE-005).
 */
export const readSessionMeta = (
  path: string,
): { session_id: string | null; cwd: string | null } => {
  const first = readFirstJsonLine(path);
  if (!first) return { session_id: null, cwd: null };
  const cwdRaw = first.cwd;
  const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
  const sidRaw = first.sessionId;
  const session_id = typeof sidRaw === "string" ? sidRaw : null;
  return { session_id, cwd };
};

export const _internal = { encodeCwd, readFirstJsonLine };
