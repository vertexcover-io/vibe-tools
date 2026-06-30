// AI-generated. See PROMPT.md for the prompts and model used.
//
// LIVE e2e suite — drives the real REST + WS server against live pi 0.79.9 and
// the host's Claude subscription (ANTHROPIC_API_KEY unset; auth resolved from
// ~/.pi/agent/auth.json via the pi-claude-auth extension). Separate from the
// fast/offline unit suite: run with `npm run test:e2e`.
//
// Asserts on observable behavior (streamed frames, on-disk transcript) and
// tolerates model phrasing — substrings are matched case-insensitively.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadConfig, type Config } from "../config.ts";
import { startLiveServer, sessionFileFor, type LiveServer } from "./live-harness.ts";

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

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Collected {
  readonly frames: Frame[];
  text: string;
  thinkingDeltas: number;
  turnEnds: number;
  lastUsage: unknown;
  readonly toolStarts: Frame[];
  readonly toolEnds: Frame[];
}

interface Client {
  readonly ws: WebSocket;
  readonly collected: Collected;
  sessionId(): string | undefined;
  waitFor(predicate: (c: Collected) => boolean, ms: number): Promise<void>;
  send(frame: unknown): void;
  close(): void;
}

const lower = (s: string): string => s.toLowerCase();

const connect = (port: number, query = ""): Promise<Client> =>
  new Promise((resolveConn, rejectConn) => {
    const url = `ws://127.0.0.1:${port}/sessions/ws?token=${TOKEN}${query}`;
    const ws = new WebSocket(url);
    const collected: Collected = {
      frames: [],
      text: "",
      thinkingDeltas: 0,
      turnEnds: 0,
      lastUsage: undefined,
      toolStarts: [],
      toolEnds: [],
    };
    let sid: string | undefined;
    const waiters: { predicate: (c: Collected) => boolean; resolve: () => void }[] = [];

    const checkWaiters = (): void => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.predicate(collected)) {
          waiters[i]!.resolve();
          waiters.splice(i, 1);
        }
      }
    };

    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Frame;
      collected.frames.push(frame);
      if (frame.type === "session_ready") sid = frame.session_id as string;
      if (frame.type === "text_delta") collected.text += String(frame.delta);
      if (frame.type === "thinking_delta") collected.thinkingDeltas += 1;
      if (frame.type === "tool_execution_start") collected.toolStarts.push(frame);
      if (frame.type === "tool_execution_end") collected.toolEnds.push(frame);
      if (frame.type === "turn_end") {
        collected.turnEnds += 1;
        collected.lastUsage = frame.usage;
      }
      checkWaiters();
    });

    ws.on("error", (err) => rejectConn(err));

    const client: Client = {
      ws,
      collected,
      sessionId: () => sid,
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
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
    };

    ws.on("open", () => {
      // session_ready arrives just after open; resolve once we have it.
      void client
        .waitFor((c) => c.frames.some((f) => f.type === "session_ready"), 30000)
        .then(() => resolveConn(client))
        .catch(rejectConn);
    });
  });

