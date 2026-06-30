// AI-generated. See PROMPT.md for the prompts and model used.

import { dirname } from "node:path";
import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import { listRepos } from "../config/repos.js";
import { readSessionMeta } from "../discover.js";
import { findSessionsForRepo } from "../discover.js";
import { SessionEndDetector } from "../summarizer/end-detect.js";
import type { Summarizer } from "../summarizer/index.js";
import { HttpError, type UploadClient } from "../upload/client.js";
import { consumeFile } from "./consume.js";

/**
 * Long-running JSONL tail. Watches the parent directories of every JSONL
 * we already know about for an enabled repo, plus picks up new JSONL
 * files as Claude rotates / starts new sessions.
 *
 * `start()` does an initial catch-up pass before installing the chokidar
 * listener so REQ-013 (backfill on watcher start) is satisfied.
 */

export interface JsonlWatcherOptions {
  client: UploadClient;
  /** Override the file discovery (tests inject a fixed list). */
  discover?: () => string[];
  /** Override the chokidar watcher (tests inject a stub). */
  chokidarFactory?: typeof chokidarWatch;
  /** Where to log warnings (default: console.error). */
  logger?: (msg: string) => void;
  /** Summarizer to invoke after 60s of silence on a session. */
  summarizer?: Summarizer;
  /** Override silence ms (tests). */
  silenceMs?: number;
}

const defaultDiscover = (): string[] => {
  const out = new Set<string>();
  for (const r of listRepos()) {
    if (!r.entry.enabled) continue;
    for (const f of findSessionsForRepo(r.canonical_url, [r.entry.local_path])) {
      out.add(f.path);
    }
  }
  return Array.from(out);
};

export class JsonlWatcher {
  private opts: JsonlWatcherOptions;
  private watcher: FSWatcher | null = null;
  private inflight = new Map<string, Promise<void>>();
  private endDetector: SessionEndDetector | null = null;
  /** path → sessionId so the end-detect callback knows what jsonl to read. */
  private sessionPaths = new Map<string, string>();

  constructor(opts: JsonlWatcherOptions) {
    this.opts = opts;
    if (opts.summarizer) {
      const summarizer = opts.summarizer;
      this.endDetector = new SessionEndDetector({
        ...(opts.silenceMs !== undefined ? { silenceMs: opts.silenceMs } : {}),
        onEnded: async (sessionId) => {
          const path = this.sessionPaths.get(sessionId);
          if (!path) return;
          await summarizer.summarize(sessionId, path);
        },
      });
    }
  }

  async start(): Promise<void> {
    const files = (this.opts.discover ?? defaultDiscover)();
    // Catch-up pass first.
    for (const f of files) await this.consumeSafe(f);
    // Then install live watcher on parent directories.
    const dirs = Array.from(new Set(files.map((f) => dirname(f))));
    if (dirs.length === 0) return;
    const factory = this.opts.chokidarFactory ?? chokidarWatch;
    this.watcher = factory(dirs, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
    });
    const onChange = (p: string): void => {
      if (!p.endsWith(".jsonl")) return;
      void this.consumeSafe(p);
    };
    this.watcher.on("change", onChange);
    this.watcher.on("add", onChange);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.endDetector?.cancelAll();
    await Promise.allSettled(this.inflight.values());
  }

  /** Wait for any in-flight consume to settle (test helper). */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inflight.values());
  }

  private async consumeSafe(path: string): Promise<void> {
    // Serialize per-file so a quick burst of writes doesn't trigger
    // overlapping consumes that would race on `state.json`.
    const prev = this.inflight.get(path) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          await consumeFile(path, this.opts.client);
          this.scheduleEndDetect(path);
        } catch (err) {
          const log = this.opts.logger ?? ((m) => console.error(m));
          if (err instanceof HttpError) {
            log(`upload failed for ${path}: ${err.message}`);
          } else {
            log(`consume failed for ${path}: ${(err as Error).message ?? err}`);
          }
        }
      });
    this.inflight.set(
      path,
      next.finally(() => {
        if (this.inflight.get(path) === next) this.inflight.delete(path);
      }),
    );
    await next;
  }

  private scheduleEndDetect(path: string): void {
    if (!this.endDetector) return;
    const meta = readSessionMeta(path);
    if (!meta.session_id) return;
    this.sessionPaths.set(meta.session_id, path);
    this.endDetector.schedule(meta.session_id);
  }
}
