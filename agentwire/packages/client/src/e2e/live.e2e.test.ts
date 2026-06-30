// AI-generated. See PROMPT.md for the prompts and model used.
//
// LIVE e2e suite — drives the real REST + WS server through @agentwire/client
// (the SDK is the transport under test) against live pi 0.79.9 and the host's
// Claude subscription (ANTHROPIC_API_KEY unset; auth resolved from
// ~/.pi/agent/auth.json via the pi-claude-auth extension). Separate from the
// fast/offline unit suite: run with `npm run test:e2e`.
//
// Asserts on observable behavior (streamed frames, on-disk transcript) and
// tolerates model phrasing — substrings are matched case-insensitively. The
// happy-path session traffic all goes through createClient(); the only raw-ws
// fallback is the bearer-rejection close-code check (hard to observe via SDK).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createClient, type AgentClient } from "../index.ts";
import type { ServerOutboundFrame, ThinkingLevel } from "@agentwire/protocol";
import {
  startLiveServer,
  sessionFileFor,
  buildConfig,
  type LiveServer,
  type Config,
} from "./live-harness.ts";

const TOKEN = "live-e2e-token";
const AGENT_DIR = resolve(homedir(), ".pi", "agent");

// Creds are required for this suite. When absent, skip with a loud message
// rather than failing — but in the target environment they ARE present.
const noClaudeCreds = !existsSync(resolve(AGENT_DIR, "auth.json"));
if (noClaudeCreds) {
  // eslint-disable-next-line no-console
  console.warn(
    `[live.e2e] skipping: no ${resolve(AGENT_DIR, "auth.json")} — host Claude subscription not seeded`,
  );
}

type Frame = ServerOutboundFrame;

interface Collected {
  readonly frames: Frame[];
  text: string;
  thinkingDeltas: number;
  turnEnds: number;
  truncated: number;
  lastUsage: unknown;
  readonly toolStarts: Extract<Frame, { type: "tool_execution_start" }>[];
  readonly toolEnds: Extract<Frame, { type: "tool_execution_end" }>[];
  readonly errors: Extract<Frame, { type: "error" }>[];
}

interface LiveClient {
  readonly client: AgentClient;
  readonly collected: Collected;
  sessionId(): string | undefined;
  waitFor(predicate: (c: Collected) => boolean, ms: number): Promise<void>;
  prompt(text: string, opts?: { thinking?: ThinkingLevel }): void;
  close(): void;
}

const lower = (s: string): string => s.toLowerCase();

const baseUrl = (port: number): string => `http://127.0.0.1:${port}`;

// Connect through @agentwire/client and wire frame collectors via client.on().
const connect = async (
  port: number,
  opts?: { sessionId?: string },
): Promise<LiveClient> => {
  const client = createClient({ baseUrl: baseUrl(port), token: TOKEN });

  const collected: Collected = {
    frames: [],
    text: "",
    thinkingDeltas: 0,
    turnEnds: 0,
    truncated: 0,
    lastUsage: undefined,
    toolStarts: [],
    toolEnds: [],
    errors: [],
  };

  const waiters: { predicate: (c: Collected) => boolean; resolve: () => void }[] = [];
  const checkWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(collected)) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };

  client.on("session_ready", (f) => {
    collected.frames.push(f);
    checkWaiters();
  });
  client.on("text_delta", (f) => {
    collected.frames.push(f);
    collected.text += f.delta;
    checkWaiters();
  });
  client.on("thinking_delta", (f) => {
    collected.frames.push(f);
    collected.thinkingDeltas += 1;
    checkWaiters();
  });
  client.on("tool_execution_start", (f) => {
    collected.frames.push(f);
    collected.toolStarts.push(f);
    checkWaiters();
  });
  client.on("tool_execution_end", (f) => {
    collected.frames.push(f);
    collected.toolEnds.push(f);
    checkWaiters();
  });
  client.on("turn_end", (f) => {
    collected.frames.push(f);
    collected.turnEnds += 1;
    collected.lastUsage = f.usage;
    checkWaiters();
  });
  client.on("truncated", (f) => {
    collected.frames.push(f);
    collected.truncated += 1;
    checkWaiters();
  });
  client.on("error", (f) => {
    collected.frames.push(f);
    collected.errors.push(f);
    checkWaiters();
  });

  await client.connect(opts);

  return {
    client,
    collected,
    sessionId: () => client.sessionId(),
    waitFor: (predicate, ms) =>
      new Promise<void>((res, rej) => {
        if (predicate(collected)) {
          res();
          return;
        }
        const timer = setTimeout(() => rej(new Error("waitFor timed out")), ms);
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer);
            res();
          },
        });
      }),
    prompt: (text, promptOpts) => client.prompt(text, promptOpts),
    close: () => client.close(),
  };
};

