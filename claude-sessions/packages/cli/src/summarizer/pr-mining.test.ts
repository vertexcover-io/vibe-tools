// AI-generated. See PROMPT.md for the prompts and model used.

import type { ChildProcess, ExecFileException, execFile } from "node:child_process";
import type { CanonicalSession, ToolUseEvent } from "@claude-sessions/core";
import { describe, expect, it } from "vitest";
import { computeDeterministic } from "./deterministic.js";
import { minePrs } from "./pr-mining.js";

type ExecFileFn = typeof execFile;
type ExecFileCb = (err: ExecFileException | null, stdout: string, stderr: string) => void;

const fakeGh = (result: { stdout?: string; throws?: boolean }): ExecFileFn => {
  return ((_cmd: string, _args: readonly string[], _opts: object, cb: ExecFileCb) => {
    setImmediate(() => {
      if (result.throws) {
        const err = new Error("gh missing") as ExecFileException;
        err.code = 1;
        cb(err, "", "command not found");
        return;
      }
      cb(null, result.stdout ?? "", "");
    });
    return {} as ChildProcess;
  }) as unknown as ExecFileFn;
};

const buildSession = (
  repo: string | null,
  branch: string | null,
  events: ToolUseEvent[],
): CanonicalSession => ({
  id: "s-1",
  agent: "claude-code",
  agent_version: "1.0.0",
  repo,
  branch,
  source_cwd_hint: "/tmp",
  started_at: "2026-05-09T10:00:00Z",
  ended_at: "2026-05-09T11:00:00Z",
  model: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost_usd: 0,
  permission_mode: null,
  events,
  raw_jsonl_blob_url: null,
  name: null,
});

const tu = (overrides: Partial<ToolUseEvent>): ToolUseEvent => ({
  type: "tool_use",
  ts: "2026-05-09T10:00:00Z",
  event_uuid: overrides.event_uuid ?? "ev",
  parent_uuid: null,
  raw: {},
  tool: overrides.tool ?? "Bash",
  tool_use_id: overrides.tool_use_id ?? "tu",
  input_summary: overrides.input_summary ?? "",
  ...(overrides.output_summary !== undefined ? { output_summary: overrides.output_summary } : {}),
});

describe("minePrs (REQ-027)", () => {
  it("returns deterministic PRs unchanged when they're already populated", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({
        input_summary: "gh pr create",
        output_summary: "https://github.com/example/repo/pull/7",
        event_uuid: "ev",
      }),
    ]);
    const det = computeDeterministic(session);
    const out = await minePrs(session, det, {
      execFileImpl: fakeGh({ throws: true }),
    });
    expect(out).toEqual(["https://github.com/example/repo/pull/7"]);
  });

  it("falls back to gh pr list when git push happened but no PR URL was captured", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({ input_summary: "git push -u origin feature/x", event_uuid: "ev" }),
    ]);
    const det = computeDeterministic(session);
    expect(det.prs_referenced_mined).toEqual([]);

    const out = await minePrs(session, det, {
      resolveLocalPath: () => "/tmp/repo",
      execFileImpl: fakeGh({
        stdout: JSON.stringify([{ url: "https://github.com/example/repo/pull/9" }]),
      }),
    });
    expect(out).toEqual(["https://github.com/example/repo/pull/9"]);
  });

  it("REQ-028: rejects PRs whose repo does not match the session's canonical repo", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({ input_summary: "git push -u origin feature/x", event_uuid: "ev" }),
    ]);
    const det = computeDeterministic(session);

    const out = await minePrs(session, det, {
      resolveLocalPath: () => "/tmp/repo",
      execFileImpl: fakeGh({
        stdout: JSON.stringify([{ url: "https://github.com/other/owner/pull/9" }]),
      }),
    });
    expect(out).toEqual([]);
  });

  it("returns [] when gh fails (binary missing)", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({ input_summary: "git push -u origin feature/x", event_uuid: "ev" }),
    ]);
    const det = computeDeterministic(session);

    const out = await minePrs(session, det, {
      resolveLocalPath: () => "/tmp/repo",
      execFileImpl: fakeGh({ throws: true }),
    });
    expect(out).toEqual([]);
  });

  it("returns [] when no git push happened", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({ input_summary: "ls -la", event_uuid: "ev" }),
    ]);
    const det = computeDeterministic(session);
    const out = await minePrs(session, det, {
      resolveLocalPath: () => "/tmp/repo",
      execFileImpl: fakeGh({
        stdout: JSON.stringify([{ url: "https://github.com/example/repo/pull/9" }]),
      }),
    });
    expect(out).toEqual([]);
  });

  it("returns [] when local path can't be resolved", async () => {
    const session = buildSession("github.com/example/repo", "feature/x", [
      tu({ input_summary: "git push", event_uuid: "ev" }),
    ]);
    const det = computeDeterministic(session);
    const out = await minePrs(session, det, {
      resolveLocalPath: () => null,
    });
    expect(out).toEqual([]);
  });
});
