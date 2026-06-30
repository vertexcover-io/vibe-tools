// AI-generated. See PROMPT.md for the prompts and model used.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CanonicalEvent, SystemEvent } from "@claude-sessions/core";

import { parseLine } from "./index.js";

/**
 * Streaming reader for Claude Code JSONL files.
 *
 * Yields canonical events line-by-line. A malformed JSON line emits a
 * synthetic `system` event with `kind: "parse_error"` (EDGE-001) so the
 * stream survives bad data without dropping subsequent valid events.
 *
 * Supports resumable reads via `byteOffset`: the file watcher persists
 * the last-processed offset (REQ-015) and reopens at that position on
 * restart.
 */
export interface AdapterOptions {
  byteOffset?: number;
}

export async function* streamEvents(
  path: string,
  opts: AdapterOptions = {},
): AsyncIterable<CanonicalEvent> {
  const stream = createReadStream(path, {
    start: opts.byteOffset ?? 0,
    encoding: "utf8",
  });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const events = parseLine(line);
      for (const ev of events) yield ev;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const sys: SystemEvent = {
        type: "system",
        kind: "parse_error",
        ts: new Date().toISOString(),
        event_uuid: `parse-error-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        parent_uuid: null,
        content: message,
        raw: { line },
      };
      yield sys;
    }
  }
}
