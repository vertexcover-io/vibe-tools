// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
  it("returns immediately on success", async () => {
    let calls = 0;
    const out = await retryWithBackoff(() => {
      calls++;
      return Promise.resolve("ok");
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure and ultimately returns success", async () => {
    let calls = 0;
    const out = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("nope"));
        return Promise.resolve("ok");
      },
      { delaysMs: [0, 0, 0, 0, 0] },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows after exhausting all delays", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.reject(new Error("always fails"));
        },
        { delaysMs: [0, 0] },
      ),
    ).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });

  it("respects shouldRetry === false (no further attempts)", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.reject(new Error("4xx"));
        },
        { delaysMs: [0, 0, 0], shouldRetry: () => false },
      ),
    ).rejects.toThrow("4xx");
    expect(calls).toBe(1);
  });

  it("uses fake timers correctly for backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("nope"));
        return Promise.resolve("done");
      },
      { delaysMs: [1_000, 4_000, 16_000] },
    );
    // Advance through the schedule.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    expect(result).toBe("done");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});
