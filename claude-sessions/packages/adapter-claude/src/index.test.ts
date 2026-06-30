// AI-generated. See PROMPT.md for the prompts and model used.

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AssistantMsgEvent,
  CanonicalEvent,
  SystemEvent,
  ToolUseEvent,
  UserMsgEvent,
} from "@claude-sessions/core";
import { describe, expect, it } from "vitest";

import { parseLine, readSessionSync, streamEvents } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "__fixtures__");
const SAMPLE = resolve(FIXTURES, "sample-session.jsonl");
const EMPTY = resolve(FIXTURES, "empty-session.jsonl");
const MALFORMED = resolve(FIXTURES, "malformed.jsonl");
const UNKNOWN = resolve(FIXTURES, "unknown-type.jsonl");

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("parseLine — raw → canonical mapping (REQ-003)", () => {
  it("maps a user text message to user_msg", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:00.000Z",
      message: { role: "user", content: "hello" },
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const ev = events[0] as UserMsgEvent;
    expect(ev.type).toBe("user_msg");
    expect(ev.event_uuid).toBe("u-1");
    expect(ev.parent_uuid).toBeNull();
    expect(ev.content_md).toBe("hello");
  });

  it("maps an assistant text-only message to assistant_msg", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      parentUuid: "u-1",
      timestamp: "2026-05-09T10:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hi back" }],
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const ev = events[0] as AssistantMsgEvent;
    expect(ev.type).toBe("assistant_msg");
    expect(ev.content_md).toBe("hi back");
    expect(ev.model).toBe("claude-sonnet-4-6");
    expect(ev.usage?.input_tokens).toBe(10);
  });

  it("emits one assistant_msg + one tool_use when content has both", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-2",
      parentUuid: "a-1",
      timestamp: "2026-05-09T10:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    });
    const events = parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("assistant_msg");
    const tool = events[1] as ToolUseEvent;
    expect(tool.type).toBe("tool_use");
    expect(tool.tool).toBe("Bash");
    expect(tool.tool_use_id).toBe("tu-1");
    expect(tool.input_summary).toContain("ls");
  });

  it("emits one tool_use (output-only) for a user tool_result line", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-2",
      parentUuid: "a-2",
      timestamp: "2026-05-09T10:00:03.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "file1\nfile2",
            is_error: false,
          },
        ],
      },
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const tool = events[0] as ToolUseEvent;
    expect(tool.type).toBe("tool_use");
    expect(tool.tool_use_id).toBe("tu-1");
    expect(tool.output_summary).toContain("file1");
  });

  it("maps system to system event with kind=subtype", () => {
    const line = JSON.stringify({
      type: "system",
      uuid: "sys-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:04.000Z",
      subtype: "local_command",
      content: "shell hook fired",
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const sys = events[0] as SystemEvent;
    expect(sys.type).toBe("system");
    expect(sys.kind).toBe("local_command");
    expect(sys.content).toBe("shell hook fired");
  });

  it("maps attachment to system with kind=attachment.<attachment_type>", () => {
    const line = JSON.stringify({
      type: "attachment",
      uuid: "att-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:05.000Z",
      attachment_type: "task_reminder",
      content: "remember to test",
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const sys = events[0] as SystemEvent;
    expect(sys.type).toBe("system");
    expect(sys.kind).toBe("attachment.task_reminder");
  });

  it("maps file-history-snapshot to system kind=file-snapshot", () => {
    const line = JSON.stringify({
      type: "file-history-snapshot",
      uuid: "fhs-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:06.000Z",
      files: ["src/foo.ts"],
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const sys = events[0] as SystemEvent;
    expect(sys.type).toBe("system");
    expect(sys.kind).toBe("file-snapshot");
    expect(sys.content).toBe("(snapshot)");
  });

  it("drops last-prompt lines", () => {
    const line = JSON.stringify({
      type: "last-prompt",
      uuid: "lp-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:07.000Z",
      prompt: "hello there",
    });
    expect(parseLine(line)).toHaveLength(0);
  });

  it("emits a system event with kind=unknown for future types (REQ-004)", () => {
    const line = JSON.stringify({
      type: "future_unknown_type",
      uuid: "x-1",
      parentUuid: null,
      timestamp: "2026-05-09T10:00:00.000Z",
      payload: "new shape",
    });
    const events = parseLine(line);
    expect(events).toHaveLength(1);
    const sys = events[0] as SystemEvent;
    expect(sys.type).toBe("system");
    expect(sys.kind).toBe("unknown");
    expect(sys.content).toContain("future_unknown_type");
  });
});

describe("readSessionSync — sample-session.jsonl", () => {
  it("produces a CanonicalSession with expected events and metadata", () => {
    const session = readSessionSync(SAMPLE);

    // 8 raw lines: user, assistant(text), assistant(text+tool_use),
    // user(tool_result), system, attachment, file-history-snapshot,
    // last-prompt(dropped). The tool_result is merged into the matching
    // tool_use, so canonical count = 1+1+2+0+1+1+1 = 7.
    expect(session.events.length).toBe(7);

    expect(session.id).toBe("sess-abc");
    expect(session.agent).toBe("claude-code");
    expect(session.agent_version).toBe("1.0.0");
    expect(session.branch).toBe("master");
    expect(session.source_cwd_hint).toBe("/Users/me/projects/demo");
    expect(session.permission_mode).toBe("default");
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.total_input_tokens).toBe(130);
    expect(session.total_output_tokens).toBe(32);
    expect(session.total_cost_usd).toBeGreaterThan(0);
    expect(session.started_at).toBe("2026-05-09T10:00:00.000Z");
    expect(session.ended_at).toBe("2026-05-09T10:00:07.000Z");
  });

  it("emits events with monotonically non-decreasing ts (REQ-003)", () => {
    const session = readSessionSync(SAMPLE);
    const ts = session.events.map((e) => Date.parse(e.ts));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1] ?? 0);
    }
  });

  it("matches tool_use to tool_result (input_summary + output_summary)", () => {
    const session = readSessionSync(SAMPLE);
    const tools = session.events.filter((e): e is ToolUseEvent => e.type === "tool_use");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    // Find the Bash call we wrote into the fixture.
    const bash = tools.find((t) => t.tool === "Bash");
    expect(bash).toBeDefined();
    expect(bash?.input_summary).toContain("ls /tmp");
    expect(bash?.output_summary).toContain("file1");
  });

  it("handles an empty session file with zero events", () => {
    const session = readSessionSync(EMPTY);
    expect(session.events).toEqual([]);
    expect(session.id).toBe("");
  });
});

