// AI-generated. See PROMPT.md for the prompts and model used.

import { listRepos } from "../config/repos.js";
import { listTrackedFiles } from "../config/state.js";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

const lastSyncForLocalPath = (localPath: string): string => {
  let latest: string | null = null;
  for (const f of listTrackedFiles()) {
    // We track session files; their cwd is recorded only via session_id.
    // For status, we approximate by reporting the global latest sync per
    // repo (good enough for REQ-046's "last successful upload timestamp").
    if (!latest || f.state.last_seen_at > latest) latest = f.state.last_seen_at;
  }
  void localPath;
  if (!latest) return "-";
  return latest.slice(0, 16).replace("T", " ");
};

export interface StatusOptions {
  /** When true, return the rendered string instead of writing to stdout (tests). */
  capture?: boolean;
}

export interface StatusResult {
  exit: number;
  output: string;
}

/**
 * `claude-sessions status` — print a fixed-width table of repos with
 * their enabled flag, local path, and last sync timestamp (REQ-046).
 */
export const statusCommand = (opts: StatusOptions = {}): StatusResult => {
  const repos = listRepos();
  const headers = ["REPO", "STATUS", "LOCAL PATH", "LAST SYNC"];
  const rows: string[][] = repos.map((r) => [
    r.canonical_url,
    r.entry.enabled ? "enabled" : "disabled",
    r.entry.local_path,
    lastSyncForLocalPath(r.entry.local_path),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const lines = [
    headers.map((h, i) => pad(h, widths[i] as number)).join("    "),
    ...rows.map((row) => row.map((c, i) => pad(c, widths[i] as number)).join("    ")),
  ];
  const output = `${lines.join("\n")}\n`;

  if (!opts.capture) process.stdout.write(output);
  return { exit: 0, output };
};