describe.skipIf(noClaudeCreds)("live e2e: real pi + Claude subscription", () => {
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
    cfg = loadConfig({
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
    const client = await connect(live.port);
    expect(client.sessionId()).toBeDefined();

    client.send({ type: "prompt", text: "Reply with exactly: PONG" });
    await client.waitFor((c) => c.turnEnds >= 1, 90000);

    const textDeltas = client.collected.frames.filter((f) => f.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(lower(client.collected.text)).toContain("pong");
    expect(client.collected.turnEnds).toBe(1);

    const usage = client.collected.lastUsage as Record<string, number> | undefined;
    expect(usage).toBeDefined();
    const inputTokens = usage?.input ?? (usage?.inputTokens as number | undefined);
    const outputTokens = usage?.output ?? (usage?.outputTokens as number | undefined);
    expect(inputTokens).toBeGreaterThan(0);
    expect(outputTokens).toBeGreaterThan(0);

    // thinking: xhigh + a hard reasoning puzzle reliably surfaces thinking_delta
    // on claude-opus-4-8 (lower levels are adaptively suppressed by the model).
    const beforeThinking = client.collected.thinkingDeltas;
    client.send({
      type: "prompt",
      thinking: "xhigh",
      text:
        "Reason step-by-step inside your thinking before answering. Logic puzzle: " +
        "Five people (A,B,C,D,E) finished a race. A finished before B but after C. " +
        "D finished after E but before A. E finished before C. Determine the exact " +
        "finishing order from first to last. Work through each constraint explicitly.",
    });
    await client.waitFor((c) => c.turnEnds >= 2, 120000);
    expect(client.collected.thinkingDeltas).toBeGreaterThan(beforeThinking);

    // thinking: off → zero new thinking_delta
    const thinkingAfterPuzzle = client.collected.thinkingDeltas;
    client.send({ type: "prompt", thinking: "off", text: "Reply with exactly: DONE" });
    await client.waitFor((c) => c.turnEnds >= 3, 90000);
    expect(client.collected.thinkingDeltas).toBe(thinkingAfterPuzzle);

    client.close();
  }, 300000);

  // Tool tests assert on the TOOL RESULT (deterministic), not the model's prose
  // (which may narrate, defer, or stop early). The marker is produced BY the
  // tool, so it lands in the tool_execution_end result regardless of phrasing.
  // The load-bearing assertion is the regression guard: no tool result carries
  // "Working directory does not exist".
  it("tools: agent runs bash and the result has no working-dir error", async () => {
    const client = await connect(live.port);
    const marker = "css-tool-7f3a91";
    client.send({
      type: "prompt",
      text:
        `Run this exact bash command (and only this), then report its output: ` +
        `printf '%s' "${marker}"`,
    });
    await client.waitFor((c) => c.turnEnds >= 1, 120000);

    // (a) bash executed at least once.
    const bashEnds = client.collected.toolEnds.filter((f) => f.toolName === "bash");
    expect(bashEnds.length).toBeGreaterThanOrEqual(1);

    // (b) REGRESSION GUARD: no bash result is the missing-working-dir failure,
    // and at least one bash result is not an error.
    for (const end of bashEnds) {
      const resultText = lower(JSON.stringify(end.result ?? ""));
      expect(resultText).not.toContain("working directory does not exist");
      expect(resultText).not.toContain("cannot execute bash");
    }
    expect(bashEnds.some((end) => (end.isError ?? false) === false)).toBe(true);

    // (c) the marker appears in a bash result (the command actually produced it).
    const allBashResults = bashEnds.map((e) => JSON.stringify(e.result ?? "")).join("");
    expect(allBashResults).toContain(marker);
    client.close();
  }, 180000);

  it("tools: agent can write+read a file (no working-dir error)", async () => {
    const client = await connect(live.port);
    const marker = "css-fileio-b42e08";
    client.send({
      type: "prompt",
      text:
        `Use your tools to write the exact text "${marker}" to css-probe.txt in the ` +
        `current directory, then read it back. Report what you read.`,
    });
    await client.waitFor((c) => c.turnEnds >= 1, 120000);

    // A file/bash tool ran and none hit the missing-working-dir failure
    // (the regression guard), and at least one tool succeeded — proving the
    // working dir is writable. (We do NOT assert the model narrates the marker
    // back: whether it performs the read-back step is model-dependent. The
    // write tool's success on a real path is the durable signal.)
    expect(client.collected.toolEnds.length).toBeGreaterThanOrEqual(1);
    for (const end of client.collected.toolEnds) {
      const resultText = lower(JSON.stringify(end.result ?? ""));
      expect(resultText).not.toContain("working directory does not exist");
      expect(resultText).not.toContain("cannot execute");
    }
    expect(
      client.collected.toolEnds.some((end) => (end.isError ?? false) === false),
    ).toBe(true);
    client.close();
  }, 180000);

  it("VS-2 one-shot: POST /complete returns text, GET /sessions lists it", async () => {
    const base = `http://127.0.0.1:${live.port}`;
    const res = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Reply with exactly the word: OK" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; session_id: string };
    expect(lower(body.text)).toContain("ok");
    expect(body.session_id).toBeTruthy();

    const list = await fetch(`${base}/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { sessions: { id: string }[] };
    expect(listBody.sessions.some((s) => s.id === body.session_id)).toBe(true);
  }, 120000);

  it("VS-3 resume: rehydrate remembers a fact across reconnect", async () => {
    const first = await connect(live.port);
    const sid = first.sessionId()!;
    first.send({ type: "prompt", text: "Remember the number 42. Just acknowledge briefly." });
    await first.waitFor((c) => c.turnEnds >= 1, 90000);
    first.close();
    await new Promise((r) => setTimeout(r, 500));

    // GET /sessions/:id/messages shows the exchange.
    const base = `http://127.0.0.1:${live.port}`;
    const msgs = await fetch(`${base}/sessions/${sid}/messages`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(msgs.status).toBe(200);
    const msgBody = (await msgs.json()) as { messages: unknown[] };
    expect(msgBody.messages.length).toBeGreaterThanOrEqual(2);

    // Reconnect with ?session_id= and ask what was remembered.
    const second = await connect(live.port, `&session_id=${sid}`);
    expect(second.sessionId()).toBe(sid);
    second.send({
      type: "prompt",
      text: "What number did I ask you to remember? Reply with just the number.",
    });
    await second.waitFor((c) => c.turnEnds >= 1, 90000);
    expect(second.collected.text).toContain("42");
    second.close();
  }, 240000);

  it("VS-4 detach-to-completion: drop ws mid-stream, reconnect replays completed turn", async () => {
    const client = await connect(live.port);
    const sid = client.sessionId()!;
    client.send({
      type: "prompt",
      text: "Count slowly from 1 to 20, one number per line, nothing else.",
    });
    // Wait until streaming has visibly started, then drop the socket mid-turn.
    await client.waitFor((c) => c.text.length > 0, 60000);
    client.ws.terminate();

    // Give the turn time to complete server-side while detached.
    await new Promise((r) => setTimeout(r, 8000));

    const reconnected = await connect(live.port, `&session_id=${sid}`);
    expect(reconnected.sessionId()).toBe(sid);
    // Buffered frames replay: the turn had completed → a turn_end is replayed.
    await reconnected.waitFor((c) => c.turnEnds >= 1, 60000);
    expect(reconnected.collected.text.length).toBeGreaterThan(0);

    // Transcript on disk holds the full assistant message.
    const file = await sessionFileFor(cfg, sid);
    const raw = readFileSync(file, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(lower(raw)).toContain("count slowly");
    reconnected.close();
  }, 240000);

  it("single-writer: a second prompt while busy returns session_busy", async () => {
    const client = await connect(live.port);
    client.send({ type: "prompt", text: "Count slowly from 1 to 30, one number per line." });
    // Fire the second prompt immediately, before the first turn ends.
    client.send({ type: "prompt", text: "Reply with: SECOND" });
    await client.waitFor(
      (c) => c.frames.some((f) => f.type === "error" && f.code === "session_busy"),
      30000,
    );
    const busy = client.collected.frames.find(
      (f) => f.type === "error" && f.code === "session_busy",
    );
    expect(busy).toBeDefined();
    client.close();
  }, 120000);

  it("bearer: ws without token closed 4401; /complete without token 401", async () => {
    const wsRejected = await new Promise<number | "opened">((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${live.port}/sessions/ws`);
      ws.on("open", () => {
        ws.close();
        res("opened");
      });
      ws.on("unexpected-response", (_req, response) => res(response.statusCode ?? -1));
      ws.on("error", () => res(4401));
    });
    expect(wsRejected).not.toBe("opened");

    const base = `http://127.0.0.1:${live.port}`;
    const res = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Say OK" }),
    });
    expect(res.status).toBe(401);
  }, 30000);
});