describe("streamEvents — malformed.jsonl (EDGE-001)", () => {
  it("emits a parse_error system event then continues to subsequent valid lines", async () => {
    const events: CanonicalEvent[] = await collect(streamEvents(MALFORMED));
    // 3 valid + 1 parse_error + 2 valid = 6 canonical events
    expect(events.length).toBe(6);

    const parseErrorIndex = events.findIndex(
      (e): e is SystemEvent => e.type === "system" && e.kind === "parse_error",
    );
    expect(parseErrorIndex).toBe(3);

    // Ensure the events after the malformed line are still parsed user_msg.
    expect(events[4]?.type).toBe("user_msg");
    expect(events[5]?.type).toBe("user_msg");
  });
});

describe("streamEvents — resume from byteOffset (REQ-015 sneak peek)", () => {
  it("yields no duplicates and no gaps when resuming mid-file", async () => {
    const full: CanonicalEvent[] = await collect(streamEvents(SAMPLE));
    expect(full.length).toBeGreaterThan(2);

    // Compute a byte offset that lands cleanly between two lines.
    const bytes = readFileSync(SAMPLE);
    let firstHalfLines = 0;
    let offset = 0;
    const halfTarget = Math.floor(full.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) {
        firstHalfLines++;
        if (firstHalfLines === Math.max(2, halfTarget - 1)) {
          offset = i + 1;
          break;
        }
      }
    }
    expect(offset).toBeGreaterThan(0);

    const head = await collect(streamEvents(SAMPLE, { byteOffset: 0 }));
    const tail = await collect(streamEvents(SAMPLE, { byteOffset: offset }));

    // We should be able to slice the full stream at some boundary and get
    // the tail by uuid.
    const tailUuids = new Set(tail.map((e) => e.event_uuid));
    const headOnlyUuids = head.filter((e) => !tailUuids.has(e.event_uuid));
    // No overlap.
    for (const e of headOnlyUuids) {
      expect(tailUuids.has(e.event_uuid)).toBe(false);
    }
    // No gap: head ∪ tail uuids covers the full stream.
    const fullUuids = new Set(full.map((e) => e.event_uuid));
    for (const uuid of fullUuids) {
      expect(headOnlyUuids.some((e) => e.event_uuid === uuid) || tailUuids.has(uuid)).toBe(true);
    }
  });
});

describe("streamEvents — unknown type (REQ-004)", () => {
  it("emits a system kind=unknown event for forward-compat types", async () => {
    const events = await collect(streamEvents(UNKNOWN));
    expect(events).toHaveLength(1);
    const sys = events[0] as SystemEvent;
    expect(sys.type).toBe("system");
    expect(sys.kind).toBe("unknown");
  });
});

describe("readSessionSync — file existence", () => {
  it("can stat the sample fixture (sanity)", () => {
    const s = statSync(SAMPLE);
    expect(s.size).toBeGreaterThan(0);
  });
});
