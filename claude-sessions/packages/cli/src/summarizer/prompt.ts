// AI-generated. See PROMPT.md for the prompts and model used.

import type { CanonicalEvent, CanonicalSession } from "@claude-sessions/core";
import type { DeterministicFields } from "./deterministic.js";

/**
 * System + user-message construction for `claude -p` (REQ-017).
 *
 * The transcript is a flat, timestamped log of every event in the
 * session. To stay under Claude's context window for very long sessions
 * (EDGE-004) we approximate ~4 chars per token and truncate to the first
 * 50k tokens + last 200k tokens, dropping the middle and inserting a
 * marker so the model knows the gap exists.
 */

export const SUMMARY_SCHEMA = {
  type: "object",
  required: ["title", "summary", "tags", "files_touched", "prs_referenced"],
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 80 },
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" }, minItems: 0 },
    files_touched: { type: "array", items: { type: "string" } },
    prs_referenced: { type: "array", items: { type: "string" } },
  },
} as const;

export const SYSTEM_PROMPT = [
  "You are summarizing a Claude Code coding session for later retrieval and analysis.",
  "Output ONLY a JSON object matching the provided schema. No prose, no markdown.",
  "",
  "Fields:",
  "- title: <=80 char scannable name (commit-subject style)",
  "- summary: 4-6 sentence paragraph covering goal, approach, outcome, current state",
  "- tags: 3-8 lowercase-kebab-case labels (free-form folksonomy)",
  "- files_touched: paths the session created, modified, or read with intent — drop incidental reads",
  "- prs_referenced: PR URLs that were opened, mentioned, or implied",
  "",
  "tool_call_counts is computed deterministically and merged in by the post-processor; do not regenerate it.",
].join("\n");

export const APPROX_CHARS_PER_TOKEN = 4;
export const HEAD_TOKENS = 50_000;
export const TAIL_TOKENS = 200_000;
export const TRUNCATION_MARKER = "\n\n--- TRUNCATED MIDDLE: omitted to fit context window ---\n\n";

const formatEvent = (ev: CanonicalEvent): string => {
  const head = `[${ev.ts}] ${ev.type}`;
  switch (ev.type) {
    case "user_msg":
      return `${head} user: ${ev.content_md}`;
    case "assistant_msg":
      return `${head} assistant: ${ev.content_md}`;
    case "tool_use":
      return `${head} tool=${ev.tool} input="${ev.input_summary}"${
        ev.output_summary ? ` output="${ev.output_summary}"` : ""
      }${ev.is_error ? " (error)" : ""}`;
    case "summary":
      return `${head} ${ev.content}`;
    case "system":
      return `${head} ${ev.kind}: ${ev.content}`;
    default:
      return head;
  }
};

const formatTranscript = (session: CanonicalSession): string =>
  session.events.map(formatEvent).join("\n");

const truncateTranscript = (transcript: string): string => {
  const headChars = HEAD_TOKENS * APPROX_CHARS_PER_TOKEN;
  const tailChars = TAIL_TOKENS * APPROX_CHARS_PER_TOKEN;
  if (transcript.length <= headChars + tailChars) return transcript;
  return (
    transcript.slice(0, headChars) +
    TRUNCATION_MARKER +
    transcript.slice(transcript.length - tailChars)
  );
};

export interface BuildPromptResult {
  text: string;
  truncated: boolean;
}

export const buildPromptUserMessage = (
  session: CanonicalSession,
  det: DeterministicFields,
): BuildPromptResult => {
  const raw = formatTranscript(session);
  const text = truncateTranscript(raw);
  const truncated = text.length !== raw.length;

  const header = [
    `Session ID: ${session.id}`,
    `Repo: ${session.repo ?? "(unassigned)"}${session.branch ? ` @ ${session.branch}` : ""}`,
    `Model: ${session.model ?? "(unknown)"}`,
    `Started: ${session.started_at}`,
    `Ended: ${session.ended_at}`,
    `Tool call counts (deterministic): ${JSON.stringify(det.tool_call_counts)}`,
    `Files touched (deterministic): ${JSON.stringify(det.files_touched_raw.slice(0, 50))}`,
    `PRs mined (deterministic): ${JSON.stringify(det.prs_referenced_mined)}`,
    truncated ? "NOTE: transcript was truncated. See marker." : "",
    "",
    "BEGIN TRANSCRIPT",
  ]
    .filter((s) => s !== "")
    .join("\n");

  return {
    text: `${header}\n${text}\nEND TRANSCRIPT`,
    truncated,
  };
};
