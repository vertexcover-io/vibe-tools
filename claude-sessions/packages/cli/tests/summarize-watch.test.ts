// AI-generated. See PROMPT.md for the prompts and model used.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableCommand } from "../src/commands/enable.js";
import type { Summarizer } from "../src/summarizer/index.js";
import { UploadClient } from "../src/upload/client.js";
import { JsonlWatcher } from "../src/watcher/chokidar.js";
import { makeTempGitRepo } from "./helpers/git-repo.js";
import { type MockServerHandle, startMockServer } from "./helpers/mock-server.js";
import {
  type FixtureEnv,
  buildEvent,
  createSessionFile,
  makeFixtureEnv,
} from "./helpers/tmp-jsonl.js";

let fixture: FixtureEnv;
let server: MockServerHandle;

beforeEach(async () => {
  fixture = makeFixtureEnv();
  server = await startMockServer();
});

afterEach(async () => {
  fixture.cleanup();
  await server.stop();
});

describe("watcher wires summarizer end-detect (REQ-016)", () => {
  it("schedules end-detect after a successful consume; firing triggers Summarizer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const repo = makeTempGitRepo("git@github.com:fixture/summarizer-wire.git");
    try {
      const sid = "session-summarize-wire";
      createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "w1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "w2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);

      const client = new UploadClient({
        serverUrl: server.url,
        token: "tok",
        retryDelaysMs: [],
      });

      const summarized: string[] = [];
      const fakeSummarizer = {
        summarize: (sessionId: string, _path: string) => {
          summarized.push(sessionId);
          return Promise.resolve({
            session_id: sessionId,
            title: "x",
            summary: "x",
            tags: [],
            files_touched: [],
            prs_referenced: [],
            tool_call_counts: {},
            generated_at: new Date().toISOString(),
            model: "sonnet",
            status: "ok" as const,
          });
        },
        inFlight: () => 0,
      } as unknown as Summarizer;

      // First, register the repo via enableCommand so backfill runs.
      await enableCommand({
        path: repo.path,
        client,
      });

      // Start a fresh watcher with our summarizer wired in. This will also
      // do a catch-up consume — same file, no new bytes — and then schedule
      // end-detect on it (silenceMs=10ms for the test).
      const watcher = new JsonlWatcher({
        client,
        summarizer: fakeSummarizer,
        silenceMs: 10,
      });
      await watcher.start();

      // Advance through the silence window.
      await vi.advanceTimersByTimeAsync(50);
      await watcher.stop();

      expect(summarized).toContain(sid);
    } finally {
      vi.useRealTimers();
      repo.cleanup();
    }
  });
});
