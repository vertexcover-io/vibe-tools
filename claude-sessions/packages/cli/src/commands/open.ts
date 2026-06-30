// AI-generated. See PROMPT.md for the prompts and model used.

import { requireCredentials } from "../config/credentials.js";
import { type Opener, defaultOpener } from "./_open.js";

export interface OpenOptions {
  open?: Opener;
}

/**
 * `claude-sessions open` — opens the dashboard URL (REQ-021).
 */
export const openCommand = async (opts: OpenOptions = {}): Promise<number> => {
  const cred = requireCredentials();
  const open = opts.open ?? defaultOpener;
  const url = cred.server_url.replace(/\/+$/, "");
  await open(url);
  process.stdout.write(`opening ${url}\n`);
  return 0;
};
