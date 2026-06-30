// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, statSync } from "node:fs";
import { streamEvents } from "@claude-sessions/adapter-claude";
import { type CanonicalEvent, redact } from "@claude-sessions/core";
import { listRepos } from "../config/repos.js";
import { getFileState, setFileState } from "../config/state.js";
import { readSessionMeta } from "../discover.js";
import type { IngestEvent, IngestPayload, UploadClient } from "../upload/client.js";
import { isSessionMarkedPrivate } from "./privacy.js";

/**
 * Walk an arbitrary value, redacting every string leaf in place. Wraps the
 * core single-string `redact()` so we strip secrets from `payload` blobs
 * before they leave the device (REQ-005).
 */
const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redact(value).redacted;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
};

const toIngestEvent = (ev: CanonicalEvent): IngestEvent => ({
  event_uuid: ev.event_uuid,
  parent_uuid: ev.parent_uuid,
  ts: ev.ts,
  type: ev.type,
  payload: redactDeep(ev.raw),
});

export interface ConsumeOptions {
  /** When false, only attempt to read past the persisted offset. */
  fullScan?: boolean;
  /** Override the repo lookup (tests can hand in a stub). */
  isPathEnabled?: (cwd: string) => boolean;
}

export interface ConsumeResult {
  uploaded: number;
  skipped: boolean;
  reason?: string;
}

const buildSessionPayload = (
  sessionId: string,
  cwd: string,
  events: CanonicalEvent[],
  canonicalUrl: string,
): IngestPayload => {
  const ts0 = events[0]?.ts ?? new Date().toISOString();
  const tsN = events[events.length - 1]?.ts ?? ts0;
  let model: string | null = null;
  let inTokens = 0;
  let outTokens = 0;
  for (const ev of events) {
    if (ev.type === "assistant_msg") {
      if (ev.model) model = ev.model;
      if (ev.usage) {
        inTokens += ev.usage.input_tokens ?? 0;
        outTokens += ev.usage.output_tokens ?? 0;
      }
    }
  }
  return {
    session: {
      id: sessionId,
      agent: "claude-code",
      agent_version: "1.0.0",
      repo: { canonical_url: canonicalUrl, branch: null },
      source_cwd_hint: cwd,
      started_at: ts0,
      ended_at: tsN,
      model,
      permission_mode: null,
      total_input_tokens: inTokens,
      total_output_tokens: outTokens,
      total_cost_usd: 0,
    },
    events: events.map(toIngestEvent),
  };
};

const repoForCwd = (
  cwd: string,
): { canonical_url: string; entry: { local_path: string } } | null => {
  // Match by exact local_path; the watcher only enables canonical paths.
  for (const r of listRepos()) {
    if (r.entry.enabled && r.entry.local_path === cwd) return r;
  }
  return null;
};

/**
 * Consume new bytes from a single JSONL file → POST → advance offset.
 *
 * Strict ordering: the persisted byte offset advances ONLY after the upload
 * resolves successfully (REQ-045). On failure, the offset stays put, the
 * watcher's next tick re-reads, and the server dedupes on `event_uuid`.
 *
 * Inode replacement (EDGE-002): the previous offset may now point past the
 * new file's end. We detect that via `stat` and reset the offset to 0 so
 * we re-emit the new file's contents. Server still dedupes by event_uuid
 * if the file is a copy.
 */
export const consumeFile = async (
  path: string,
  client: UploadClient,
  opts: ConsumeOptions = {},
): Promise<ConsumeResult> => {
  if (!existsSync(path)) return { uploaded: 0, skipped: true, reason: "missing" };
  void opts;

  const cur = getFileState(path);
  let offset = opts.fullScan ? 0 : (cur?.byte_offset ?? 0);
  const size = statSync(path).size;
  // EDGE-002: file shrunk (rotation/inode replacement) — reset offset.
  if (size < offset) offset = 0;
  if (size === offset) return { uploaded: 0, skipped: true, reason: "no-new-bytes" };

  const meta = readSessionMeta(path);
  if (!meta.cwd) return { uploaded: 0, skipped: true, reason: "no-cwd" };

  const repo = (opts.isPathEnabled ?? ((cwd) => repoForCwd(cwd) !== null))(meta.cwd)
    ? repoForCwd(meta.cwd)
    : null;
  if (!repo) return { uploaded: 0, skipped: true, reason: "not-enabled" };

  // REQ-040 + EDGE-018/EDGE-019: a sidecar marker withdraws the session
  // and stops further uploads. We advance the byte offset to "current EOF"
  // so we don't re-stream these events on the next tick — the sidecar is
  // the single source of truth, not the event log.
  if (meta.session_id && isSessionMarkedPrivate(meta.session_id)) {
    try {
      await client.patchSession(meta.session_id, { is_private: true });
    } catch {
      // If the cloud copy was never uploaded, PATCH returns 404 — that's
      // fine: nothing to withdraw. Other errors we deliberately swallow
      // here too; the sidecar still blocks the upload, and the next tick
      // will retry. Surfacing the error would block the watcher.
    }
    await setFileState(path, {
      byte_offset: size,
      last_event_uuid: cur?.last_event_uuid ?? null,
      session_id: meta.session_id,
      last_seen_at: new Date().toISOString(),
    });
    return { uploaded: 0, skipped: true, reason: "private" };
  }

  const collected: CanonicalEvent[] = [];
  for await (const ev of streamEvents(path, { byteOffset: offset })) {
    collected.push(ev);
  }
  if (collected.length === 0) {
    await setFileState(path, {
      byte_offset: size,
      last_event_uuid: cur?.last_event_uuid ?? null,
      session_id: meta.session_id ?? cur?.session_id ?? null,
      last_seen_at: new Date().toISOString(),
    });
    return { uploaded: 0, skipped: true, reason: "no-events" };
  }

  const sessionId = meta.session_id ?? collected[0]?.event_uuid ?? path;
  const payload = buildSessionPayload(sessionId, meta.cwd, collected, repo.canonical_url);

  // Upload first; only on success do we persist the new offset.
  await client.ingest(payload);

  const lastUuid = collected[collected.length - 1]?.event_uuid ?? null;
  await setFileState(path, {
    byte_offset: size,
    last_event_uuid: lastUuid,
    session_id: sessionId,
    last_seen_at: new Date().toISOString(),
  });

  return { uploaded: collected.length, skipped: false };
};

// Lookup helper exposed for tests.
export const _internal = { redactDeep, repoForCwd, buildSessionPayload };
