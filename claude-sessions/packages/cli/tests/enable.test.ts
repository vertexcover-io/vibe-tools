// AI-generated. See PROMPT.md for the prompts and model used.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableCommand } from "../src/commands/disable.js";
import { enableCommand } from "../src/commands/enable.js";
import { statusCommand } from "../src/commands/status.js";
import { listRepos } from "../src/config/repos.js";
import { UploadClient } from "../src/upload/client.js";
import { makeTempGitRepo } from "./helpers/git-repo.js";
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

describe("enable command (REQ-010, REQ-011)", () => {
  it("REQ-010: enable in a real git dir registers the repo and hits /api/repos/enable", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/enable-test.git");
    try {
      const code = await enableCommand({
        path: repo.path,
        client: buildClient(),
        skipBackfill: true,
      });
      expect(code).toBe(0);
      const tracked = listRepos();
      expect(tracked).toHaveLength(1);
      expect(tracked[0]?.canonical_url).toBe("github.com/fixture/enable-test");
      expect(tracked[0]?.entry.enabled).toBe(true);
      expect(tracked[0]?.entry.local_path).toBe(repo.path);
      const calls = server.requests.filter((r) => r.path === "/api/repos/enable");
      expect(calls).toHaveLength(1);
      expect((calls[0]?.body as { canonical_url: string }).canonical_url).toBe(
        "github.com/fixture/enable-test",
      );
    } finally {
      repo.cleanup();
    }
  });

  it("REQ-011: enable in a non-git dir exits non-zero with `not a git repository`", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-non-git-"));
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await enableCommand({
        path: tmp,
        client: buildClient(),
        skipBackfill: true,
      });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/not a git repository/);
    } finally {
      process.stderr.write = origWrite;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("disable command (REQ-012, REQ-037)", () => {
  it("flips enabled to false in repos.json and POSTs /api/repos/disable", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/disable-test.git");
    try {
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });
      const code = await disableCommand({
        path: repo.path,
        client: buildClient(),
      });
      expect(code).toBe(0);
      const after = listRepos();
      expect(after[0]?.entry.enabled).toBe(false);
      const calls = server.requests.filter((r) => r.path === "/api/repos/disable");
      expect(calls).toHaveLength(1);
      expect((calls[0]?.body as { purge: boolean }).purge).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it("REQ-037: --purge sends purge:true to /api/repos/disable", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/disable-purge.git");
    try {
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });
      const code = await disableCommand({
        path: repo.path,
        purge: true,
        client: buildClient(),
      });
      expect(code).toBe(0);
      const calls = server.requests.filter((r) => r.path === "/api/repos/disable");
      expect(calls).toHaveLength(1);
      expect((calls[0]?.body as { canonical_url: string; purge: boolean }).purge).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});

describe("status command (REQ-046)", () => {
  it("renders a fixed-column table with REPO/STATUS/LOCAL PATH/LAST SYNC", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/status-test.git");
    try {
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });
      const result = statusCommand({ capture: true });
      expect(result.exit).toBe(0);
      expect(result.output).toMatch(/REPO\s+STATUS\s+LOCAL PATH\s+LAST SYNC/);
      expect(result.output).toMatch(/github\.com\/fixture\/status-test\s+enabled/);
    } finally {
      repo.cleanup();
    }
  });
});
