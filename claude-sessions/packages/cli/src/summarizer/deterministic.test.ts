// AI-generated. See PROMPT.md for the prompts and model used.

import type { CanonicalEvent, CanonicalSession, ToolUseEvent } from "@claude-sessions/core";
import { describe, expect, it } from "vitest";
import { computeDeterministic } from "./deterministic.js";

const baseToolUse = (overrides: Partial<ToolUseEvent>): ToolUseEvent => ({
  type: "tool_use",
  ts: "2026-05-09T10:00:00.000Z",
  event_uuid: overrides.event_uuid ?? "ev-1",
  parent_uuid: null,
  raw: overrides.raw ?? {},
  tool: overrides.tool ?? "",
  tool_use_id: overrides.tool_use_id ?? "tu-1",
  input_summary: overrides.input_summary ?? "",
  ...(overrides.output_summary !== undefined ? { output_summary: overrides.output_summary } : {}),
  ...(overrides.is_error !== undefined ? { is_error: overrides.is_error } : {}),
});

const buildRawForToolUse = (
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> => ({
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  },
});

const session = (events: CanonicalEvent[]): CanonicalSession => ({
  id: "s-1",
  agent: "claude-code",
  agent_version: "1.0.0",
  repo: null,
  branch: null,
  source_cwd_hint: "/tmp",
  started_at: "2026-05-09T10:00:00.000Z",
  ended_at: "2026-05-09T11:00:00.000Z",
  model: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost_usd: 0,
  permission_mode: null,
  events,
  raw_jsonl_blob_url: null,
  name: null,
});

describe("computeDeterministic", () => {
  it("counts tool_use events by tool name", () => {
    const ev = session([
      baseToolUse({ tool: "Bash", input_summary: "ls -la", event_uuid: "1", tool_use_id: "tu1" }),
      baseToolUse({ tool: "Bash", input_summary: "pwd", event_uuid: "2", tool_use_id: "tu2" }),
      baseToolUse({
        tool: "Read",
        input_summary: "/x.ts",
        event_uuid: "3",
        tool_use_id: "tu3",
      }),
    ]);
    const out = computeDeterministic(ev);
    expect(out.tool_call_counts).toEqual({ Bash: 2, Read: 1 });
  });

  it("mines files_touched from Edit/Write/MultiEdit/Read raw inputs (deduped)", () => {
    const ev = session([
      baseToolUse({
        tool: "Read",
        tool_use_id: "tu-r1",
        raw: buildRawForToolUse("tu-r1", "Read", { file_path: "/repo/a.ts" }),
        input_summary: "/repo/a.ts",
        event_uuid: "1",
      }),
      baseToolUse({
        tool: "Edit",
        tool_use_id: "tu-e1",
        raw: buildRawForToolUse("tu-e1", "Edit", { file_path: "/repo/a.ts" }),
        input_summary: "/repo/a.ts",
        event_uuid: "2",
      }),
      baseToolUse({
        tool: "Write",
        tool_use_id: "tu-w1",
        raw: buildRawForToolUse("tu-w1", "Write", { file_path: "/repo/b.ts" }),
        input_summary: "/repo/b.ts",
        event_uuid: "3",
      }),
      baseToolUse({
        tool: "MultiEdit",
        tool_use_id: "tu-m1",
        raw: buildRawForToolUse("tu-m1", "MultiEdit", {
          file_path: "/repo/c.ts",
          edits: [{ file_path: "/repo/c.ts" }, { file_path: "/repo/d.ts" }],
        }),
        input_summary: "/repo/c.ts",
        event_uuid: "4",
      }),
    ]);
    const out = computeDeterministic(ev);
    expect(out.files_touched_raw).toEqual(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts"]);
  });

  it("mines GitHub PR URLs from Bash gh pr create / git push outputs", () => {
    const ev = session([
      baseToolUse({
        tool: "Bash",
        tool_use_id: "tu-1",
        input_summary: "gh pr create --fill",
        output_summary: "Creating pull request... https://github.com/example/repo/pull/42",
        event_uuid: "1",
      }),
      baseToolUse({
        tool: "Bash",
        tool_use_id: "tu-2",
        input_summary: "git push -u origin feature/x",
        output_summary: "remote: https://github.com/example/repo/pull/43",
        event_uuid: "2",
      }),
    ]);
    const out = computeDeterministic(ev);
    expect(out.prs_referenced_mined).toEqual([
      "https://github.com/example/repo/pull/42",
      "https://github.com/example/repo/pull/43",
    ]);
  });

  it("dedupes PR URLs and ignores non-PR github links", () => {
    const ev = session([
      baseToolUse({
        tool: "Bash",
        input_summary: "gh pr create",
        output_summary:
          "https://github.com/example/repo/pull/42 also https://github.com/example/repo/pull/42 and https://github.com/example/repo/blob/main/x.ts",
        tool_use_id: "tu-1",
        event_uuid: "1",
      }),
    ]);
    const out = computeDeterministic(ev);
    expect(out.prs_referenced_mined).toEqual(["https://github.com/example/repo/pull/42"]);
  });

  it("does not crash when tool_use has no input/output (interrupted)", () => {
    const ev = session([
      baseToolUse({ tool: "Bash", input_summary: "", tool_use_id: "tu-empty", event_uuid: "1" }),
    ]);
    const out = computeDeterministic(ev);
    expect(out.tool_call_counts).toEqual({ Bash: 1 });
    expect(out.prs_referenced_mined).toEqual([]);
  });
});
