// AI-generated. See PROMPT.md for the prompts and model used.

import type { CanonicalEvent } from "@claude-sessions/core";

/**
 * Group canonical events by sessionId and flush them as batches.
 *
 * Flush triggers (whichever first):
 *   - `maxEvents` events accumulated for any one session
 *   - `maxWaitMs` since the first event in a batch arrived
 *   - explicit `flush()` / `flushAll()` calls (e.g. on consume completion)
 *
 * The flush callback is awaited so callers can sequence "successful POST →
 * advance offset" without races.
 */

export interface BatchDebouncerOptions<E = CanonicalEvent> {
  maxEvents: number;
  maxWaitMs: number;
  flush: (sessionId: string, events: E[]) => Promise<void>;
}

interface Pending<E> {
  events: E[];
  timer: NodeJS.Timeout | null;
}

export class BatchDebouncer<E = CanonicalEvent> {
  private opts: BatchDebouncerOptions<E>;
  private buffers = new Map<string, Pending<E>>();
  private inflight = new Map<string, Promise<void>>();

  constructor(opts: BatchDebouncerOptions<E>) {
    this.opts = opts;
  }

  push(sessionId: string, event: E): void {
    let pending = this.buffers.get(sessionId);
    if (!pending) {
      pending = { events: [], timer: null };
      this.buffers.set(sessionId, pending);
    }
    pending.events.push(event);
    if (pending.events.length >= this.opts.maxEvents) {
      this.scheduleFlush(sessionId, true);
    } else if (!pending.timer) {
      pending.timer = setTimeout(() => this.scheduleFlush(sessionId, false), this.opts.maxWaitMs);
    }
  }

  private scheduleFlush(sessionId: string, immediate: boolean): void {
    const pending = this.buffers.get(sessionId);
    if (!pending || pending.events.length === 0) return;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const events = pending.events.splice(0, pending.events.length);
    const prev = this.inflight.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.opts.flush(sessionId, events));
    this.inflight.set(
      sessionId,
      next.finally(() => {
        if (this.inflight.get(sessionId) === next) this.inflight.delete(sessionId);
      }),
    );
    void immediate;
  }

  async flush(sessionId: string): Promise<void> {
    this.scheduleFlush(sessionId, true);
    const inflight = this.inflight.get(sessionId);
    if (inflight) await inflight;
  }

  async flushAll(): Promise<void> {
    for (const id of this.buffers.keys()) this.scheduleFlush(id, true);
    const all = Array.from(this.inflight.values());
    await Promise.allSettled(all);
  }
}
