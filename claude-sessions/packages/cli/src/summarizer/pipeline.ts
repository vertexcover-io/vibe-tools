// AI-generated. See PROMPT.md for the prompts and model used.

import { readFile } from "node:fs/promises";
import { readSessionSync } from "@claude-sessions/adapter-claude";
import type { CanonicalSession, SessionSummary } from "@claude-sessions/core";
import type { UploadClient } from "../upload/client.js";
import { runClaude } from "./claude-runner.js";
import { computeDeterministic } from "./deterministic.js";
import { minePrs } from "./pr-mining.js";
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildPromptUserMessage } from "./prompt.js";

/**
 * End-to-end summarization for a single session (REQ-017, REQ-026, REQ-061).
 *
 * Steps:
 *   1. Re-read JSONL from disk (chokidar may have raced with us).
 *   2. Compute deterministic fields (files_touched, tool_call_counts, PRs).
 *   3. PR mining with `gh pr list` fallback when nothing is in the transcript.
 *   4. Build prompt + invoke `claude -p` for the LLM-generated fields.
 *   5. Merge LLM output with deterministic counts/files/PRs.
 *   6. POST summary (server generates embedding inline).
 *   7. PUT raw blob bytes.
 *
 * The caller (`Summarizer.summarize`) wraps this in a semaphore and
 * exp-backoff retry.
 */

export interface PipelineDeps {
  upload: UploadClient;
  jsonlPath: string;
  /** Inject a fake disk reader (tests). */
  readSession?: (path: string) => CanonicalSession;
  /** Inject a fake claude runner (tests). */
  runClaudeImpl?: typeof runClaude;
  /** Inject the pr-mining function (tests). */
  minePrsImpl?: typeof minePrs;
  /** Inject a custom blob reader (tests). */
  readBlob?: (path: string) => Promise<Uint8Array>;
  /** Override the model name embedded in the summary metadata. */
  model?: string;
}

interface LlmSummary {
  title: string;
  summary: string;
  tags: string[];
  files_touched: string[];
  prs_referenced: string[];
}

const dedupe = <T>(arr: readonly T[]): T[] => Array.from(new Set(arr));

const ensureArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
};

const ensureString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const parseLlmOutput = (raw: unknown): LlmSummary => {
  if (!raw || typeof raw !== "object") {
    throw new Error("claude returned a non-object summary");
  }
  const o = raw as Record<string, unknown>;
  return {
    title: ensureString(o.title),
    summary: ensureString(o.summary),
    tags: ensureArray(o.tags),
    files_touched: ensureArray(o.files_touched),
    prs_referenced: ensureArray(o.prs_referenced),
  };
};

export const summarizeAndUpload = async (
  sessionId: string,
  deps: PipelineDeps,
): Promise<SessionSummary> => {
  const readSession = deps.readSession ?? readSessionSync;
  const runClaudeFn = deps.runClaudeImpl ?? runClaude;
  const minePrsFn = deps.minePrsImpl ?? minePrs;
  const readBlobFn = deps.readBlob ?? (async (p: string) => new Uint8Array(await readFile(p)));
  const model = deps.model ?? "sonnet";

  const session = readSession(deps.jsonlPath);
  const det = computeDeterministic(session);
  const minedPrs = await minePrsFn(session, det);

  const prompt = buildPromptUserMessage(session, det);
  const raw = await runClaudeFn({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: prompt.text,
    schema: SUMMARY_SCHEMA,
    model,
  });
  const llm = parseLlmOutput(raw);

  const summary: SessionSummary = {
    session_id: sessionId,
    title: llm.title,
    summary: llm.summary,
    tags: llm.tags,
    files_touched: dedupe([...llm.files_touched, ...det.files_touched_raw]),
    prs_referenced: dedupe([...llm.prs_referenced, ...minedPrs]),
    tool_call_counts: det.tool_call_counts,
    generated_at: new Date().toISOString(),
    model,
    status: "ok",
  };

  await deps.upload.uploadSummary(sessionId, summary);
  const blob = await readBlobFn(deps.jsonlPath);
  await deps.upload.uploadBlob(sessionId, blob);

  return summary;
};
