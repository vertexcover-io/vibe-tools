// AI-generated. See PROMPT.md for the prompts and model used.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { startServer } from "@agentwire/server";
import { loadConfig, APP_DIR } from "./config.ts";
import {
  runInit,
  verifyConfigDir,
  readSettingsFile,
  readRegistryFile,
  type AuthEntry,
} from "./init.ts";

const realInstaller = async (pkg: string, configDir: string): Promise<void> => {
  const result = spawnSync("pi", ["install", pkg], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  if (result.status !== 0) {
    throw new Error(`pi install ${pkg} failed (status ${result.status})`);
  }
};

const realAuthRunner = async (
  entry: AuthEntry,
): Promise<{ ok: boolean }> => {
  console.log(`auth: ${entry.name} (${entry.authKind}) → ${entry.flow}`);
  const result = spawnSync("pi", ["auth", entry.flow], { stdio: "inherit" });
  return { ok: result.status === 0 };
};

// CORE-tier runs don't have the tool packages installed; only verify the
// config dir when a real settings.json is present and declares packages.
const shouldVerifyConfigDir = (): boolean =>
  existsSync(resolve(APP_DIR, "settings.json"));

export const buildProgram = (): Command => {
  const program = new Command();
  program
    .name("agentwire-server")
    .description("WS + REST server exposing pi AgentSessions");

  program
    .command("init")
    .description("install declared extensions and run the auth registry")
    .action(async () => {
      const cfg = loadConfig(process.env);
      const summary = await runInit(cfg, {
        installer: realInstaller,
        authRunner: realAuthRunner,
        readSettings: readSettingsFile,
        readRegistry: readRegistryFile,
      });
      console.log(JSON.stringify(summary, null, 2));
    });

  program
    .command("serve")
    .description("start the HTTP + WS server")
    .action(async () => {
      const cfg = loadConfig(process.env);
      if (shouldVerifyConfigDir()) {
        try {
          verifyConfigDir(cfg);
        } catch {
          // Tool-layer extensions (Linear/Gmail/browser/Notion) are not
          // installed in this config dir. The CORE server (sessions +
          // subscription auth) runs fine without them; run `init` to provision
          // the tool layer.
          console.warn(
            "[serve] tool-layer extensions not provisioned — core server only. Run `init` to add Linear/Gmail/browser/Notion.",
          );
        }
      }
      await startServer(cfg);
    });

  return program;
};

export const main = async (argv: readonly string[]): Promise<void> => {
  await buildProgram().parseAsync([...argv]);
};
