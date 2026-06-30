// AI-generated. See PROMPT.md for the prompts and model used.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkCommand } from "../src/commands/fork.js";
import { upsertRepo } from "../src/config/repos.js";
import { UploadClient } from "../src/upload/client.js";
import { type MockServerHandle, startMockServer } from "./helpers/mock-server.js";
import { type FixtureEnv, makeFixtureEnv } from "./helpers/tmp-jsonl.js";

let fixture: FixtureEnv;
let server: MockServerHandle;
let projectsRoot: string;

const SOURCE_SESSION_ID = "src-session-uuid";
const SOURCE_CWD = "/orig/source/cwd";
const REPO_URL = "github.com/example/forked";

const buildFixtureBlob = (): string => {
  const events = [
    {
      type: "user",
      uuid: "ev-1",
      parentUuid: null,
      timestamp: "2026-05-01T10:00:00.000Z",
      sessionId: SOURCE_SESSION_ID,
      cwd: SOURCE_CWD,
      message: { role: "user", content: "first message" },
    },
    {
      type: "assistant",
      uuid: "ev-2",
      parentUuid: "ev-1",
      timestamp: "2026-05-01T10:00:01.000Z",
      sessionId: SOURCE_SESSION_ID,
      cwd: SOURCE_CWD,
      message: { role: "assistant", content: "response" },
    },
    {
      type: "user",
      uuid: "ev-3",
      parentUuid: "ev-2",
      timestamp: "2026-05-01T10:00:02.000Z",
      sessionId: SOURCE_SESSION_ID,
      cwd: SOURCE_CWD,
      message: { role: "user", content: "follow up" },
    },
    {
      type: "assistant",
      uuid: "ev-4",
      parentUuid: "ev-3",
      timestamp: "2026-05-01T10:00:03.000Z",
      sessionId: SOURCE_SESSION_ID,
      cwd: SOURCE_CWD,
      message: { role: "assistant", content: "second response" },
    },
  ];
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
};

const wireSourceSession = (server: MockServerHandle, blob: string): void => {
  server.setMethodHandler("GET", `/api/sessions/${SOURCE_SESSION_ID}`, () => ({
    status: 200,
    body: {
      id: SOURCE_SESSION_ID,
      repo: { canonical_url: REPO_URL, branch: "main" },
      source_cwd_hint: SOURCE_CWD,
      is_private: false,
      display_name: "src",
      summary: null,
    },
  }));
  server.setRawHandler(`/api/sessions/${SOURCE_SESSION_ID}/blob`, () => ({
    status: 200,
    contentType: "application/x-ndjson",
    bytes: Buffer.from(blob, "utf8"),
  }));
};

const buildClient = (): UploadClient =>
  new UploadClient({ serverUrl: server.url, token: "test-token", retryDelaysMs: [] });

const captureStdio = async (
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
};

beforeEach(async () => {
  fixture = makeFixtureEnv();
  server = await startMockServer();
  projectsRoot = mkdtempSync(join(tmpdir(), "cs-fork-projects-"));
});

afterEach(async () => {
  fixture.cleanup();
  await server.stop();
  rmSync(projectsRoot, { recursive: true, force: true });
});

