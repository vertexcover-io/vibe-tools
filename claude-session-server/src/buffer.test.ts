import { describe, it, expect } from "vitest";
import { createRingBuffer } from "./buffer.ts";
import type { ServerFrame } from "./pi-adapter.ts";

const delta = (text: string): ServerFrame => ({
  type: "text_delta",
  contentIndex: 0,
  delta: text,
});

describe("createRingBuffer", () => {
  it("test_REQ_015_detached_turn_buffers_output: drain replays pushed frames in order, not truncated", () => {
    const buffer = createRingBuffer<ServerFrame>(4);
    buffer.push(delta("a"));
    buffer.push(delta("b"));

    expect(buffer.size).toBe(2);
    const { frames, truncated } = buffer.drain();
    expect(frames).toEqual([delta("a"), delta("b")]);
    expect(truncated).toBe(false);
  });

  it("drain empties the buffer", () => {
    const buffer = createRingBuffer<ServerFrame>(4);
    buffer.push(delta("a"));
    buffer.drain();
    expect(buffer.size).toBe(0);
    expect(buffer.drain().frames).toEqual([]);
  });

  it("test_EDGE_014_buffer_overflow_truncates: overflow drops oldest and marks truncated", () => {
    const buffer = createRingBuffer<ServerFrame>(2);
    buffer.push(delta("a"));
    buffer.push(delta("b"));
    buffer.push(delta("c"));

    expect(buffer.size).toBe(2);
    const { frames, truncated } = buffer.drain();
    expect(frames).toEqual([delta("b"), delta("c")]);
    expect(truncated).toBe(true);
  });

  it("truncated flag resets after drain", () => {
    const buffer = createRingBuffer<ServerFrame>(1);
    buffer.push(delta("a"));
    buffer.push(delta("b"));
    expect(buffer.drain().truncated).toBe(true);

    buffer.push(delta("c"));
    const second = buffer.drain();
    expect(second.frames).toEqual([delta("c")]);
    expect(second.truncated).toBe(false);
  });
});
