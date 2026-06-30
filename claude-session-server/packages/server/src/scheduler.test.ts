import { describe, it, expect } from "vitest";
import { createPromptScheduler } from "./scheduler.ts";

const defer = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("createPromptScheduler", () => {
  it("schedule returns synchronously without awaiting the task", () => {
    const scheduler = createPromptScheduler();
    const gate = defer();
    let ran = false;
    scheduler.schedule(async () => {
      await gate.promise;
      ran = true;
    });
    expect(ran).toBe(false);
    gate.resolve();
  });

  it("test_REQ_019_single_writer_rejects_concurrent: runs tasks one-at-a-time in submission order", async () => {
    const scheduler = createPromptScheduler();
    const order: number[] = [];
    const running: number[] = [];
    let maxConcurrent = 0;

    const make = (id: number) => async () => {
      running.push(id);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await Promise.resolve();
      order.push(id);
      running.splice(running.indexOf(id), 1);
    };

    scheduler.schedule(make(1));
    scheduler.schedule(make(2));
    scheduler.schedule(make(3));

    await scheduler.idle();
    expect(order).toEqual([1, 2, 3]);
    expect(maxConcurrent).toBe(1);
  });

  it("a thrown task is caught (onError) and does not break the chain", async () => {
    const scheduler = createPromptScheduler();
    const errors: unknown[] = [];
    const order: number[] = [];

    scheduler.schedule(async () => {
      order.push(1);
    });
    scheduler.schedule(
      async () => {
        throw new Error("boom");
      },
      (e) => errors.push(e),
    );
    scheduler.schedule(async () => {
      order.push(3);
    });

    await scheduler.idle();
    expect(order).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("idle resolves when all scheduled tasks settle", async () => {
    const scheduler = createPromptScheduler();
    let done = false;
    const gate = defer();
    scheduler.schedule(async () => {
      await gate.promise;
      done = true;
    });
    const idlePromise = scheduler.idle();
    expect(done).toBe(false);
    gate.resolve();
    await idlePromise;
    expect(done).toBe(true);
  });
});
