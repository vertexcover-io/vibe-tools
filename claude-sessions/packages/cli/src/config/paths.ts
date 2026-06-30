// AI-generated. See PROMPT.md for the prompts and model used.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory and file paths for the CLI's per-user state.
 *
 * Defaults to `~/.claude-sessions/` but every test (and the integration
 * helpers) override it via `CLAUDE_SESSIONS_HOME` so we never touch the
 * developer's real config during runs.
 */
export const configHome = (): string =>
  process.env.CLAUDE_SESSIONS_HOME ?? join(homedir(), ".claude-sessions");

export const credentialsPath = (): string => join(configHome(), "credentials.json");
export const statePath = (): string => join(configHome(), "state.json");
export const reposPath = (): string => join(configHome(), "repos.json");
