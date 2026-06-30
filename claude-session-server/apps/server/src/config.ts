// AI-generated. See PROMPT.md for the prompts and model used.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DEFAULT_PI_AGENT_DIR } from "@agentwire/server";

// Runtime files (settings.json, auth-registry.json, .pi-config/, .sessions/)
// live next to the runnable app, not the @agentwire/server lib. Resolve them
// against APP_DIR (apps/server) rather than the lib's PKG_DIR.
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export { DEFAULT_PI_AGENT_DIR };
export type { Config };

type Env = Readonly<Record<string, string | undefined>>;

const parseInt10 = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCsv = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

export const loadConfig = (env: Env): Config => ({
  configDir: resolve(env.CLAUDE_CONFIG_DIR ?? DEFAULT_PI_AGENT_DIR),
  bearerTokens: parseCsv(env.SERVER_BEARER_TOKENS),
  workingDir: resolve(env.PI_WORKING_DIR ?? resolve(APP_DIR, ".sessions")),
  idleMs: parseInt10(env.IDLE_MS, 300000),
  maxHot: parseInt10(env.MAX_HOT, 50),
  port: parseInt10(env.PORT, 8787),
});
