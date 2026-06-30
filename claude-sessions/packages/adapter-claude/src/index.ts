// AI-generated. See PROMPT.md for the prompts and model used.

import { readFileSync } from "node:fs";
import {
  type AssistantMsgEvent,
  type CanonicalEvent,
  type CanonicalSession,
  type SystemEvent,
  type ToolUseEvent,
  type UserMsgEvent,
  computeCostUsd,
} from "@claude-sessions/core";

export { streamEvents, type AdapterOptions } from "./stream.js";

export const ADAPTER_NAME = "claude-code";

/**
 * Loosely-typed shape of a Claude Code JSONL line. Fields not on the
 * canonical event live in `raw`; we type only what we actively read.
 */
interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  permissionMode?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  subtype?: string;
  attachment_type?: string;
  content?: unknown;
  prompt?: unknown;
  files?: unknown;
}

interface AssistantContentText {
  type: "text";
  text?: string;
}

interface AssistantContentToolUse {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

interface UserContentToolResult {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const SUMMARY_MAX = 200;

function clip(s: string, max = SUMMARY_MAX): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return clip(input);
  if (typeof input === "object") {
    // Common Claude Code shape — `command` for Bash, `file_path` for Edit/Read, etc.
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return clip(o.command);
    if (typeof o.file_path === "string") return clip(o.file_path);
    if (typeof o.path === "string") return clip(o.path);
    if (typeof o.query === "string") return clip(o.query);
    try {
      return clip(JSON.stringify(input));
    } catch {
      return clip(String(input));
    }
  }
  return clip(String(input));
}

function summarizeToolOutput(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return clip(content);
  if (Array.isArray(content)) {
    // Claude tool_result content is sometimes an array of {type:"text",text:...}
    const parts: string[] = [];
    for (const c of content) {
      if (
        c &&
        typeof c === "object" &&
        "text" in c &&
        typeof (c as { text?: unknown }).text === "string"
      ) {
        parts.push((c as { text: string }).text);
      } else if (typeof c === "string") {
        parts.push(c);
      }
    }
    return clip(parts.join("\n"));
  }
  try {
    return clip(JSON.stringify(content));
  } catch {
    return clip(String(content));
  }
}

function isAssistantText(c: unknown): c is AssistantContentText {
  return !!c && typeof c === "object" && (c as { type?: unknown }).type === "text";
}
function isAssistantToolUse(c: unknown): c is AssistantContentToolUse {
  return !!c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use";
}
function isUserToolResult(c: unknown): c is UserContentToolResult {
  return !!c && typeof c === "object" && (c as { type?: unknown }).type === "tool_result";
}

function baseFields(raw: RawLine): {
  ts: string;
  event_uuid: string;
  parent_uuid: string | null;
} {
  return {
    ts: raw.timestamp ?? new Date(0).toISOString(),
    event_uuid: raw.uuid ?? "",
    parent_uuid: raw.parentUuid ?? null,
  };
}

function parseUser(raw: RawLine): CanonicalEvent[] {
  const content = raw.message?.content;
  // user-shaped tool_result: emit a tool_use event with output_summary populated.
  if (Array.isArray(content)) {
    const events: CanonicalEvent[] = [];
    for (const c of content) {
      if (isUserToolResult(c)) {
        const tool: ToolUseEvent = {
          type: "tool_use",
          ...baseFields(raw),
          raw,
          tool: "",
          tool_use_id: c.tool_use_id ?? "",
          input_summary: "",
          output_summary: summarizeToolOutput(c.content),
          is_error: c.is_error === true,
        };
        events.push(tool);
      }
    }
    if (events.length > 0) return events;
    // Array but no tool_result — treat as plain user_msg with stringified content.
    const userEv: UserMsgEvent = {
      type: "user_msg",
      ...baseFields(raw),
      raw,
      content_md: stringifyContent(content),
    };
    return [userEv];
  }

  const userEv: UserMsgEvent = {
    type: "user_msg",
    ...baseFields(raw),
    raw,
    content_md: stringifyContent(content),
  };
  return [userEv];
}

function parseAssistant(raw: RawLine): CanonicalEvent[] {
  const content = raw.message?.content;
  const model = typeof raw.message?.model === "string" ? raw.message.model : undefined;
  const usage = raw.message?.usage
    ? {
        input_tokens: raw.message.usage.input_tokens ?? 0,
        output_tokens: raw.message.usage.output_tokens ?? 0,
        cache_creation_input_tokens: raw.message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: raw.message.usage.cache_read_input_tokens,
      }
    : undefined;

  const events: CanonicalEvent[] = [];

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const toolBlocks: AssistantContentToolUse[] = [];
    for (const c of content) {
      if (isAssistantText(c) && typeof c.text === "string") {
        textParts.push(c.text);
      } else if (isAssistantToolUse(c)) {
        toolBlocks.push(c);
      }
    }

    if (textParts.length > 0 || toolBlocks.length === 0) {
      const ev: AssistantMsgEvent = {
        type: "assistant_msg",
        ...baseFields(raw),
        raw,
        content_md: textParts.join("\n"),
        ...(model !== undefined ? { model } : {}),
        ...(usage !== undefined ? { usage } : {}),
      };
      events.push(ev);
    }

    for (const tb of toolBlocks) {
      const tool: ToolUseEvent = {
        type: "tool_use",
        ...baseFields(raw),
        raw,
        tool: tb.name ?? "",
        tool_use_id: tb.id ?? "",
        input_summary: summarizeToolInput(tb.input),
      };
      events.push(tool);
    }
    return events;
  }

