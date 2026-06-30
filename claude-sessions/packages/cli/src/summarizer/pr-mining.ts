// AI-generated. See PROMPT.md for the prompts and model used.

import { type ExecFileException, execFile } from "node:child_process";
import type { CanonicalSession } from "@claude-sessions/core";
import { listRepos } from "../config/repos.js";
import type { DeterministicFields } from "./deterministic.js";

/**
 * Promote the deterministic PR list with a `gh pr list` fallback (REQ-027).
 *
 * Trigger: a `git push` happened in the session but no PR URL was
 * captured deterministically. We then ask `gh` for the most recent PR on
 * the same branch and validate that its repo matches the session's
 * canonical repo (REQ-028) — drop the result on mismatch.
 */

export interface MinePrsOptions {
  /** Inject a fake `execFile` for tests. */
  execFileImpl?: typeof execFile;
  /** Inject a fake "where is this repo on disk?" — defaults to the repos.json registry. */
  resolveLocalPath?: (canonicalUrl: string) => string | null;
  /** Inject a clock for deterministic timeouts (unused for now). */
  ghBin?: string;
}

const sawGitPush = (session: CanonicalSession): boolean =>
  session.events.some(
    (ev) =>
      ev.type === "tool_use" && ev.tool === "Bash" && /^git\s+push\b/.test(ev.input_summary ?? ""),
  );

const defaultResolveLocalPath = (canonicalUrl: string): string | null => {
  for (const r of listRepos()) {
    if (r.canonical_url === canonicalUrl) return r.entry.local_path;
  }
  return null;
};

const ghPrList = (
  bin: string,
  cwd: string,
  branch: string,
  execFileImpl: typeof execFile,
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    execFileImpl(
      bin,
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url"],
      { cwd, timeout: 15_000 },
      (err: ExecFileException | null, stdout: string | Buffer) => {
        if (err) {
          reject(err);
          return;
        }
        if (typeof stdout === "string") resolve(stdout);
        else resolve(stdout.toString("utf8"));
      },
    );
  });

const repoSlugFromCanonical = (canonical: string): string | null => {
  // canonical form is "github.com/org/name" (no scheme).
  const m = canonical.match(/^github\.com\/([^/]+\/[^/]+)$/i);
  return m?.[1] ? m[1].toLowerCase() : null;
};

const repoSlugFromPrUrl = (url: string): string | null => {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
  return m?.[1] ? m[1].toLowerCase() : null;
};

export const minePrs = async (
  session: CanonicalSession,
  det: DeterministicFields,
  opts: MinePrsOptions = {},
): Promise<string[]> => {
  const found = new Set<string>(det.prs_referenced_mined);
  if (found.size > 0) return [...found];

  if (!sawGitPush(session)) return [];
  if (!session.repo) return [];
  const branch = session.branch ?? "HEAD";

  const resolve = opts.resolveLocalPath ?? defaultResolveLocalPath;
  const cwd = resolve(session.repo);
  if (!cwd) return [];

  const ghBin = opts.ghBin ?? "gh";
  let stdout = "";
  try {
    stdout = await ghPrList(ghBin, cwd, branch, opts.execFileImpl ?? execFile);
  } catch {
    return [];
  }

  let arr: Array<{ url?: unknown }> = [];
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) arr = parsed;
  } catch {
    return [];
  }
  const url = arr[0]?.url;
  if (typeof url !== "string") return [];

  const sessionSlug = repoSlugFromCanonical(session.repo);
  const prSlug = repoSlugFromPrUrl(url);
  if (!sessionSlug || !prSlug || sessionSlug !== prSlug) return [];
  found.add(url);
  return [...found];
};
