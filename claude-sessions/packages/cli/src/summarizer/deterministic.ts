// AI-generated. See PROMPT.md for the prompts and model used.

import type { CanonicalSession, ToolUseEvent } from "@claude-sessions/core";

/**
 * Mechanical fields the summarizer computes itself instead of trusting
 * the LLM (REQ-026, REQ-044).
 *
 * - `files_touched_raw`: paths from Edit/Write/MultiEdit/Read tool inputs
 * - `tool_call_counts`: count per tool name across all tool_use events
 * - `prs_referenced_mined`: GitHub PR URLs scraped from gh-pr-create or
 *   git-push tool outputs / inputs
 */

export interface DeterministicFields {
  files_touched_raw: string[];
  tool_call_counts: Record<string, number>;
  prs_referenced_mined: string[];
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Read"]);
const GH_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

const isToolUse = (ev: { type: string }): ev is ToolUseEvent => ev.type === "tool_use";

const dedupe = <T>(arr: readonly T[]): T[] => {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

/**
 * Pull every plausible file path out of a tool_use event. Inputs come in
 * three shapes:
 *   - { file_path: "..." } (Edit/Write/Read)
 *   - { path: "..." } (some adapters)
 *   - { edits: [{ file_path: "..." }, ...] } (MultiEdit)
 *
 * The canonical event truncates the input summary to 200 chars, but the
 * raw payload is preserved on `ev.raw`. We read from `raw.input` when it
 * exists; otherwise we fall back to parsing the summary string.
 */
const extractFiles = (ev: ToolUseEvent): string[] => {
  if (!FILE_TOOLS.has(ev.tool)) return [];
  const out: string[] = [];

  // Walk the original assistant content for the file_path field.
  const raw = ev.raw as
    | {
        message?: {
          content?: Array<{
            type?: string;
            id?: string;
            input?: { file_path?: unknown; path?: unknown; edits?: unknown };
          }>;
        };
      }
    | undefined;
  const blocks = raw?.message?.content ?? [];
  for (const b of blocks) {
    if (b?.type !== "tool_use" || b.id !== ev.tool_use_id) continue;
    const input = b.input;
    if (input && typeof input === "object") {
      if (typeof (input as { file_path?: unknown }).file_path === "string") {
        out.push((input as { file_path: string }).file_path);
      }
      if (typeof (input as { path?: unknown }).path === "string") {
        out.push((input as { path: string }).path);
      }
      const edits = (input as { edits?: unknown }).edits;
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (
            e &&
            typeof e === "object" &&
            typeof (e as { file_path?: unknown }).file_path === "string"
          ) {
            out.push((e as { file_path: string }).file_path);
          }
        }
      }
    }
  }

  // Fallback: input_summary is the first scalar field for the common shapes.
  if (out.length === 0 && ev.input_summary) {
    out.push(ev.input_summary);
  }
  return out.filter((p) => p.length > 0);
};

const minePrsFromText = (text: string): string[] => {
  const matches = text.match(GH_PR_URL_RE);
  return matches ? [...matches] : [];
};

export const computeDeterministic = (session: CanonicalSession): DeterministicFields => {
  const files: string[] = [];
  const counts: Record<string, number> = {};
  const prs: string[] = [];

  for (const ev of session.events) {
    if (!isToolUse(ev)) continue;
    if (ev.tool && ev.tool.length > 0) {
      counts[ev.tool] = (counts[ev.tool] ?? 0) + 1;
    }
    files.push(...extractFiles(ev));

    if (ev.tool === "Bash") {
      const cmd = ev.input_summary ?? "";
      const isPrCreate = /^gh\s+pr\s+create\b/.test(cmd);
      const isPush = /^git\s+push\b/.test(cmd);
      if (isPrCreate || isPush) {
        const out = ev.output_summary ?? "";
        prs.push(...minePrsFromText(out));
        // Some shells echo the URL in the input rather than the output.
        prs.push(...minePrsFromText(cmd));
      }
    }
  }

  return {
    files_touched_raw: dedupe(files),
    tool_call_counts: counts,
    prs_referenced_mined: dedupe(prs),
  };
};
