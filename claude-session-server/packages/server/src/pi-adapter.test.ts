import { describe, it, expect } from "vitest";
import { toServerFrame, type ServerFrame } from "./pi-adapter.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const frame = (event: unknown): ServerFrame =>
  toServerFrame(event as AgentSessionEvent);

describe("toServerFrame", () => {
  it("maps text_delta and thinking_delta out of message_update.assistantMessageEvent", () => {
    expect(
      frame({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
      }),
    ).toEqual({ type: "text_delta", contentIndex: 0, delta: "hi" });

    expect(
      frame({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "..." },
      }),
    ).toEqual({ type: "thinking_delta", contentIndex: 1, delta: "..." });
  });

  it("maps tool execution lifecycle frames", () => {
    expect(
      frame({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }),
    ).toEqual({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });

    expect(
      frame({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false }),
    ).toEqual({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false });
  });

  it("extracts usage from turn_end.message", () => {
    expect(
      frame({ type: "turn_end", message: { usage: { inputTokens: 5 } }, toolResults: [] }),
    ).toEqual({ type: "turn_end", usage: { inputTokens: 5 } });
  });

  it("falls back to a raw frame for unmapped events and non-delta inner events", () => {
    const start = { type: "message_start", message: {} };
    expect(frame(start)).toEqual({ type: "raw", event: start });

    const nonDelta = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    };
    expect(frame(nonDelta)).toEqual({ type: "raw", event: nonDelta });
  });
});
