// AI-generated. See PROMPT.md for the prompts and model used.

import { detectRepo } from "@claude-sessions/core";
import { setEnabled } from "../config/repos.js";
import type { UploadClient } from "../upload/client.js";

export interface DisableOptions {
  path?: string;
  purge?: boolean;
  client: UploadClient;
}

/**
 * `claude-sessions disable [path]` — flip `enabled: false` locally and
 * notify the server. With `--purge` the server deletes all events for
 * the repo (REQ-037).
 */
export const disableCommand = async (opts: DisableOptions): Promise<number> => {
  const path = opts.path ?? process.cwd();
  const id = detectRepo(path);
  if (!id) {
    process.stderr.write("not a git repository\n");
    return 1;
  }

  await setEnabled(id.canonical_url, false);
  await opts.client.disableRepo(id.canonical_url, opts.purge ?? false);

  process.stdout.write(`disabled: ${id.canonical_url}\n`);
  return 0;
};
