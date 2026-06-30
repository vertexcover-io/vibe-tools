// AI-generated. See PROMPT.md for the prompts and model used.

import { writeCredentials } from "../config/credentials.js";

export interface LoginOptions {
  serverUrl: string;
  email: string;
  password: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * `claude-sessions login` — POST /api/auth/login, persist the bearer token.
 *
 * Returns 0 on success, non-zero on auth failure with a clear stderr line
 * (REQ-030, REQ-031). Token is written to `~/.claude-sessions/credentials.json`
 * with mode `0600` so other users on the box can't read it.
 */
export const loginCommand = async (opts: LoginOptions): Promise<number> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.serverUrl.replace(/\/+$/, "")}/api/auth/login`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  });
  if (!res.ok) {
    process.stderr.write("invalid email or password\n");
    return 1;
  }
  const body = (await res.json()) as { token?: string; user?: { email?: string } };
  if (!body.token) {
    process.stderr.write("login response missing token\n");
    return 1;
  }
  await writeCredentials({
    server_url: opts.serverUrl,
    token: body.token,
    user_email: body.user?.email ?? opts.email,
  });
  process.stdout.write(`logged in as ${body.user?.email ?? opts.email}\n`);
  return 0;
};
