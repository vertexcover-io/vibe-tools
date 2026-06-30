// AI-generated. See PROMPT.md for the prompts and model used.
import type { Config } from "./config.ts";
import { verifyConfigDir } from "./init.ts";

// Entrypoint stub: the HTTP+WS server (phases 3-5) is finalized by the
// entrypoint phase. `serve` guards the config dir then hands off to here.
export const startServer = async (cfg: Config): Promise<void> => {
  verifyConfigDir(cfg);
  throw new Error(
    "startServer not yet implemented — wired by the entrypoint phase",
  );
};
