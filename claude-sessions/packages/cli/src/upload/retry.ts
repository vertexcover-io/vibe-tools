// AI-generated. See PROMPT.md for the prompts and model used.

/**
 * Exponential-backoff retry for ingest uploads (REQ-045).
 *
 * Sleep schedule: 1s, 4s, 16s, 60s, 300s — capped at 5 minutes per the
 * spec. After all retries are exhausted the original error propagates so
 * the caller can decide whether to crash, log, or move on. Crucially, the
 * caller MUST NOT advance any persistent offset until this function
 * returns successfully.
 */

export const DELAYS_MS = [1_000, 4_000, 16_000, 60_000, 300_000] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  delaysMs?: readonly number[];
  onAttempt?: (attempt: number, err: unknown) => void;
  /** Return false to bail out without further retries (e.g. 4xx). */
  shouldRetry?: (err: unknown) => boolean;
}

export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> => {
  const delays = opts.delaysMs ?? DELAYS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(attempt, err);
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (attempt < delays.length) {
        await sleep(delays[attempt] as number);
      }
    }
  }
  throw lastErr;
};
