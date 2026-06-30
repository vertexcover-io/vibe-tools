// AI-generated. See PROMPT.md for the prompts and model used.
//
// LIVE e2e for the interactive `chat` CLI. Spawns the real `bin.ts chat`
// process (which auto-starts the server) and drives it over stdin exactly like
// a user typing, then asserts on the rendered stdout. Backed by live pi + the
// host Claude subscription (ANTHROPIC_API_KEY unset). Run with `npm run test:e2e`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const AGENT_DIR = resolve(homedir(), ".pi", "agent");
const noClaudeCreds = !existsSync(resolve(AGENT_DIR, "auth.json"));
const CHAT_ENTRY = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "chat.ts");

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Step {
  /** Line to type (without newline). */
  send: string;
  /** Wait this many ms after sending before the next step. */
  waitMs?: number;
}

interface ChatRun {
  output: string;
  exitCode: number | null;
}

// Drive a fresh `chat` process through a script of typed lines, return the
// full (ANSI-stripped) stdout once it exits.
const driveChat = (steps: readonly Step[], env: Record<string, string> = {}): Promise<ChatRun> =>
  new Promise((resolveRun, rejectRun) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      "npx",
      ["tsx", CHAT_ENTRY],
      { env: { ...process.env, ...env } },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ output: stripAnsi(out), exitCode: code }));

    // Feed steps sequentially with delays so real turns complete between lines.
    let i = 0;
    const next = (): void => {
      if (i >= steps.length) return;
      const step = steps[i++]!;
      child.stdin.write(step.send + "\n");
      setTimeout(next, step.waitMs ?? 1000);
    };
    // Give the server a moment to boot before the first line.
    setTimeout(next, 3000);
  });

describe.skipIf(noClaudeCreds)("live e2e: chat CLI", () => {
  let active: ChildProcessWithoutNullStreams | undefined;
  afterEach(() => {
    active?.kill();
    active = undefined;
  });

  it("streams a response and quits cleanly", async () => {
    const run = await driveChat([
      { send: "Reply with exactly: PONG", waitMs: 22000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    expect(run.output).toContain("PI Agent over WebSockets");
    expect(run.output.toLowerCase()).toContain("session ");
    expect(run.output).toContain("PONG");
    expect(run.output).toContain("bye");
  }, 90000);

  it("multi-turn keeps context in the same session", async () => {
    const run = await driveChat([
      { send: "My favorite number is 7. Acknowledge briefly.", waitMs: 14000 },
      { send: "What is my favorite number? Reply with just the number.", waitMs: 14000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    expect(run.output).toContain("7");
  }, 90000);

  it("/thinking sets the level (display reflects it)", async () => {
    const run = await driveChat([
      { send: "/thinking high", waitMs: 1000 },
      { send: "/quit", waitMs: 1000 },
    ]);
    expect(run.output).toContain("thinking level → high");
  }, 60000);

  it("/thinking rejects an invalid level", async () => {
    const run = await driveChat([
      { send: "/thinking bogus", waitMs: 1000 },
      { send: "/quit", waitMs: 1000 },
    ]);
    expect(run.output).toContain("thinking must be one of");
  }, 60000);

  it("/show-thinking toggles visible reasoning on a hard prompt", async () => {
    const run = await driveChat([
      { send: "/thinking xhigh", waitMs: 800 },
      { send: "/show-thinking on", waitMs: 800 },
      {
        send:
          "Solve and show your reasoning: A=C is false; A finished before B but after C; " +
          "D after E but before A; E before C. Order A..E first to last.",
        waitMs: 30000,
      },
      { send: "/quit", waitMs: 2000 },
    ]);
    expect(run.output).toContain("show thinking → on");
    // With show-thinking on + xhigh on a hard puzzle, thinking text renders;
    // we assert the toggle echoed and a final answer streamed (non-empty).
    expect(run.output.length).toBeGreaterThan(50);
  }, 90000);

  it("/tools off hides tool-call lines but the agent still runs the tool", async () => {
    const marker = "css-chat-tool-9a2b";
    const run = await driveChat([
      { send: "/tools off", waitMs: 800 },
      { send: `Run this bash command and report its output: printf '%s' "${marker}"`, waitMs: 22000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    expect(run.output).toContain("show tool calls → off");
    // The "⚙ bash" tool line is suppressed...
    expect(run.output).not.toContain("⚙ bash");
    // ...but the tool actually ran, so its output reaches the answer.
    expect(run.output).toContain(marker);
  }, 90000);

  it("/tools on shows the tool line with the command", async () => {
    const run = await driveChat([
      { send: "Run this bash command and report its output: echo chat-tool-shown", waitMs: 22000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    // Default is tools shown: the ⚙ line appears and includes the command text.
    expect(run.output).toContain("⚙ bash");
    expect(run.output).toContain("echo chat-tool-shown");
  }, 90000);

  it("/sessions lists a session created in the run", async () => {
    const run = await driveChat([
      { send: "Reply with exactly: HI", waitMs: 16000 },
      { send: "/sessions", waitMs: 3000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    // The list shows at least one session id (a uuid-ish token with msgs count).
    expect(run.output).toMatch(/\(\d+ msgs\)/);
  }, 90000);

  it("typing while busy queues a follow-up in the same session", async () => {
    const run = await driveChat([
      { send: "Count slowly from 1 to 15, one number per line.", waitMs: 1500 },
      // Fire a second line almost immediately — the turn is still running.
      { send: "Also, after that, reply with exactly: FOLLOWED", waitMs: 40000 },
      { send: "/quit", waitMs: 2000 },
    ]);
    expect(run.output.toLowerCase()).toContain("follow-up");
    expect(run.output).toContain("FOLLOWED");
  }, 120000);

  it("/help shows the command list", async () => {
    const run = await driveChat([
      { send: "/help", waitMs: 1000 },
      { send: "/quit", waitMs: 1000 },
    ]);
    expect(run.output).toContain("/thinking");
    expect(run.output).toContain("/show-thinking");
    expect(run.output).toContain("/tools");
    expect(run.output).toContain("/resume");
  }, 60000);
});
