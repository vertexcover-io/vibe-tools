// AI-generated. See PROMPT.md for the prompts and model used.

import { listRepos } from "../config/repos.js";
import { findSessionsForRepo } from "../discover.js";
import type { UploadClient } from "../upload/client.js";
import { consumeFile } from "../watcher/consume.js";

export interface SyncOptions {
  client: UploadClient;
}

/**
 * `claude-sessions sync` — one-shot catch-up. Iterates every JSONL we know
 * about for any enabled repo and runs the consume pipeline once. Useful
 * after a fresh install or a long offline window before starting `watch`.
 */
export const syncCommand = async (opts: SyncOptions): Promise<number> => {
  let total = 0;
  for (const r of listRepos()) {
    if (!r.entry.enabled) continue;
    const files = findSessionsForRepo(r.canonical_url, [r.entry.local_path]);
    for (const f of files) {
      try {
        const result = await consumeFile(f.path, opts.client);
        total += result.uploaded;
      } catch (err) {
        process.stderr.write(`sync failed for ${f.path}: ${(err as Error).message}\n`);
      }
    }
  }
  process.stdout.write(`synced ${total} event(s)\n`);
  return 0;
};
