// AI-generated. See PROMPT.md for the prompts and model used.
//
// Interactive chat REPL over the Agentwire server, in the spirit of the pi
// agent CLI: stream text live, toggle thinking, manage sessions with slash
// commands, multi-turn conversation, Ctrl-C to interrupt the current turn.
//
// By default it auto-starts the server in the background on a free port and
// shuts it down on exit; --connect <ws-url> attaches to a running server.
//
// Session transport (WS + REST) runs through @agentwire/client; the node:*
// imports below are the CLI shell only (spawn the server, read the terminal,
// pick a free port).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as readline from "node:readline";
import { createClient, type AgentClient } from "@agentwire/client";
import type { ThinkingLevel } from "@agentwire/protocol";

const C = {
  dim: (s: string): string => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string): string => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string): string => `\x1b[33m${s}\x1b[0m`,
  red: (s: string): string => `\x1b[31m${s}\x1b[0m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[0m`,
};

export // One-line summary of a tool call's args for the inline [tool: …] display.
const summarizeToolArgs = (args: unknown): string => {
  if (args === null || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = (k: string): string | undefined =>
    typeof a[k] === "string" ? (a[k] as string) : undefined;
  const val =
    pick("command") ?? // bash
    pick("file_path") ?? // read/write/edit
    pick("path") ??
    pick("pattern") ?? // grep/find
    pick("query") ??
    pick("url");
  if (val === undefined) return "";
  const oneLine = val.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
};

interface ChatOptions {
  /** Attach to an already-running server instead of auto-starting one. */
  connect?: string;
  /** Bearer token (default: a generated one for the auto-started server). */
  token?: string;
  /** Initial model reasoning level (off|minimal|low|medium|high|xhigh). */
  thinking?: string;
  /** Show tool-call lines (display only). Default true. */
  showTools?: boolean;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const isThinkingLevel = (v: string): v is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(v);

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        rej(new Error("could not get a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => res(port));
    });
  });

const waitForHealth = async (base: string, token: string, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error("server did not become healthy in time");
    await new Promise((r) => setTimeout(r, 200));
  }
};

interface ServerHandle {
  baseUrl: string;
  token: string;
  stop(): void;
}

const startBackgroundServer = async (token: string): Promise<ServerHandle> => {
  const port = await freePort();
  // The server app's bin lives at apps/server/src/bin.ts. From apps/chat/src/
  // that resolves up two levels into the server app.
  const here = dirname(fileURLToPath(import.meta.url));
  const serverBin = resolve(here, "..", "..", "server", "src", "bin.ts");
  const child: ChildProcess = spawn("npx", ["tsx", serverBin, "serve"], {
    // detached → the server runs in its OWN process group, so a terminal Ctrl-C
    // (SIGINT to the foreground group) does NOT hit it. The REPL stays in
    // control of Ctrl-C; we kill the server explicitly on exit (stop()).
    detached: true,
    env: { ...process.env, PORT: String(port), SERVER_BEARER_TOKENS: token },
    stdio: ["ignore", "ignore", "inherit"], // surface server warnings on stderr
  });
  child.unref(); // don't keep the REPL alive on the server child
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(C.dim(`starting server on :${port} …\n`));
  await waitForHealth(baseUrl, token, 30000);
  return {
    baseUrl,
    token,
    // Kill the server's whole process group (negative pid) since it's detached.
    stop: () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      }
    },
  };
};

const HELP = `
${C.cyan("commands")}
  /new                 start a fresh session
  /resume <id>         resume a session by id
  /sessions            list recent sessions
  /thinking <level>    model reasoning effort: off|minimal|low|medium|high|xhigh
  /show-thinking [on|off]  show/hide thinking tokens (display only)
  /tools [on|off]      show/hide tool-call lines (display only; tools still run)
  /clear               clear the screen
  /help                show this help
  /quit                exit (Ctrl-D also works)
  ${C.dim("Type while the agent is replying to queue a follow-up in the same session.")}
  ${C.dim("Ctrl-C during a turn interrupts it.")}
`;

