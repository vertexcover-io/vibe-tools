// AI-generated. See PROMPT.md for the prompts and model used.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRepo } from "../config/repos.js";
import type { UploadClient } from "../upload/client.js";

export interface ForkOptions {
  sessionId: string;
  until: string;
  cwd?: string;
  client: UploadClient;
  /** Override `~/.claude/projects` for tests. */
  projectsRoot?: string;
  /** Override the new sessionId; tests pass a deterministic value. */
  newSessionId?: string;
}

const encodeCwd = (path: string): string => path.replace(/\//g, "-");

/**
 * `claude-sessions fork <session-id> --until <event-uuid> --cwd <path>` —
 * pull the cloud blob, truncate at the chosen event, rewrite every line's
 * `cwd` and `sessionId`, and write a fresh JSONL under
 * `~/.claude/projects/<encoded-cwd>/<new-sessionId>.jsonl` so the user
 * can `claude --resume` it (REQ-051).
 *
 * `--cwd` defaults to the source repo's registered local_path (REQ-055)
 * and is required if no mapping exists (REQ-054). The output file is
 * never overwritten (EDGE-022).
 */
export const forkCommand = async (opts: ForkOptions): Promise<number> => {
  const session = await opts.client.getSession(opts.sessionId).catch((err: Error) => {
    process.stderr.write(`failed to fetch session: ${err.message}\n`);
    return null;
  });
  if (!session) return 1;

  let cwd = opts.cwd;
  if (!cwd) {
    // Resolve from the local repo registry. The session payload includes
    // the canonical repo URL; fall back to source_cwd_hint as a last-ditch
    // human-friendly hint in the error message.
    const repoUrl = inferRepoUrl(session);
    const entry = repoUrl ? getRepo(repoUrl) : null;
    if (!entry) {
      const hint = typeof session.source_cwd_hint === "string" ? session.source_cwd_hint : null;
      const tail = hint ? ` (originally ${hint}).\n` : ".\n";
      process.stderr.write(
        `--cwd not provided and source repo (${repoUrl ?? "unknown"}) is not enabled locally. Pass --cwd to point at your local checkout${tail}`,
      );
      return 1;
    }
    cwd = entry.local_path;
  }

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    process.stderr.write(`cwd does not exist: ${cwd}\n`);
    return 1;
  }

  const blobBytes = await opts.client.getBlobBytes(opts.sessionId).catch((err: Error) => {
    process.stderr.write(`failed to fetch blob: ${err.message}\n`);
    return null;
  });
  if (!blobBytes) return 1;

  const newSessionId = opts.newSessionId ?? randomUUID();
  const text = Buffer.from(blobBytes).toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);

  const truncated: string[] = [];
  let foundUntil = false;
  let isFirst = true;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if ("cwd" in ev) ev.cwd = cwd;
    if (ev.sessionId === opts.sessionId) ev.sessionId = newSessionId;
    if (isFirst) {
      ev.parentUuid = null;
      isFirst = false;
    }
    truncated.push(JSON.stringify(ev));
    if (ev.uuid === opts.until) {
      foundUntil = true;
      break;
    }
  }
  if (!foundUntil) {
    process.stderr.write(`event uuid not found in session: ${opts.until}\n`);
    return 1;
  }

  const projectsRoot = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
  const outDir = join(projectsRoot, encodeCwd(cwd));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${newSessionId}.jsonl`);
  if (existsSync(outPath)) {
    process.stderr.write(`refusing to overwrite existing file: ${outPath}\n`);
    return 1;
  }
  writeFileSync(outPath, `${truncated.join("\n")}\n`);

  process.stdout.write(`forked → ${outPath}\n`);
  process.stdout.write("\nResume:\n");
  process.stdout.write(`  cd ${cwd} && claude --resume ${newSessionId}\n`);
  return 0;
};

const inferRepoUrl = (session: Record<string, unknown>): string | null => {
  // Server response shape (current): `repo_id` (uuid) is present, but the
  // canonical URL is more useful here. Server response also currently
  // returns repo_id only — we look for either `repo` (legacy) or
  // `canonical_url` if present, otherwise fall back to walking
  // `source_cwd_hint` against the local registry.
  const repo = session.repo;
  if (typeof repo === "string") return repo;
  if (repo && typeof repo === "object") {
    const url = (repo as Record<string, unknown>).canonical_url;
    if (typeof url === "string") return url;
  }
  const url = session.canonical_url;
  if (typeof url === "string") return url;
  return null;
};

export const _internal = { encodeCwd, inferRepoUrl };
