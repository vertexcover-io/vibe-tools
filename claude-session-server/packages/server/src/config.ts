// AI-generated. See PROMPT.md for the prompts and model used.
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// pi's default agent dir, where Claude Code credentials are seeded (by the
// pi-claude-auth extension) into auth.json. We default the server's config dir
// here so `serve` authenticates against the host subscription with no extra
// env. Override with CLAUDE_CONFIG_DIR once `init` provisions an isolated dir
// (which must itself contain a seeded auth.json + pi-claude-auth).
export const DEFAULT_PI_AGENT_DIR = resolve(homedir(), ".pi", "agent");

export interface Config {
  readonly configDir: string;
  readonly bearerTokens: readonly string[];
  readonly workingDir: string;
  readonly idleMs: number;
  readonly maxHot: number;
  readonly port: number;
}