  // Non-array content (rare): treat as plain text.
  const ev: AssistantMsgEvent = {
    type: "assistant_msg",
    ...baseFields(raw),
    raw,
    content_md: stringifyContent(content),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
  return [ev];
}

function parseSystem(raw: RawLine): CanonicalEvent[] {
  const ev: SystemEvent = {
    type: "system",
    ...baseFields(raw),
    raw,
    kind: typeof raw.subtype === "string" && raw.subtype.length > 0 ? raw.subtype : "system",
    content: stringifyContent(raw.content),
  };
  return [ev];
}

function parseAttachment(raw: RawLine): CanonicalEvent[] {
  const subtype = typeof raw.attachment_type === "string" ? raw.attachment_type : "unknown";
  const ev: SystemEvent = {
    type: "system",
    ...baseFields(raw),
    raw,
    kind: `attachment.${subtype}`,
    content: stringifyContent(raw.content),
  };
  return [ev];
}

function parseFileSnapshot(raw: RawLine): CanonicalEvent[] {
  const ev: SystemEvent = {
    type: "system",
    ...baseFields(raw),
    raw,
    kind: "file-snapshot",
    content: "(snapshot)",
  };
  return [ev];
}

function parseUnknown(raw: RawLine): CanonicalEvent[] {
  const ev: SystemEvent = {
    type: "system",
    ...baseFields(raw),
    raw,
    kind: "unknown",
    content: stringifyContent(raw),
  };
  return [ev];
}

/**
 * Parse a single Claude Code JSONL line into 0+ canonical events.
 *
 * - `last-prompt` lines are dropped (display state, not history).
 * - Unknown `type` values produce a `system` event with `kind: "unknown"`
 *   so we never lose data going forward (REQ-004).
 * - Throws on malformed JSON; callers (streamEvents) translate the throw
 *   into a `parse_error` system event (EDGE-001).
 */
export function parseLine(line: string): CanonicalEvent[] {
  const raw = JSON.parse(line) as RawLine;
  switch (raw.type) {
    case "user":
      return parseUser(raw);
    case "assistant":
      return parseAssistant(raw);
    case "system":
      return parseSystem(raw);
    case "attachment":
      return parseAttachment(raw);
    case "file-history-snapshot":
      return parseFileSnapshot(raw);
    case "last-prompt":
      return [];
    default:
      return parseUnknown(raw);
  }
}

/**
 * Read a session's full JSONL file into a CanonicalSession.
 *
 * Aggregates session-level metadata from the first/last events and sums
 * usage across assistant turns to compute cost (REQ-001). Tool-use ↔
 * tool-result pairing fills `output_summary` on the matching `tool_use`
 * event so the UI can render call + result together.
 */
export interface ReadSessionSyncOptions {
  byteOffset?: number;
}

export function readSessionSync(path: string, opts: ReadSessionSyncOptions = {}): CanonicalSession {
  const text = readFileSync(path, "utf8");
  const start = opts.byteOffset ?? 0;
  // Slice by byte offset using a Buffer to honor multi-byte boundaries.
  const buf = Buffer.from(text, "utf8");
  const sliced = buf.subarray(start).toString("utf8");

  const lines = sliced.split(/\r?\n/);
  const events: CanonicalEvent[] = [];
  // Track raw lines for metadata extraction (sessionId, cwd, etc).
  const rawLines: RawLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as RawLine;
      rawLines.push(raw);
      const parsed = parseLineFromRaw(raw);
      events.push(...parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const sys: SystemEvent = {
        type: "system",
        ts: new Date().toISOString(),
        event_uuid: `parse-error-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        parent_uuid: null,
        kind: "parse_error",
        content: message,
        raw: { line },
      };
      events.push(sys);
    }
  }

  // Pair tool_use (assistant) → tool_use (user/tool_result) by tool_use_id.
  const toolUseIndex = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || ev.type !== "tool_use") continue;
    if (ev.tool && ev.input_summary && !ev.output_summary) {
      toolUseIndex.set(ev.tool_use_id, i);
    } else if (!ev.tool && ev.output_summary !== undefined) {
      // Result event — find the matching tool_use call.
      const callIdx = toolUseIndex.get(ev.tool_use_id);
      if (callIdx !== undefined) {
        const call = events[callIdx];
        if (call && call.type === "tool_use") {
          call.output_summary = ev.output_summary;
          if (ev.is_error) call.is_error = true;
        }
      }
    }
  }

  // Strip the synthetic "result-only" tool_use events we used for matching;
  // the assistant-side tool_use now carries the output. Keep unmatched
  // result events as-is so EDGE-013 (interrupted) remains observable.
  const keep: CanonicalEvent[] = [];
  for (const ev of events) {
    if (ev.type === "tool_use" && !ev.tool && ev.output_summary !== undefined) {
      const callIdx = toolUseIndex.get(ev.tool_use_id);
      if (callIdx !== undefined) continue; // matched and merged; drop
    }
    keep.push(ev);
  }

  return aggregateSession(keep, rawLines);
}

// Internal version of parseLine that takes already-parsed JSON to avoid
// double-parsing inside readSessionSync.
function parseLineFromRaw(raw: RawLine): CanonicalEvent[] {
  switch (raw.type) {
    case "user":
      return parseUser(raw);
    case "assistant":
      return parseAssistant(raw);
    case "system":
      return parseSystem(raw);
    case "attachment":
      return parseAttachment(raw);
    case "file-history-snapshot":
      return parseFileSnapshot(raw);
    case "last-prompt":
      return [];
    default:
      return parseUnknown(raw);
  }
}

function aggregateSession(events: CanonicalEvent[], rawLines: RawLine[]): CanonicalSession {
  const first = rawLines[0];
  const last = rawLines[rawLines.length - 1];

  let totalIn = 0;
  let totalOut = 0;
  let lastModel: string | null = null;
  let totalCost = 0;
  let lastPermission: string | null = null;

  for (const r of rawLines) {
    if (typeof r.permissionMode === "string") lastPermission = r.permissionMode;
    if (r.type !== "assistant") continue;
    const usage = r.message?.usage;
    if (usage) {
      totalIn += usage.input_tokens ?? 0;
      totalOut += usage.output_tokens ?? 0;
      const model = r.message?.model;
      if (typeof model === "string") {
        lastModel = model;
        totalCost += computeCostUsd(model, {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          ...(usage.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
            : {}),
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
        });
      }
    }
  }

  // Use the raw lines' first/last timestamps so dropped variants
  // (e.g. last-prompt) still anchor session bounds correctly.
  const firstTs = first?.timestamp ?? events[0]?.ts ?? new Date(0).toISOString();
  const lastTs = last?.timestamp ?? events[events.length - 1]?.ts ?? firstTs;

  return {
    id: first?.sessionId ?? "",
    agent: "claude-code",
    agent_version: first?.version ?? "",
    repo: null,
    branch: first?.gitBranch ?? null,
    source_cwd_hint: first?.cwd ?? "",
    started_at: firstTs,
    ended_at: lastTs,
    model: lastModel,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    total_cost_usd: totalCost,
    permission_mode: lastPermission,
    events,
    raw_jsonl_blob_url: null,
    name: null,
  };
}