export const runChat = async (opts: ChatOptions): Promise<void> => {
  const token = opts.token ?? (opts.connect !== undefined ? "secret123" : "css-chat-token");
  let server: ServerHandle | undefined;
  let baseUrl: string;

  if (opts.connect !== undefined) {
    // --connect takes a ws(s) URL; the SDK wants an http(s) baseUrl and
    // re-derives the ws endpoint internally.
    baseUrl = opts.connect.replace(/\/$/, "").replace(/^ws/, "http");
  } else {
    server = await startBackgroundServer(token);
    baseUrl = server.baseUrl;
  }

  // Thinking level always requested so the model reasons; the toggles below
  // only control what is DISPLAYED, never the model's behavior.
  let thinking: ThinkingLevel = isThinkingLevel(opts.thinking ?? "")
    ? (opts.thinking as ThinkingLevel)
    : "medium";
  let showThinking = false; // /show-thinking on|off — display only
  let showTools = opts.showTools ?? true; // /tools on|off (tool lines) — display only
  let busy = false;
  let streamedThisTurn = false;
  let ready = false;
  let pending: string | undefined; // a prompt typed before the session was ready

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Human input is green; the prompt arrow is the only chrome. Agent output and
  // tool lines get their own colors — no "you"/"agent" labels needed.
  const setPrompt = (): void => rl.setPrompt(C.green("▸ "));

  let closed = false; // set once shutdown begins — silences late async callbacks
  let client: AgentClient = createClient({ baseUrl, token });

  const sendPrompt = (text: string): void => {
    busy = true;
    client.prompt(text, { thinking });
  };

  // Register the streaming subscriptions on the current client and open the
  // session. Resolves once the server reports session_ready.
  const connectSession = async (sessionId?: string): Promise<void> => {
    client.on("text_delta", (f): void => {
      if (!streamedThisTurn) {
        // Blank line above the agent block (Claude-Code-style separation), then
        // agent text in cyan. No "agent" label — color is the differentiator.
        process.stdout.write("\n");
        streamedThisTurn = true;
      }
      process.stdout.write(C.cyan(f.delta));
    });

    client.on("thinking_delta", (f): void => {
      if (showThinking) process.stdout.write(C.dim(f.delta));
    });

    client.on("tool_execution_start", (f): void => {
      if (!showTools) return; // display filter only — the agent still runs the tool
      const summary = summarizeToolArgs(f.args);
      process.stdout.write(
        "\n" + C.yellow(`⚙ ${f.toolName}`) + (summary !== "" ? C.dim(`  ${summary}`) : "") + "\n",
      );
    });

    client.on("turn_end", (): void => {
      if (closed) return;
      // Blank line below the agent block → clear gap before the next prompt.
      process.stdout.write("\n\n");
      busy = false;
      streamedThisTurn = false;
      rl.prompt();
    });

    client.on("error", (f): void => {
      if (closed) return;
      process.stdout.write(C.red(`\n[${f.code}] ${f.message}\n`));
      busy = false;
      streamedThisTurn = false;
      rl.prompt();
    });

    client.on("session_ready", (f): void => {
      if (closed) return; // /quit raced ahead of the ready frame (piped input)
      ready = true;
      process.stdout.write(C.dim(`session ${f.session_id}\n`));
      if (pending !== undefined) {
        const text = pending;
        pending = undefined;
        sendPrompt(text);
      } else {
        rl.prompt();
      }
    });

    await client.connect(sessionId !== undefined ? { sessionId } : {});
  };

  const reconnect = async (sessionId?: string): Promise<void> => {
    client.close();
    busy = false;
    streamedThisTurn = false;
    ready = false;
    client = createClient({ baseUrl, token });
    await connectSession(sessionId);
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    client.close();
    server?.stop();
    rl.close();
    process.stdout.write(C.dim("\nbye\n"));
    process.exit(0);
  };

  // Ctrl-C while the agent is replying → abort the turn and return to the human
  // prompt (the conversation stays alive). When idle → exit.
  //
  // Handle SIGINT at the PROCESS level, not readline's: readline's own SIGINT
  // handling can let the default terminate win (a single Ctrl-C mid-turn would
  // kill the process). A process-level listener always fires and suppresses the
  // default, so we fully control the behavior.
  let sigintGuard = false; // collapse multiple SIGINT sources into one action
  const onSigint = (): void => {
    if (sigintGuard) return;
    sigintGuard = true;
    setTimeout(() => {
      sigintGuard = false;
    }, 50);
    if (busy) {
      // Agent is replying → abort the turn, stay in the conversation.
      client.abort();
      process.stdout.write(C.dim("\n(interrupted)\n"));
      busy = false;
      streamedThisTurn = false;
      rl.prompt();
    } else {
      shutdown();
    }
  };

  // Ctrl-C handling. readline emits its OWN 'SIGINT' event when it owns a TTY,
  // and — crucially — having a listener SUPPRESSES Node's default terminate. So
  // rl.on('SIGINT') is the supported, reliable hook. We also wire the process
  // signal so piped/non-TTY input (tests) still aborts; the guard collapses
  // them into a single action.
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  process.stdout.write(
    C.cyan("PI Agent over WebSockets — chat") +
      C.dim(`  (thinking: ${thinking}, /help for commands)\n`),
  );
  setPrompt();
  rl.prompt();

  rl.on("line", (line) => {
    const input = line.trim();
    if (input === "") {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      const [cmd, ...rest2] = input.slice(1).split(/\s+/);
      const arg = rest2.join(" ");
      switch (cmd) {
        case "quit":
        case "exit":
          shutdown();
          return;
        case "help":
          process.stdout.write(HELP);
          break;
        case "clear":
          process.stdout.write("\x1b[2J\x1b[H");
          break;
        case "thinking": {
          // Set the model's reasoning level (sent to the server next turn).
          if (arg === "") process.stdout.write(C.dim(`thinking level is ${thinking}\n`));
          else if (!isThinkingLevel(arg))
            process.stdout.write(C.red(`thinking must be one of: ${THINKING_LEVELS.join(", ")}\n`));
          else {
            thinking = arg;
            process.stdout.write(C.dim(`thinking level → ${thinking}\n`));
          }
          break;
        }
        case "show-thinking": {
          // Display toggle only — does NOT change the model's reasoning level.
          if (arg === "on") showThinking = true;
          else if (arg === "off") showThinking = false;
          else showThinking = !showThinking;
          process.stdout.write(C.dim(`show thinking → ${showThinking ? "on" : "off"}\n`));
          break;
        }
        case "tools": {
          // Display toggle only — the agent still runs tools.
          if (arg === "on") showTools = true;
          else if (arg === "off") showTools = false;
          else showTools = !showTools;
          process.stdout.write(C.dim(`show tool calls → ${showTools ? "on" : "off"}\n`));
          break;
        }
        case "new":
          void reconnect(undefined).catch((e: unknown) =>
            process.stdout.write(C.red(`reconnect failed: ${String(e)}\n`)),
          );
          process.stdout.write(C.dim("new session\n"));
          break;
        case "resume":
          if (arg === "") process.stdout.write(C.red("usage: /resume <session_id>\n"));
          else {
            void reconnect(arg).catch((e: unknown) =>
              process.stdout.write(C.red(`resume failed: ${String(e)}\n`)),
            );
            process.stdout.write(C.dim(`resuming ${arg}\n`));
          }
          break;
        case "sessions":
          void client
            .listSessions(20)
            .then((r) => {
              if (r.sessions.length === 0) process.stdout.write(C.dim("no sessions yet\n"));
              for (const s of r.sessions) {
                process.stdout.write(
                  `  ${C.cyan(s.id)} ${C.dim(`(${s.messageCount} msgs)`)} ${s.title}\n`,
                );
              }
              rl.prompt();
            })
            .catch((e: unknown) => process.stdout.write(C.red(`list failed: ${String(e)}\n`)));
          return;
        default:
          process.stdout.write(C.red(`unknown command: /${cmd} (/help)\n`));
      }
      rl.prompt();
      return;
    }

    if (busy) {
      // Agent is still replying — queue this as a follow-up in the SAME session
      // (delivered after the current turn finishes), instead of rejecting it.
      client.followUp(input);
      process.stdout.write(C.dim("(queued as follow-up — will run after this turn)\n"));
      return;
    }
    if (!ready) {
      // Session still connecting — queue the prompt; session_ready flushes it.
      pending = input;
      process.stdout.write(C.dim("(connecting…)\n"));
      return;
    }
    sendPrompt(input);
  });

  rl.on("close", () => shutdown());

  // Open the session AFTER the line/close handlers are wired so that, with
  // piped input, an EOF-driven shutdown is observed before a late session_ready
  // frame tries to prompt a closed readline.
  await connectSession();
};

const parseArgs = (argv: readonly string[]): ChatOptions => {
  const opts: ChatOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--connect") opts.connect = argv[++i];
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--thinking") opts.thinking = argv[++i];
    else if (a === "--no-tools") opts.showTools = false;
  }
  return opts;
};

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runChat(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
