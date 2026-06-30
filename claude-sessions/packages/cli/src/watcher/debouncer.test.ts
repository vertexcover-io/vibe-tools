// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it, vi } from "vitest";
import { BatchDebouncer } from "./debouncer.js";

describe("BatchDebouncer", () => {
  it("flushes when maxEvents is reached", async () => {
    const flushed: Array<[string, number[]]> = [];
    const d = new BatchDebouncer<number>({
      maxEvents: 3,
      maxWaitMs: 10_000,
      flush: (sid, events) => {
        flushed.push([sid, [...events]]);
        return Promise.resolve();
      },
    });
    d.push("s1", 1);
    d.push("s1", 2);
    d.push("s1", 3);
    await d.flush("s1");
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(["s1", [1, 2, 3]]);
  });

  it("flushes after maxWaitMs elapses", async () => {
    vi.useFakeTimers();
    const flushed: Array<[string, number[]]> = [];
    const d = new BatchDebouncer<number>({
      maxEvents: 100,
      maxWaitMs: 500,
      flush: (sid, events) => {
        flushed.push([sid, [...events]]);
        return Promise.resolve();
      },
    });
    d.push("s2", 7);
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await d.flush("s2");
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.[1]).toEqual([7]);
  });

  it("groups events by session id", async () => {
    const flushed: Array<[string, number[]]> = [];
    const d = new BatchDebouncer<number>({
      maxEvents: 2,
      maxWaitMs: 10_000,
      flush: (sid, events) => {
        flushed.push([sid, [...events]]);
        return Promise.resolve();
      },
    });
    d.push("a", 1);
    d.push("b", 10);
    d.push("a", 2);
    d.push("b", 20);
    await d.flushAll();
    expect(flushed.find((f) => f[0] === "a")?.[1]).toEqual([1, 2]);
    expect(flushed.find((f) => f[0] === "b")?.[1]).toEqual([10, 20]);
  });
});
