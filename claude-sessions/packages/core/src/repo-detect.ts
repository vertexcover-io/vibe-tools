// AI-generated. See PROMPT.md for the prompts and model used.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Repo URL canonicalization (REQ-048) and local repo detection.
 *
 * Lives in `@claude-sessions/core` so both the CLI (for `enable`) and the
 * server (for ingest validation) share one implementation.
 */

const stripGitSuffix = (s: string): string => (s.endsWith(".git") ? s.slice(0, -4) : s);

const fromSshForm = (input: string): string | null => {
  const match = input.match(/^git@([^:]+):(.+)$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
};

const fromHttpForm = (input: string): string | null => {
  try {
    const url = new URL(input);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return null;
    return `${url.host}${url.pathname}`;
  } catch {
    return null;
  }
};

export const canonicalizeRepo = (input: string): string => {
  const trimmed = input.trim();
  const ssh = fromSshForm(trimmed);
  const http = fromHttpForm(trimmed);
  const raw = ssh ?? http ?? trimmed;
  const stripped = stripGitSuffix(raw);
  const collapsed = stripped.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return collapsed.toLowerCase();
};

/**
 * Alias kept for naming clarity from the CLI's perspective. A "remote URL"
 * (origin or otherwise) gets canonicalized identically to any other repo URL.
 */
export const canonicalizeRemoteUrl = canonicalizeRepo;

/**
 * Walk up from `start` looking for a `.git` directory or file (worktrees use
 * a `.git` file pointing to the gitdir). Returns the directory containing it,
 * or `null` if no ancestor is a git repo.
 *
 * Pure filesystem; no shell exec — safe to call in tight loops or before
 * the user has `git` on their PATH.
 */
export const findGitRoot = (start: string): string | null => {
  let dir = resolve(start);
  while (true) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export interface RepoIdentity {
  /** Canonical remote URL, e.g. `github.com/vertexcover-io/vibe-tools`. */
  canonical_url: string;
  /** Absolute path to the git toplevel (worktree) — `git rev-parse --show-toplevel`. */
  toplevel: string;
  /** Current branch, or `null` if detached/unknown. */
  branch: string | null;
}

const tryReadOriginFromConfig = (gitDir: string): string | null => {
  // Fallback path when `git` isn't on PATH (rare, but tests run in tmp dirs).
  const cfg = `${gitDir}/config`;
  if (!existsSync(cfg)) return null;
  try {
    const text = readFileSync(cfg, "utf8");
    // Find the `[remote "origin"]` section.
    const re = /\[remote\s+"([^"]+)"\][\s\S]*?url\s*=\s*([^\n]+)/g;
    const remotes = new Map<string, string>();
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      remotes.set(m[1] as string, (m[2] as string).trim());
      m = re.exec(text);
    }
    if (remotes.has("origin")) return remotes.get("origin") ?? null;
    const sorted = Array.from(remotes.keys()).sort();
    const first = sorted[0];
    return first ? (remotes.get(first) ?? null) : null;
  } catch {
    return null;
  }
};

const runGit = (cwd: string, args: string[]): string | null => {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
};

/**
 * Detect the canonical repo identity for an arbitrary path on disk.
 *
 * Returns `null` if `path` has no `.git` ancestor (EDGE-005). When inside a
 * worktree, resolves to the worktree's toplevel — NOT the bare/main repo —
 * because that's the path users expect to see (EDGE-007 only hides this in
 * the UI; the CLI surfaces it).
 *
 * Multi-remote rule (EDGE-006): prefer `origin`; if absent, fall back to the
 * first remote alphabetically. Same as the server uses for cross-checking.
 */
export const detectRepo = (path: string): RepoIdentity | null => {
  const root = findGitRoot(path);
  if (!root) return null;

  // Resolve actual gitdir — for worktrees `.git` is a file, not a directory.
  let gitDir = `${root}/.git`;
  try {
    const stat = readFileSync(gitDir, "utf8");
    const m = stat.match(/^gitdir:\s*(.+)$/m);
    if (m) {
      const target = m[1] as string;
      gitDir = target.startsWith("/") ? target : resolve(root, target);
    }
  } catch {
    // Likely a directory, not a file — leave gitDir as-is.
  }

  // Prefer git CLI when available; fall back to parsing the config.
  let originUrl = runGit(root, ["config", "--get", "remote.origin.url"]);
  if (!originUrl) {
    // Try alphabetically-first remote.
    const remotesOut = runGit(root, ["remote"]);
    if (remotesOut) {
      const remotes = remotesOut
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      const first = remotes[0];
      if (first) originUrl = runGit(root, ["config", "--get", `remote.${first}.url`]);
    }
  }
  if (!originUrl) originUrl = tryReadOriginFromConfig(gitDir);

  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? null;

  // No remote yet (fresh `git init`) — fabricate a local-only identity so we
  // don't crash. Caller may decide to refuse.
  const canonical_url = originUrl ? canonicalizeRepo(originUrl) : `local/${root}`.toLowerCase();

  return {
    canonical_url,
    toplevel: root,
    branch: branch === "HEAD" ? null : branch,
  };
};
