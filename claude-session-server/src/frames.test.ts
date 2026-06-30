import { describe, it, expect } from "vitest";
import { parseInboundFrame, type ServerOutboundFrame } from "./frames.ts";

describe("parseInboundFrame", () => {
  it("parses a prompt frame with optional thinking level", () => {
    expect(parseInboundFrame({ type: "prompt", text: "hi" })).toEqual({
      ok: true,
      frame: { type: "prompt", text: "hi" },
    });

    expect(
      parseInboundFrame({ type: "prompt", text: "hi", thinking: "medium" }),
    ).toEqual({ ok: true, frame: { type: "prompt", text: "hi", thinking: "medium" } });
  });

  it("rejects a prompt with an invalid thinking level", () => {
    const result = parseInboundFrame({ type: "prompt", text: "hi", thinking: "loud" });
    expect(result.ok).toBe(false);
  });

  it("parses steer, follow_up and abort frames", () => {
    expect(parseInboundFrame({ type: "steer", text: "wait" })).toEqual({
      ok: true,
      frame: { type: "steer", text: "wait" },
    });
    expect(parseInboundFrame({ type: "follow_up", text: "later" })).toEqual({
      ok: true,
      frame: { type: "follow_up", text: "later" },
    });
    expect(parseInboundFrame({ type: "abort" })).toEqual({
      ok: true,
      frame: { type: "abort" },
    });
  });

  it("rejects unknown frame types and malformed payloads", () => {
    expect(parseInboundFrame({ type: "nope" }).ok).toBe(false);
    expect(parseInboundFrame({ type: "prompt" }).ok).toBe(false);
    expect(parseInboundFrame("not-an-object").ok).toBe(false);
    expect(parseInboundFrame({ type: "steer", text: 7 }).ok).toBe(false);
  });

  it("serializes outbound error frames with the allowed codes", () => {
    const frame: ServerOutboundFrame = {
      type: "error",
      code: "session_busy",
      message: "busy",
    };
    expect(frame.code).toBe("session_busy");
  });
});
