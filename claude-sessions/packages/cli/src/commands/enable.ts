// AI-generated. See PROMPT.md for the prompts and model used.

import { detectRepo } from "@claude-sessions/core";
import { upsertRepo } from "../config/repos.js";
import { findSessionsForRepo } from "../discover.js";
import type { UploadClient } from "../upload/client.js";
import { consumeFile } from "../watcher/consume.js";

export interface EnableOptions {
  path?: string;
  /** Skip backfill — tests use this to keep enable fast. */
  skipBackfill?: boolean;
  /** Inject upload client; if undefined, the caller must build one. */
  client: UploadClient;
}

/**
 * `claude-sessions enable [path]` — register the repo locally + on the
 * server, then backfill any pre-existing JSONL files for it (REQ-013).
 *
 * Returns 0 on success, 1 if `path` is not a git repo (REQ-011 — stderr
 * contains the substring `not a git repository`).
 */
export const enableCommand = async (opts: EnableOptions): Promise<number> => {
  const path = opts.path ?? process.cwd();
  const id = detectRepo(path);
  if (!id) {
    process.stderr.write("not a git repository\n");
    return 1;
  }

  await upsertRepo(id.canonical_url, {
    local_path: id.toplevel,
    enabled: true,
    manual_override_url: null,
  });

  await opts.client.enableRepo(id.canonical_url, id.toplevel);

  if (!opts.skipBackfill) {
    const files = findSessionsForRepo(id.canonical_url, [id.toplevel]);
    for (const f of files) {
      try {
        await consumeFile(f.path, opts.client, { fullScan: true });
      } catch (err) {
        process.stderr.write(`backfill failed for ${f.path}: ${(err as Error).message}\n`);
      }
    }
  }

  process.stdout.write(`enabled: ${id.canonical_url}\n`);
  return 0;
};