describe("fork command", () => {
  it("REQ-051/REQ-052: produces JSONL with rewritten cwd, replaced sessionId, parentUuid:null on first line, and prints the resume command", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const targetCwd = mkdtempSync(join(tmpdir(), "cs-target-"));
    try {
      const newSessionId = "00000000-0000-4000-8000-000000000001";
      const { code, stdout } = await captureStdio(() =>
        forkCommand({
          sessionId: SOURCE_SESSION_ID,
          until: "ev-3",
          cwd: targetCwd,
          client: buildClient(),
          projectsRoot,
          newSessionId,
        }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain(`cd ${targetCwd} && claude --resume ${newSessionId}`);

      const encodedCwd = targetCwd.replace(/\//g, "-");
      const outPath = join(projectsRoot, encodedCwd, `${newSessionId}.jsonl`);
      const text = readFileSync(outPath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(3); // ev-1, ev-2, ev-3
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

      // Every cwd rewritten.
      for (const ev of parsed) expect(ev.cwd).toBe(targetCwd);
      // sessionId fully replaced.
      for (const ev of parsed) expect(ev.sessionId).toBe(newSessionId);
      // First parentUuid null.
      expect(parsed[0]?.parentUuid).toBeNull();
      // Last event matches the truncation point.
      expect(parsed[parsed.length - 1]?.uuid).toBe("ev-3");
    } finally {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  });

  it("REQ-053: bogus --cwd exits non-zero with `cwd does not exist`", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const { code, stderr } = await captureStdio(() =>
      forkCommand({
        sessionId: SOURCE_SESSION_ID,
        until: "ev-2",
        cwd: "/nope/does/not/exist",
        client: buildClient(),
        projectsRoot,
      }),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("cwd does not exist");
  });

  it("REQ-054: omitting --cwd when source repo is not in registry exits non-zero with instructive message", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const { code, stderr } = await captureStdio(() =>
      forkCommand({
        sessionId: SOURCE_SESSION_ID,
        until: "ev-2",
        client: buildClient(),
        projectsRoot,
      }),
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--cwd/);
    expect(stderr).toMatch(/not enabled locally|Pass --cwd/);
  });

  it("REQ-055: omitting --cwd when source repo IS in registry uses local_path", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const targetCwd = mkdtempSync(join(tmpdir(), "cs-registered-"));
    try {
      await upsertRepo(REPO_URL, {
        local_path: targetCwd,
        enabled: true,
        manual_override_url: null,
      });
      const newSessionId = "00000000-0000-4000-8000-000000000055";
      const { code, stdout } = await captureStdio(() =>
        forkCommand({
          sessionId: SOURCE_SESSION_ID,
          until: "ev-2",
          client: buildClient(),
          projectsRoot,
          newSessionId,
        }),
      );
      expect(code).toBe(0);
      expect(stdout).toContain(`cd ${targetCwd} && claude --resume ${newSessionId}`);
      const encodedCwd = targetCwd.replace(/\//g, "-");
      const outPath = join(projectsRoot, encodedCwd, `${newSessionId}.jsonl`);
      const text = readFileSync(outPath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      for (const l of lines) {
        const ev = JSON.parse(l) as Record<string, unknown>;
        expect(ev.cwd).toBe(targetCwd);
      }
    } finally {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  });

  it("REQ-056: bogus --until uuid exits non-zero with `event uuid not found`", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const targetCwd = mkdtempSync(join(tmpdir(), "cs-bogus-uuid-"));
    try {
      const { code, stderr } = await captureStdio(() =>
        forkCommand({
          sessionId: SOURCE_SESSION_ID,
          until: "ev-does-not-exist",
          cwd: targetCwd,
          client: buildClient(),
          projectsRoot,
        }),
      );
      expect(code).not.toBe(0);
      expect(stderr).toContain("event uuid not found");
    } finally {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  });

  it("EDGE-022: refuses to overwrite an existing target file", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const targetCwd = mkdtempSync(join(tmpdir(), "cs-no-overwrite-"));
    try {
      const newSessionId = "00000000-0000-4000-8000-000000000022";
      const encodedCwd = targetCwd.replace(/\//g, "-");
      const outDir = join(projectsRoot, encodedCwd);
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${newSessionId}.jsonl`);
      writeFileSync(outPath, "preexisting\n");

      const { code, stderr } = await captureStdio(() =>
        forkCommand({
          sessionId: SOURCE_SESSION_ID,
          until: "ev-2",
          cwd: targetCwd,
          client: buildClient(),
          projectsRoot,
          newSessionId,
        }),
      );
      expect(code).not.toBe(0);
      expect(stderr).toContain("refusing to overwrite");
      // Confirm the original wasn't replaced.
      expect(readFileSync(outPath, "utf8")).toBe("preexisting\n");
    } finally {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  });

  it("EDGE-024: until = first event uuid yields one line with parentUuid:null", async () => {
    wireSourceSession(server, buildFixtureBlob());
    const targetCwd = mkdtempSync(join(tmpdir(), "cs-first-"));
    try {
      const newSessionId = "00000000-0000-4000-8000-000000000024";
      const { code } = await captureStdio(() =>
        forkCommand({
          sessionId: SOURCE_SESSION_ID,
          until: "ev-1",
          cwd: targetCwd,
          client: buildClient(),
          projectsRoot,
          newSessionId,
        }),
      );
      expect(code).toBe(0);
      const encodedCwd = targetCwd.replace(/\//g, "-");
      const outPath = join(projectsRoot, encodedCwd, `${newSessionId}.jsonl`);
      const text = readFileSync(outPath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const ev = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(ev.parentUuid).toBeNull();
      expect(ev.uuid).toBe("ev-1");
      expect(ev.sessionId).toBe(newSessionId);
      expect(ev.cwd).toBe(targetCwd);
    } finally {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  });
});
