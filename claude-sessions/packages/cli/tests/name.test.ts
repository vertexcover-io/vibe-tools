// AI-generated. See PROMPT.md for the prompts and model used.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameCommand } from "../src/commands/name.js";
import { UploadClient } from "../src/upload/client.js";
import { type MockServerHandle, startMockServer } from "./helpers/mock-server.js";
import { type FixtureEnv, makeFixtureEnv } from "./helpers/tmp-jsonl.js";

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

const buildClient = (): UploadClient =>
  new UploadClient({ serverUrl: server.url, token: "test-token", retryDelaysMs: [] });

const patchCalls = (sessionId: string): unknown[] =>
  server.requests
    .filter((r) => r.method === "PATCH" && r.path === `/api/sessions/${sessionId}`)
    .map((r) => r.body);

describe("name command (REQ-059, REQ-060)", () => {
  it("PATCHes /api/sessions/:id with { name } when given a value", async () => {
    server.setMethodHandler("PATCH", "/api/sessions/sess-1", () => ({
      status: 200,
      body: { ok: true },
    }));
    const code = await nameCommand({
      sessionId: "sess-1",
      name: "my fork",
      client: buildClient(),
    });
    expect(code).toBe(0);
    const calls = patchCalls("sess-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: "my fork" });
  });

  it("PATCHes with { name: null } when clearing", async () => {
    server.setMethodHandler("PATCH", "/api/sessions/sess-2", () => ({
      status: 200,
      body: { ok: true },
    }));
    const code = await nameCommand({
      sessionId: "sess-2",
      name: null,
      client: buildClient(),
    });
    expect(code).toBe(0);
    const calls = patchCalls("sess-2");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: null });
  });

  it("returns non-zero when the server rejects", async () => {
    server.setMethodHandler("PATCH", "/api/sessions/sess-err", () => ({
      status: 404,
      body: { error: "not found" },
    }));
    let stderr = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await nameCommand({
        sessionId: "sess-err",
        name: "x",
        client: buildClient(),
      });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/failed to rename/);
    } finally {
      process.stderr.write = orig;
    }
  });
});