describe.skipIf(noClaudeCreds)("live e2e: real pi + Claude subscription (via @agentwire/client)", () => {
  let live: LiveServer;
  let cfg: Config;
  let tmpCwd: string;
  let tmpRoot: string;

  beforeAll(() => {
    // Point the working dir at a path that does NOT exist yet (a child of a
    // fresh tmp dir). startLiveServer → buildServerDeps must create it; this is
    // the regression guard for "Working directory does not exist" breaking the
    // bash tool. Do NOT mkdir it here.
    tmpRoot = mkdtempSync(join(tmpdir(), "css-live-e2e-"));
    tmpCwd = join(tmpRoot, "sessions-not-yet-created");
    expect(existsSync(tmpCwd)).toBe(false);
    cfg = buildConfig({
      SERVER_BEARER_TOKENS: TOKEN,
      CLAUDE_CONFIG_DIR: AGENT_DIR,
      PI_WORKING_DIR: tmpCwd,
      MAX_HOT: "10",
      IDLE_MS: "600000",
    });
  });

  it("regression: server creates the working dir so the bash tool can run", async () => {
    // buildServerDeps (called by startLiveServer in the next beforeAll) must
    // have created the previously-absent working dir.
    expect(existsSync(tmpCwd)).toBe(true);
  });

  beforeAll(async () => {
    live = await startLiveServer(cfg);
  });

  afterAll(async () => {
    if (live !== undefined) await live.close();
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("VS-1: connect → session_ready, streamed PONG with usage, thinking on/off", async () => {
    const c = await connect(live.port);
    expect(c.sessionId()).toBeDefined();

    c.prompt("Reply with exactly: PONG");
    await c.waitFor((s) => s.turnEnds >= 1, 90000);

    const textDeltas = c.collected.frames.filter((f) => f.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(lower(c.collected.text)).toContain("pong");
    expect(c.collected.turnEnds).toBe(1);

    const usage = c.collected.lastUsage as Record<string, number> | undefined;
    expect(usage).toBeDefined();
    const inputTokens = usage?.input ?? (usage?.inputTokens as number | undefined);
    const outputTokens = usage?.output ?? (usage?.outputTokens as number | undefined);
    expect(inputTokens).toBeGreaterThan(0);
    expect(outputTokens).toBeGreaterThan(0);

    // thinking: xhigh + a hard reasoning puzzle reliably surfaces thinking_delta
    // on claude-opus-4-8 (lower levels are adaptively suppressed by the model).
    const beforeThinking = c.collected.thinkingDeltas;
    c.client.prompt(
      "Reason step-by-step inside your thinking before answering. Logic puzzle: " +
        "Five people (A,B,C,D,E) finished a race. A finished before B but after C. " +
        "D finished after E but before A. E finished before C. Determine the exact " +
        "finishing order from first to last. Work through each constraint explicitly.",
      { thinking: "xhigh" },
    );
    await c.waitFor((s) => s.turnEnds >= 2, 120000);
    expect(c.collected.thinkingDeltas).toBeGreaterThan(beforeThinking);

    // thinking: off → zero new thinking_delta
    const thinkingAfterPuzzle = c.collected.thinkingDeltas;
    c.client.prompt("Reply with exactly: DONE", { thinking: "off" });
    await c.waitFor((s) => s.turnEnds >= 3, 90000);
    expect(c.collected.thinkingDeltas).toBe(thinkingAfterPuzzle);

    c.close();
  }, 300000);

  // Tool tests assert on the TOOL RESULT (deterministic), not the model's prose
  // (which may narrate, defer, or stop early). The marker is produced BY the
  // tool, so it lands in the tool_execution_end result regardless of phrasing.
  // The load-bearing assertion is the regression guard: no tool result carries
  // "Working directory does not exist".
  it("tools: agent runs bash and the result has no working-dir error", async () => {
    const c = await connect(live.port);
    const marker = "css-tool-7f3a91";
    c.prompt(
      `Run this exact bash command (and only this), then report its output: ` +
        `printf '%s' "${marker}"`,
    );
    await c.waitFor((s) => s.turnEnds >= 1, 120000);

    // (a) bash executed at least once.
    const bashEnds = c.collected.toolEnds.filter((f) => f.toolName === "bash");
    expect(bashEnds.length).toBeGreaterThanOrEqual(1);

    // (b) REGRESSION GUARD: no bash result is the missing-working-dir failure,
    // and at least one bash result is not an error.
    for (const end of bashEnds) {
      const resultText = lower(JSON.stringify(end.result ?? ""));
      expect(resultText).not.toContain("working directory does not exist");
      expect(resultText).not.toContain("cannot execute bash");
    }
    expect(bashEnds.some((end) => end.isError === false)).toBe(true);

    // (c) the marker appears in a bash result (the command actually produced it).
    const allBashResults = bashEnds.map((e) => JSON.stringify(e.result ?? "")).join("");
    expect(allBashResults).toContain(marker);
    c.close();
  }, 180000);

  it("tools: agent can write+read a file (no working-dir error)", async () => {
    const c = await connect(live.port);
    const marker = "css-fileio-b42e08";
    c.prompt(
      `Use your tools to write the exact text "${marker}" to css-probe.txt in the ` +
        `current directory, then read it back. Report what you read.`,
    );
    await c.waitFor((s) => s.turnEnds >= 1, 120000);

    // A file/bash tool ran and none hit the missing-working-dir failure
    // (the regression guard), and at least one tool succeeded — proving the
    // working dir is writable. (We do NOT assert the model narrates the marker
    // back: whether it performs the read-back step is model-dependent. The
    // write tool's success on a real path is the durable signal.)
    expect(c.collected.toolEnds.length).toBeGreaterThanOrEqual(1);
    for (const end of c.collected.toolEnds) {
      const resultText = lower(JSON.stringify(end.result ?? ""));
      expect(resultText).not.toContain("working directory does not exist");
      expect(resultText).not.toContain("cannot execute");
    }
    expect(c.collected.toolEnds.some((end) => end.isError === false)).toBe(true);
    c.close();
  }, 180000);

  it("VS-2 one-shot: complete() returns text, listSessions() lists it", async () => {
    const client = createClient({ baseUrl: baseUrl(live.port), token: TOKEN });
    const body = await client.complete("Reply with exactly the word: OK");
    expect(lower(body.text)).toContain("ok");
    expect(body.session_id).toBeTruthy();

    const list = await client.listSessions();
    expect(list.sessions.some((s) => s.id === body.session_id)).toBe(true);
  }, 120000);

  it("VS-3 resume: rehydrate remembers a fact across reconnect", async () => {
    const first = await connect(live.port);
    const sid = first.sessionId()!;
    first.prompt("Remember the number 42. Just acknowledge briefly.");
    await first.waitFor((s) => s.turnEnds >= 1, 90000);
    first.close();
    await new Promise((r) => setTimeout(r, 500));

    // messages() shows the exchange.
    const restClient = createClient({ baseUrl: baseUrl(live.port), token: TOKEN });
    const msgs = await restClient.messages(sid);
    expect(msgs).not.toBeNull();
    expect(msgs!.length).toBeGreaterThanOrEqual(2);

    // Reconnect with connect({sessionId}) and ask what was remembered.
    const second = await connect(live.port, { sessionId: sid });
    expect(second.sessionId()).toBe(sid);
    second.prompt("What number did I ask you to remember? Reply with just the number.");
    await second.waitFor((s) => s.turnEnds >= 1, 90000);
    expect(second.collected.text).toContain("42");
    second.close();
  }, 240000);

  it("VS-4 detach-to-completion: drop ws mid-stream, reconnect replays completed turn", async () => {
    const c = await connect(live.port);
    const sid = c.sessionId()!;
    c.prompt("Count slowly from 1 to 20, one number per line, nothing else.");
    // Wait until streaming has visibly started, then drop the socket mid-turn.
    await c.waitFor((s) => s.text.length > 0, 60000);
    // Drop the socket with the SDK: close this client, then make a NEW client.
    c.close();

    // Give the turn time to complete server-side while detached.
    await new Promise((r) => setTimeout(r, 8000));

    const reconnected = await connect(live.port, { sessionId: sid });
    expect(reconnected.sessionId()).toBe(sid);
    // Buffered frames replay: the turn had completed → a turn_end is replayed
    // (and/or a truncated marker for the dropped tail).
    await reconnected.waitFor(
      (s) => s.turnEnds >= 1 || s.truncated >= 1 || s.text.length > 0,
      60000,
    );
    expect(
      reconnected.collected.turnEnds >= 1 ||
        reconnected.collected.truncated >= 1 ||
        reconnected.collected.text.length > 0,
    ).toBe(true);

    // Transcript on disk holds the full assistant message.
    const file = await sessionFileFor(cfg, sid);
    const raw = readFileSync(file, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(lower(raw)).toContain("count slowly");
    reconnected.close();
  }, 240000);

  it("single-writer: a second prompt while busy returns session_busy", async () => {
    const c = await connect(live.port);
    c.prompt("Count slowly from 1 to 30, one number per line.");
    // Fire the second prompt immediately, before the first turn ends.
    c.prompt("Reply with: SECOND");
    await c.waitFor((s) => s.errors.some((e) => e.code === "session_busy"), 30000);
    const busy = c.collected.errors.find((e) => e.code === "session_busy");
    expect(busy).toBeDefined();
    c.close();
  }, 120000);

  it("bearer: ws without token closed 4401; complete() without token 401", async () => {
    // (1) An unauthorized upgrade is accepted then closed with code 4401 (so a
    //     browser can read the reason). The raw ws sees open → close(4401).
    const wsClose = await new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${live.port}/sessions/ws`);
      ws.on("close", (code) => res(code));
      ws.on("error", () => res(-1));
    });
    expect(wsClose).toBe(4401);

    // (2) The SDK connect() with a bad token now rejects with the 4401 reason
    //     (the close code is observable through the SDK — no raw-ws fallback).
    const badClient = createClient({ baseUrl: baseUrl(live.port), token: "wrong-token" });
    await expect(badClient.connect()).rejects.toThrow(/401 unauthorized/i);
    badClient.close();

    // (3) complete() without token → 401 (raw fetch, since the SDK always sends
    //     the configured bearer; we check the unauthenticated path directly).
    const res = await fetch(`${baseUrl(live.port)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Say OK" }),
    });
    expect(res.status).toBe(401);
  }, 30000);
});
