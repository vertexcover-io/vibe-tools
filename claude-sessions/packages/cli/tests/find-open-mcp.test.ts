// AI-generated. See PROMPT.md for the prompts and model used.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCommand } from "../src/commands/find.js";
import { mcpCommand } from "../src/commands/mcp.js";
import { openCommand } from "../src/commands/open.js";
import { writeCredentials } from "../src/config/credentials.js";
import { type MockServerHandle, startMockServer } from "./helpers/mock-server.js";

let configHome: string;
let server: MockServerHandle;

beforeEach(async () => {
  configHome = mkdtempSync(join(tmpdir(), "cs-find-"));
  process.env.CLAUDE_SESSIONS_HOME = configHome;
  server = await startMockServer();
  await writeCredentials({
    server_url: server.url,
    token: "test-token",
    user_email: "test@example.test",
  });
});

afterEach(async () => {
  rmSync(configHome, { recursive: true, force: true });
  process.env.CLAUDE_SESSIONS_HOME = undefined;
  await server.stop();
});

const captureStdout = (fn: () => Promise<number>): Promise<{ exit: number; out: string }> => {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((exit) => ({ exit, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
};

describe("find command (REQ-020)", () => {
  it("invokes the opener with /search?q=<urlencoded>", async () => {
    const opens: string[] = [];
    const res = await captureStdout(() =>
      findCommand({ query: "hybrid search & rrf", open: async (u) => void opens.push(u) }),
    );
    expect(res.exit).toBe(0);
    expect(opens).toHaveLength(1);
    const url = opens[0]!;
    expect(url.startsWith(`${server.url}/search?q=`)).toBe(true);
    // %20 or + form is acceptable; encodeURIComponent uses %20
    expect(url).toContain("hybrid%20search%20%26%20rrf");
    expect(res.out).toContain(url);
  });
});

describe("open command (REQ-021)", () => {
  it("opens the bare server_url", async () => {
    const opens: string[] = [];
    const res = await captureStdout(() => openCommand({ open: async (u) => void opens.push(u) }));
    expect(res.exit).toBe(0);
    expect(opens).toEqual([server.url]);
  });
});

describe("mcp command (REQ-047)", () => {
  it("prints `claude mcp add` line containing URL + token", async () => {
    server.setHandler("/api/auth/mcp-token", () => ({
      status: 200,
      body: { token: "fake-mcp-jwt-token" },
    }));
    const res = await captureStdout(() => mcpCommand());
    expect(res.exit).toBe(0);
    expect(res.out).toMatch(/claude mcp add\s+claude-sessions\s+/);
    expect(res.out).toContain(`${server.url}/mcp/fake-mcp-jwt-token`);
  });

  it("returns non-zero if server rejects the bearer", async () => {
    server.setHandler("/api/auth/mcp-token", () => ({ status: 401, body: { error: "x" } }));
    const stderrCaptured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCaptured.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await mcpCommand();
      expect(code).not.toBe(0);
      expect(stderrCaptured.join("")).toMatch(/failed to fetch mcp token/);
    } finally {
      process.stderr.write = orig;
    }
  });
});
