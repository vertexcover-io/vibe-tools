// AI-generated. See PROMPT.md for the prompts and model used.

import type { UploadClient } from "../upload/client.js";

export interface NameOptions {
  sessionId: string;
  /** `null` clears the user-set name. */
  name: string | null;
  client: UploadClient;
}

/**
 * `claude-sessions name <session-id> "<name>"` — set or clear the
 * display name on the cloud copy (REQ-060). The server's `display_name`
 * resolution prefers user-set name → LLM title → fallback prefix
 * (REQ-059); clearing the name reveals the title underneath.
 */
export const nameCommand = async (opts: NameOptions): Promise<number> => {
  try {
    await opts.client.patchSession(opts.sessionId, { name: opts.name });
  } catch (err) {
    process.stderr.write(`failed to rename session: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`renamed: ${opts.sessionId} → ${opts.name ?? "(cleared)"}\n`);
  return 0;
};
