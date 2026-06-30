// AI-generated. See PROMPT.md for the prompts and model used.

import { requireCredentials } from "../config/credentials.js";
import { type Opener, defaultOpener } from "./_open.js";

export interface FindOptions {
  query: string;
  /** Inject a fake opener for tests. */
  open?: Opener;
}

/**
 * `claude-sessions find <query>` — opens the user's default browser to
 * `<server_url>/search?q=<urlencoded query>` (REQ-020).
 */
export const findCommand = async (opts: FindOptions): Promise<number> => {
  const cred = requireCredentials();
  const open = opts.open ?? defaultOpener;
  const base = cred.server_url.replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(opts.query)}`;
  await open(url);
  process.stdout.write(`opening ${url}\n`);
  return 0;
};
