// AI-generated. See PROMPT.md for the prompts and model used.
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "./config.ts";
import {
  runInit,
  readSettingsFile,
  readRegistryFile,
  type AuthEntry,
} from "./init.ts";
import { startServer } from "./server.ts";
import { runChat } from "./chat.ts";

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

export const buildProgram = (): Command => {
  const program = new Command();
  program
    .name("claude-session-server")
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
      await startServer(cfg);
    });

  program
    .command("chat")
    .description("interactive chat REPL (auto-starts the server unless --connect)")
    .option("--connect <ws-url>", "attach to a running server instead of auto-starting")
    .option("--token <token>", "bearer token (for --connect)")
    .option("--thinking <level>", "model reasoning level: off|minimal|low|medium|high|xhigh", "medium")
    .option("--no-tools", "hide tool-call lines (display only; tools still run)")
    .action(
      async (opts: {
        connect?: string;
        token?: string;
        thinking?: string;
        tools?: boolean;
      }) => {
        await runChat({ ...opts, showTools: opts.tools });
      },
    );

  return program;
};

export const main = async (argv: readonly string[]): Promise<void> => {
  await buildProgram().parseAsync([...argv]);
};
