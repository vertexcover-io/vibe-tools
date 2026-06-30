#!/usr/bin/env node
// AI-generated. See PROMPT.md for the prompts and model used.

import { Command } from "commander";
import { buildClient } from "./commands/_client.js";
import { disableCommand } from "./commands/disable.js";
import { enableCommand } from "./commands/enable.js";
import { findCommand } from "./commands/find.js";
import { forkCommand } from "./commands/fork.js";
import { loginCommand } from "./commands/login.js";
import { mcpCommand } from "./commands/mcp.js";
import { nameCommand } from "./commands/name.js";
import { openCommand } from "./commands/open.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { watchCommand } from "./commands/watch.js";

/**
 * CLI entry — wires commander to per-subcommand handlers. Subcommands
 * deliberately don't import each other directly; this file is the single
 * coupling point between argv and business logic.
 */
const main = async (): Promise<void> => {
  const program = new Command();
  program
    .name("claude-sessions")
    .description("Sync, search, and re-fork your Claude Code sessions.")
    .version("0.0.0");

  program
    .command("login")
    .description("Log in to a claude-sessions server and persist the token.")
    .requiredOption("--server <url>", "server URL", "http://localhost:3000")
    .requiredOption("--email <email>", "email")
    .requiredOption("--password <password>", "password")
    .action(async (opts: { server: string; email: string; password: string }) => {
      const code = await loginCommand({
        serverUrl: opts.server,
        email: opts.email,
        password: opts.password,
      });
      process.exit(code);
    });

  program
    .command("enable [path]")
    .description("Enable a repo for sync (defaults to cwd).")
    .action(async (path?: string) => {
      const client = buildClient();
      const code = await enableCommand({
        ...(path !== undefined ? { path } : {}),
        client,
      });
      process.exit(code);
    });

  program
    .command("disable [path]")
    .description("Disable a repo for sync (defaults to cwd).")
    .option("--purge", "delete all events for this repo from the cloud", false)
    .action(async (path: string | undefined, opts: { purge: boolean }) => {
      const client = buildClient();
      const code = await disableCommand({
        ...(path !== undefined ? { path } : {}),
        purge: opts.purge,
        client,
      });
      process.exit(code);
    });

  program
    .command("status")
    .description("Show enabled repos + last-sync timestamps.")
    .action(() => {
      const r = statusCommand();
      process.exit(r.exit);
    });

  program
    .command("sync")
    .description("One-shot catch-up: ingest any pending events for enabled repos.")
    .action(async () => {
      const client = buildClient();
      const code = await syncCommand({ client });
      process.exit(code);
    });

  program
    .command("watch")
    .description("Long-running watcher. Tails JSONL files and uploads new events.")
    .action(async () => {
      const client = buildClient();
      await watchCommand({ client });
    });

  program
    .command("fork <session-id>")
    .description("Fork a session at an event uuid into a local resumable JSONL.")
    .requiredOption("--until <event-uuid>", "event uuid to truncate at")
    .option("--cwd <path>", "local cwd for the new transcript")
    .action(async (sessionId: string, opts: { until: string; cwd?: string }) => {
      const client = buildClient();
      const code = await forkCommand({
        sessionId,
        until: opts.until,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        client,
      });
      process.exit(code);
    });

  program
    .command("name <session-id> [name]")
    .description("Set or clear the display name for a session. Pass no name to clear.")
    .action(async (sessionId: string, name?: string) => {
      const client = buildClient();
      const code = await nameCommand({
        sessionId,
        name: name ?? null,
        client,
      });
      process.exit(code);
    });

  program
    .command("find <query...>")
    .description("Open the dashboard search page for the given query.")
    .action(async (queryParts: string[]) => {
      const code = await findCommand({ query: queryParts.join(" ") });
      process.exit(code);
    });

  program
    .command("open")
    .description("Open the dashboard URL in the default browser.")
    .action(async () => {
      const code = await openCommand();
      process.exit(code);
    });

  program
    .command("mcp")
    .description("Print the `claude mcp add` command to register the MCP server.")
    .action(async () => {
      const code = await mcpCommand();
      process.exit(code);
    });

  await program.parseAsync(process.argv);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
