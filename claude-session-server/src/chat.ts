// AI-generated. See PROMPT.md for the prompts and model used.
//
// Interactive chat REPL over the Claude Session Server, in the spirit of the
// pi agent CLI: stream text live, toggle thinking, manage sessions with slash
// commands, multi-turn conversation, Ctrl-C to interrupt the current turn.
//
// By default it auto-starts the server in the background on a free port and
// shuts it down on exit; --connect <ws-url> attaches to a running server.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as readline from "node:readline";
import { WebSocket } from "ws";

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

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

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
  wsBase: string;
  httpBase: string;
  token: string;
  stop(): void;
}

const startBackgroundServer = async (token: string): Promise<ServerHandle> => {
  const port = await freePort();
  const here = dirname(fileURLToPath(import.meta.url));
  const binPath = resolve(here, "bin.ts");
  const child: ChildProcess = spawn("npx", ["tsx", binPath, "serve"], {
    // detached → the server runs in its OWN process group, so a terminal Ctrl-C
    // (SIGINT to the foreground group) does NOT hit it. The REPL stays in
    // control of Ctrl-C; we kill the server explicitly on exit (stop()).
    detached: true,
    env: { ...process.env, PORT: String(port), SERVER_BEARER_TOKENS: token },
    stdio: ["ignore", "ignore", "inherit"], // surface server warnings on stderr
  });
  child.unref(); // don't keep the REPL alive on the server child
  const httpBase = `http://127.0.0.1:${port}`;
  process.stdout.write(C.dim(`starting server on :${port} …\n`));
  await waitForHealth(httpBase, token, 30000);
  return {
    wsBase: `ws://127.0.0.1:${port}`,
    httpBase,
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

interface RestClient {
  listSessions(): Promise<{ sessions: { id: string; title?: string; messageCount?: number }[] }>;
}

const restClient = (httpBase: string, token: string): RestClient => ({
  listSessions: async () => {
    const res = await fetch(`${httpBase}/sessions?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await res.json()) as Awaited<ReturnType<RestClient["listSessions"]>>;
  },
});

// A single live WS connection bound to one session. Replaced on /new and /resume.
interface Conn {
  ws: WebSocket;
  sessionId?: string;
  prompt(text: string, thinking: string): void;
  followUp(text: string): void;
  abort(): void;
  close(): void;
}

const openConn = (
  wsBase: string,
  token: string,
  sessionId: string | undefined,
  handlers: {
    onReady: (id: string) => void;
    onText: (delta: string) => void;
    onThinking: (delta: string) => void;
    onTool: (name: string, args: unknown) => void;
    onTurnEnd: (usage: unknown) => void;
    onError: (code: string, message: string) => void;
    onClose: () => void;
  },
): Conn => {
  const q = new URLSearchParams({ token });
  if (sessionId !== undefined) q.set("session_id", sessionId);
  const ws = new WebSocket(`${wsBase}/sessions/ws?${q.toString()}`);
  let sid = sessionId;

  ws.on("message", (data: Buffer) => {
    const f = JSON.parse(data.toString()) as Frame;
    switch (f.type) {
      case "session_ready":
        sid = f.session_id as string;
        handlers.onReady(sid);
        break;
      case "text_delta":
        handlers.onText(String(f.delta));
        break;
      case "thinking_delta":
        handlers.onThinking(String(f.delta));
        break;
      case "tool_execution_start":
        handlers.onTool(String(f.toolName), f.args);
        break;
      case "turn_end":
        handlers.onTurnEnd(f.usage);
        break;
      case "error":
        handlers.onError(String(f.code), String(f.message));
        break;
      default:
        break;
    }
  });
  ws.on("error", (err) => handlers.onError("ws_error", String(err)));
  ws.on("close", () => handlers.onClose());

  return {
    ws,
    get sessionId() {
      return sid;
    },
    prompt: (text, thinking): void => {
      ws.send(JSON.stringify({ type: "prompt", text, thinking }));
    },
    followUp: (text): void => {
      ws.send(JSON.stringify({ type: "follow_up", text }));
    },
    abort: (): void => {
      ws.send(JSON.stringify({ type: "abort" }));
    },
    close: (): void => {
      ws.close();
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
  let wsBase: string;
  let httpBase: string;

  if (opts.connect !== undefined) {
    wsBase = opts.connect.replace(/\/$/, "");
    httpBase = wsBase.replace(/^ws/, "http");
  } else {
    server = await startBackgroundServer(token);
    wsBase = server.wsBase;
    httpBase = server.httpBase;
  }

  const rest = restClient(httpBase, token);
  // Thinking level always requested at "medium" so the model reasons; the
  // toggles below only control what is DISPLAYED, never the model's behavior.
  let thinking = opts.thinking ?? "medium";
  let showThinking = false; // /thinking on|off — display only
  let showTools = opts.showTools ?? true; // /bash on|off (tool lines) — display only
  let busy = false;
  let streamedThisTurn = false;
  let ready = false;
  let pending: string | undefined; // a prompt typed before the WS was ready

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Human input is green; the prompt arrow is the only chrome. Agent output and
  // tool lines get their own colors — no "you"/"agent" labels needed.
  const setPrompt = (): void => rl.setPrompt(C.green("▸ "));

  const sendPrompt = (text: string): void => {
    busy = true;
    conn.prompt(text, thinking);
  };

  const makeHandlers = () => ({
    onReady: (id: string): void => {
      ready = true;
      process.stdout.write(C.dim(`session ${id}\n`));
      if (pending !== undefined) {
        const text = pending;
        pending = undefined;
        sendPrompt(text);
      } else {
        rl.prompt();
      }
    },
    onText: (delta: string): void => {
      if (!streamedThisTurn) {
        // Blank line above the agent block (Claude-Code-style separation), then
        // agent text in cyan. No "agent" label — color is the differentiator.
        process.stdout.write("\n");
        streamedThisTurn = true;
      }
      process.stdout.write(C.cyan(delta));
    },
    onThinking: (delta: string): void => {
      if (showThinking) process.stdout.write(C.dim(delta));
    },
    onTool: (name: string, args: unknown): void => {
      if (!showTools) return; // display filter only — the agent still runs the tool
      const summary = summarizeToolArgs(args);
      process.stdout.write(
        "\n" + C.yellow(`⚙ ${name}`) + (summary !== "" ? C.dim(`  ${summary}`) : "") + "\n",
      );
    },
    onTurnEnd: (_usage: unknown): void => {
      // Blank line below the agent block → clear gap before the next prompt.
      process.stdout.write("\n\n");
      busy = false;
      streamedThisTurn = false;
      rl.prompt();
    },
    onError: (code: string, message: string): void => {
      process.stdout.write(C.red(`\n[${code}] ${message}\n`));
      busy = false;
      streamedThisTurn = false;
      rl.prompt();
    },
    onClose: (): void => {
      /* connection replaced or shutting down */
    },
  });

  let conn = openConn(wsBase, token, undefined, makeHandlers());

  const reconnect = (sessionId?: string): void => {
    conn.close();
    busy = false;
    streamedThisTurn = false;
    ready = false;
    conn = openConn(wsBase, token, sessionId, makeHandlers());
  };

  const shutdown = (): void => {
    conn.close();
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
      conn.abort();
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
  // rl.on('SIGINT') is the supported, reliable hook. We deliberately do NOT add
  // a process.on('SIGINT') too: a second listener races readline's and can let
  // the process exit. For non-TTY input (piped/tests) readline doesn't emit
  // SIGINT, so fall back to the process signal there.
  // NOTE: Ctrl-C mid-response is known to still exit under `npx tsx` in some
  // terminals (tracked as a follow-up). Both hooks are wired; the guard
  // collapses them. Intended behavior: abort the turn while busy, exit when idle.
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
          const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
          if (arg === "") process.stdout.write(C.dim(`thinking level is ${thinking}\n`));
          else if (!levels.includes(arg))
            process.stdout.write(C.red(`thinking must be one of: ${levels.join(", ")}\n`));
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
          reconnect(undefined);
          process.stdout.write(C.dim("new session\n"));
          break;
        case "resume":
          if (arg === "") process.stdout.write(C.red("usage: /resume <session_id>\n"));
          else {
            reconnect(arg);
            process.stdout.write(C.dim(`resuming ${arg}\n`));
          }
          break;
        case "sessions":
          void rest
            .listSessions()
            .then((r) => {
              if (r.sessions.length === 0) process.stdout.write(C.dim("no sessions yet\n"));
              for (const s of r.sessions) {
                process.stdout.write(
                  `  ${C.cyan(s.id)} ${C.dim(`(${s.messageCount ?? 0} msgs)`)} ${s.title ?? ""}\n`,
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
      conn.followUp(input);
      process.stdout.write(C.dim("(queued as follow-up — will run after this turn)\n"));
      return;
    }
    if (!ready) {
      // WS still connecting — queue the prompt; onReady flushes it.
      pending = input;
      process.stdout.write(C.dim("(connecting…)\n"));
      return;
    }
    sendPrompt(input);
  });

  rl.on("close", () => shutdown());
};
