// AI-generated. See PROMPT.md for the prompts and model used.

/**
 * Per-session "end of conversation" detector (REQ-016).
 *
 * Watcher calls `schedule(sessionId)` every time it flushes a batch of
 * events. The detector keeps a single timer per session — each call
 * cancels and reschedules. When 60 s elapse with no further activity, it
 * fires the configured callback once.
 *
 * Tests can drive the timer with `vi.useFakeTimers()` and inject a
 * shorter `silenceMs` if they want to assert without waiting a minute.
 */

export const DEFAULT_SILENCE_MS = 60_000;

export interface SessionEndDetectorOptions {
  silenceMs?: number;
  onEnded: (sessionId: string) => Promise<void> | void;
  /** Override `setTimeout`/`clearTimeout` (for libraries that ship their own). */
  schedulerSetTimeout?: typeof setTimeout;
  schedulerClearTimeout?: typeof clearTimeout;
}

export class SessionEndDetector {
  private silenceMs: number;
  private onEnded: (sessionId: string) => Promise<void> | void;
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: SessionEndDetectorOptions) {
    this.silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
    this.onEnded = opts.onEnded;
    this.setTimeoutFn = opts.schedulerSetTimeout ?? setTimeout;
    this.clearTimeoutFn = opts.schedulerClearTimeout ?? clearTimeout;
  }

  schedule(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) this.clearTimeoutFn(existing);
    const t = this.setTimeoutFn(() => {
      this.timers.delete(sessionId);
      Promise.resolve(this.onEnded(sessionId)).catch((err) => {
        // Safety net; the wrapper Summarizer logs/upserts a failure row.
        process.stderr.write(
          `summarizer end-detect callback failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }, this.silenceMs);
    this.timers.set(sessionId, t);
  }

  /** Stop tracking a session without firing. */
  cancel(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) {
      this.clearTimeoutFn(t);
      this.timers.delete(sessionId);
    }
  }

  /** Stop all sessions. Used when the watcher shuts down. */
  cancelAll(): void {
    for (const t of this.timers.values()) this.clearTimeoutFn(t);
    this.timers.clear();
  }

  /** Test helper. */
  pendingSessions(): string[] {
    return [...this.timers.keys()];
  }
}
