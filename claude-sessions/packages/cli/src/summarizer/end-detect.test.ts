// AI-generated. See PROMPT.md for the prompts and model used.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEndDetector } from "./end-detect.js";

describe("SessionEndDetector (REQ-016)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the callback once after 60s of silence", async () => {
    const calls: string[] = [];
    const det = new SessionEndDetector({
      silenceMs: 60_000,
      onEnded: (id) => {
        calls.push(id);
      },
    });
    det.schedule("s1");
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["s1"]);
  });

  it("rescheduling within the window resets the timer", async () => {
    const calls: string[] = [];
    const det = new SessionEndDetector({
      silenceMs: 60_000,
      onEnded: (id) => {
        calls.push(id);
      },
    });
    det.schedule("s2");
    await vi.advanceTimersByTimeAsync(50_000);
    det.schedule("s2"); // resets clock
    await vi.advanceTimersByTimeAsync(50_000);
    expect(calls).toHaveLength(0); // 50s after reschedule, not yet 60
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual(["s2"]);
  });

  it("cancel() prevents firing", async () => {
    const calls: string[] = [];
    const det = new SessionEndDetector({
      silenceMs: 60_000,
      onEnded: (id) => {
        calls.push(id);
      },
    });
    det.schedule("s3");
    det.cancel("s3");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(0);
  });

  it("tracks multiple sessions independently", async () => {
    const calls: string[] = [];
    const det = new SessionEndDetector({
      silenceMs: 60_000,
      onEnded: (id) => {
        calls.push(id);
      },
    });
    det.schedule("a");
    await vi.advanceTimersByTimeAsync(30_000);
    det.schedule("b");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(["a", "b"]);
  });
});
