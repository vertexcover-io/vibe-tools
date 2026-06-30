// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import type {
  AssistantMsgEvent,
  CanonicalEvent,
  CanonicalSession,
  SummaryEvent,
  SystemEvent,
  ToolUseEvent,
  UserMsgEvent,
} from "./types.js";

const sampleEvents: CanonicalEvent[] = [
  {
    type: "user_msg",
    ts: "2026-05-09T10:00:00.000Z",
    event_uuid: "u-1",
    parent_uuid: null,
    raw: { role: "user", content: "hello" },
    content_md: "hello",
  },
  {
    type: "assistant_msg",
    ts: "2026-05-09T10:00:01.000Z",
    event_uuid: "a-1",
    parent_uuid: "u-1",
    raw: { role: "assistant" },
    content_md: "hi",
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  {
    type: "tool_use",
    ts: "2026-05-09T10:00:02.000Z",
    event_uuid: "t-1",
    parent_uuid: "a-1",
    raw: { name: "Bash" },
    tool: "Bash",
    tool_use_id: "tu-1",
    input_summary: "ls /tmp",
    output_summary: "file1\nfile2",
    is_error: false,
  },
  {
    type: "summary",
    ts: "2026-05-09T10:00:03.000Z",
    event_uuid: "s-1",
    parent_uuid: null,
    raw: {},
    content: "Compaction summary text",
  },
  {
    type: "system",
    ts: "2026-05-09T10:00:04.000Z",
    event_uuid: "sys-1",
    parent_uuid: null,
    raw: { type: "future_unknown" },
    kind: "unknown",
    content: "future event payload",
  },
];

describe("CanonicalSession", () => {
  it("round-trips through JSON encode/decode", () => {
    const session: CanonicalSession = {
      id: "sess-1",
      agent: "claude-code",
      agent_version: "1.0.0",
      repo: "github.com/vertexcover-io/vibe-tools",
      branch: "master",
      source_cwd_hint: "/Users/me/projects/vibe-tools",
      started_at: "2026-05-09T10:00:00.000Z",
      ended_at: "2026-05-09T10:05:00.000Z",
      model: "claude-sonnet-4-6",
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cost_usd: 0.001,
      permission_mode: "default",
      events: sampleEvents,
      raw_jsonl_blob_url: null,
      name: null,
    };

    const encoded = JSON.stringify(session);
    const decoded = JSON.parse(encoded) as CanonicalSession;
    expect(decoded).toEqual(session);
  });

  it("accepts a fixture with all required fields per REQ-001", () => {
    const session: CanonicalSession = {
      id: "sess-2",
      agent: "claude-code",
      agent_version: "1.0.0",
      repo: null,
      branch: null,
      source_cwd_hint: "/tmp",
      started_at: "2026-05-09T10:00:00.000Z",
      ended_at: "2026-05-09T10:00:00.000Z",
      model: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      permission_mode: null,
      events: [],
      raw_jsonl_blob_url: null,
      name: null,
    };
    expect(session.id).toBe("sess-2");
    expect(session.events).toEqual([]);
  });
});

describe("CanonicalEvent variants", () => {
  it("discriminates all 5 variants via TS narrowing", () => {
    const seen: Record<string, number> = {};

    for (const event of sampleEvents) {
      switch (event.type) {
        case "user_msg": {
          const e: UserMsgEvent = event;
          expect(e.content_md).toBeTypeOf("string");
          break;
        }
        case "assistant_msg": {
          const e: AssistantMsgEvent = event;
          expect(e.content_md).toBeTypeOf("string");
          break;
        }
        case "tool_use": {
          const e: ToolUseEvent = event;
          expect(e.tool).toBeTypeOf("string");
          expect(e.tool_use_id).toBeTypeOf("string");
          break;
        }
        case "summary": {
          const e: SummaryEvent = event;
          expect(e.content).toBeTypeOf("string");
          break;
        }
        case "system": {
          const e: SystemEvent = event;
          expect(e.kind).toBeTypeOf("string");
          break;
        }
      }
      seen[event.type] = (seen[event.type] ?? 0) + 1;
    }

    expect(seen).toEqual({
      user_msg: 1,
      assistant_msg: 1,
      tool_use: 1,
      summary: 1,
      system: 1,
    });
  });

  it("round-trips every variant through JSON without losing fields", () => {
    for (const event of sampleEvents) {
      const decoded = JSON.parse(JSON.stringify(event)) as CanonicalEvent;
      expect(decoded).toEqual(event);
    }
  });
});
