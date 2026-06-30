// AI-generated. See PROMPT.md for the prompts and model used.

/**
 * Canonical event taxonomy.
 *
 * Every agent transcript (Claude Code, Cursor, Codex, ...) is normalized into
 * this small discriminated union. Adapters parse a source-specific format
 * (e.g. Claude's JSONL) and emit `CanonicalEvent`s in chronological order.
 *
 * The 5 variants intentionally mirror Claude Code's transcript structure
 * (REQ-002): user message, assistant message, tool call, summary card, and a
 * catch-all `system` bucket for hooks, interrupts, and unknown event types
 * (REQ-004).
 */
export type CanonicalEventType = "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";

/**
 * Fields shared by every canonical event.
 *
 * `ts` is ISO 8601 UTC with a `Z` suffix (REQ-049). `event_uuid` is the stable
 * per-event id from the source — Claude's `uuid` field — and is the dedupe
 * key for ingest. `parent_uuid` lets clients reconstruct the conversation
 * tree. `raw` carries the original payload so the adapter is lossless: any
 * downstream consumer can replay the source without re-parsing.
 */
export interface CanonicalEventBase {
  ts: string;
  event_uuid: string;
  parent_uuid: string | null;
  raw: unknown;
}

/**
 * A user message — typed text the human sent into the agent. Tool results
 * that come back disguised as `user` messages in Claude's JSONL are NOT
 * lifted into this variant; they stay attached to the corresponding
 * `tool_use` event so the UI can render them inline with the call.
 */
export interface UserMsgEvent extends CanonicalEventBase {
  type: "user_msg";
  content_md: string;
}

/**
 * An assistant text turn. `usage` is optional because not every assistant
 * frame carries token counts (e.g. partial deltas during streaming). When
 * present it powers per-session cost aggregation via `pricing.computeCostUsd`.
 */
export interface AssistantMsgEvent extends CanonicalEventBase {
  type: "assistant_msg";
  content_md: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * A tool invocation by the assistant (Bash, Edit, Read, ...). The adapter
 * caps `input_summary` and `output_summary` to ~200 chars so the canonical
 * payload stays small; full content lives in `raw` and the original JSONL
 * blob. `output_summary` is absent if the tool was interrupted before
 * returning (EDGE-013); `is_error` flags failed runs.
 */
export interface ToolUseEvent extends CanonicalEventBase {
  type: "tool_use";
  tool: string;
  tool_use_id: string;
  input_summary: string;
  output_summary?: string;
  is_error?: boolean;
}

/**
 * A summary card emitted by Claude Code (e.g. compaction summaries). Kept
 * as its own variant because the UI renders these specially.
 */
export interface SummaryEvent extends CanonicalEventBase {
  type: "summary";
  content: string;
}

/**
 * Catch-all bucket. `kind` distinguishes hook results, interrupts, parse
 * errors, and forward-compat `unknown` events from future Claude Code
 * versions (REQ-004). Storing rather than dropping these preserves
 * lossless replay.
 */
export interface SystemEvent extends CanonicalEventBase {
  type: "system";
  kind: string;
  content: string;
}

export type CanonicalEvent =
  | UserMsgEvent
  | AssistantMsgEvent
  | ToolUseEvent
  | SummaryEvent
  | SystemEvent;

/**
 * The canonical session — the unit of indexing, search, and display.
 *
 * `repo` is the canonicalized git remote URL (lowercased, no `.git`). Pair
 * `(repo, branch)` is what the UI surfaces; the worktree path is hidden
 * (EDGE-007). `source_cwd_hint` is retained ONLY to default `--cwd` when
 * forking from a checkpoint (REQ-001) — the UI never shows it.
 *
 * Aggregates (`total_*`) are computed from the assistant `usage` blocks
 * (REQ-043) so we can rank and cost-account without scanning events.
 *
 * `name` is the user-set display name. Display name resolution order
 * (REQ-059): `name` → LLM-generated `title` (in `SessionSummary`) →
 * `Session <first-8-chars-of-id>`.
 */
export interface CanonicalSession {
  id: string;
  agent: "claude-code" | "cursor" | "codex" | "opencoder" | "continue" | "aider";
  agent_version: string;
  repo: string | null;
  branch: string | null;
  source_cwd_hint: string;
  started_at: string;
  ended_at: string;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  permission_mode: string | null;
  events: CanonicalEvent[];
  raw_jsonl_blob_url: string | null;
  name: string | null;
}

/**
 * LLM-generated session summary, produced by the summarizer pipeline.
 *
 * `status` lets the UI surface "summarizing...", "ok", or "failed (N retries)"
 * states without joining against a job table. `tags` are 3-8 lowercase
 * kebab-case labels; `summary` is a 4-6 sentence paragraph.
 */
export interface SessionSummary {
  session_id: string;
  title: string;
  summary: string;
  tags: string[];
  files_touched: string[];
  prs_referenced: string[];
  tool_call_counts: Record<string, number>;
  generated_at: string;
  model: string;
  status: "pending" | "ok" | "failed";
  error?: string;
}

/**
 * Reserved for the future intervention-mining feature (where users flag
 * moments where they had to course-correct the agent). NOT populated in v0;
 * declared here so the wire schema is forward-compatible.
 */
export interface InterventionEvent {
  session_id: string;
  event_uuid: string;
  resolution_uuid: string | null;
  kind: string;
  excerpt: string;
  severity: "low" | "medium" | "high";
}
