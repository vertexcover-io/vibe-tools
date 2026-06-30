// AI-generated. See PROMPT.md for the prompts and model used.

import type { SessionSummary } from "@claude-sessions/core";
import type { UploadClient } from "../upload/client.js";
import type { runClaude } from "./claude-runner.js";
import { type PipelineDeps, summarizeAndUpload } from "./pipeline.js";
import type { minePrs } from "./pr-mining.js";

export { SessionEndDetector } from "./end-detect.js";
export { computeDeterministic } from "./deterministic.js";
export { runClaude } from "./claude-runner.js";
export { minePrs } from "./pr-mining.js";
export {
  SUMMARY_SCHEMA,
  SYSTEM_PROMPT,
  buildPromptUserMessage,
  TRUNCATION_MARKER,
} from "./prompt.js";
export { summarizeAndUpload } from "./pipeline.js";

/**
 * Concurrency cap: at most 2 `claude -p` invocations in flight at any
 * time across the whole watcher (REQ-019). The simplest implementation
 * is a queue + counter; we resolve the next pending whenever a current
 * one finishes.
 */
class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(public readonly capacity: number) {
    this.slots = capacity;
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.slots -= 1;
  }

  release(): void {
    this.slots += 1;
    const next = this.queue.shift();
    if (next) next();
  }

  inFlight(): number {
    return this.capacity - this.slots;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] as const;

export interface SummarizerOptions {
  upload: UploadClient;
  /** Override the global concurrency cap (default 2). */
  maxConcurrent?: number;
  /** Override per-attempt backoff (tests pass `[]` to fail fast). */
  retryDelaysMs?: readonly number[];
  /** Hook a logger for non-fatal warnings. */
  logger?: (msg: string) => void;
  /** Inject a custom pipeline runner (tests). */
  runPipeline?: (sessionId: string, deps: PipelineDeps) => Promise<SessionSummary>;
  /** Inject a custom claude runner — wired through to the pipeline. */
  runClaudeImpl?: typeof runClaude;
  /** Inject a custom PR-miner. */
  minePrsImpl?: typeof minePrs;
}

/**
 * Wraps `summarizeAndUpload` with a global semaphore and retry policy.
 *
 * On retry exhaustion, posts a `status: "failed"` summary so the UI can
 * surface "summarization failed — retry" without joining a job table.
 */
export class Summarizer {
  private upload: UploadClient;
  private sem: Semaphore;
  private retryDelaysMs: readonly number[];
  private logger: (msg: string) => void;
  private runPipeline: (sessionId: string, deps: PipelineDeps) => Promise<SessionSummary>;
  private runClaudeImpl: typeof runClaude | undefined;
  private minePrsImpl: typeof minePrs | undefined;

  constructor(opts: SummarizerOptions) {
    this.upload = opts.upload;
    this.sem = new Semaphore(opts.maxConcurrent ?? 2);
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.logger = opts.logger ?? ((m) => process.stderr.write(`${m}\n`));
    this.runPipeline = opts.runPipeline ?? summarizeAndUpload;
    this.runClaudeImpl = opts.runClaudeImpl;
    this.minePrsImpl = opts.minePrsImpl;
  }

  inFlight(): number {
    return this.sem.inFlight();
  }

  async summarize(sessionId: string, jsonlPath: string): Promise<SessionSummary> {
    await this.sem.acquire();
    try {
      const deps: PipelineDeps = {
        upload: this.upload,
        jsonlPath,
        ...(this.runClaudeImpl ? { runClaudeImpl: this.runClaudeImpl } : {}),
        ...(this.minePrsImpl ? { minePrsImpl: this.minePrsImpl } : {}),
      };
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
        try {
          return await this.runPipeline(sessionId, deps);
        } catch (err) {
          lastErr = err;
          this.logger(
            `summarize attempt ${attempt + 1} failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (attempt < this.retryDelaysMs.length) {
            const delay = this.retryDelaysMs[attempt] ?? 0;
            if (delay > 0) await sleep(delay);
          }
        }
      }
      // Exhausted retries — best-effort upload of a `failed` row so the
      // UI can offer a retry button.
      const failedSummary: SessionSummary = {
        session_id: sessionId,
        title: "",
        summary: "",
        tags: [],
        files_touched: [],
        prs_referenced: [],
        tool_call_counts: {},
        generated_at: new Date().toISOString(),
        model: "sonnet",
        status: "failed",
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      };
      try {
        await this.upload.uploadSummary(sessionId, failedSummary);
      } catch (uploadErr) {
        this.logger(
          `failed to upload failure marker for ${sessionId}: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
        );
      }
      return failedSummary;
    } finally {
      this.sem.release();
    }
  }
}
