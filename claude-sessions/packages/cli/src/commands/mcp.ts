// AI-generated. See PROMPT.md for the prompts and model used.

import { requireCredentials } from "../config/credentials.js";

export interface McpOptions {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * `claude-sessions mcp` — exchanges the bearer token for an MCP-scoped JWT
 * and prints the `claude mcp add` install command (REQ-047).
 */
export const mcpCommand = async (opts: McpOptions = {}): Promise<number> => {
  const cred = requireCredentials();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = cred.server_url.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/api/auth/mcp-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${cred.token}` },
  });
  if (!res.ok) {
    process.stderr.write(`failed to fetch mcp token: HTTP ${res.status}\n`);
    return 1;
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    process.stderr.write("server response missing token\n");
    return 1;
  }
  const cmd = `claude mcp add claude-sessions ${base}/mcp/${body.token}`;
  process.stdout.write("Run this to register the MCP server in Claude Code:\n\n");
  process.stdout.write(`  ${cmd}\n\n`);
  return 0;
};
