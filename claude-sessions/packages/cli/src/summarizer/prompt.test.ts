// AI-generated. See PROMPT.md for the prompts and model used.

import type { CanonicalEvent, CanonicalSession } from "@claude-sessions/core";
import { describe, expect, it } from "vitest";
import { computeDeterministic } from "./deterministic.js";
import {
  APPROX_CHARS_PER_TOKEN,
  HEAD_TOKENS,
  TAIL_TOKENS,
  TRUNCATION_MARKER,
  buildPromptUserMessage,
} from "./prompt.js";

const buildSession = (events: CanonicalEvent[]): CanonicalSession => ({
  id: "s-trunc",
  agent: "claude-code",
  agent_version: "1.0.0",
  repo: "github.com/example/big",
  branch: "main",
  source_cwd_hint: "/tmp",
  started_at: "2026-05-09T10:00:00Z",
  ended_at: "2026-05-09T11:00:00Z",
  model: "claude-3-5-sonnet",
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost_usd: 0,
  permission_mode: null,
  events,
  raw_jsonl_blob_url: null,
  name: null,
});

const userEvent = (i: number, body: string): CanonicalEvent => ({
  type: "user_msg",
  ts: "2026-05-09T10:00:00Z",
  event_uuid: `u-${i}`,
  parent_uuid: null,
  raw: {},
  content_md: body,
});

describe("buildPromptUserMessage", () => {
  it("does not truncate small sessions", () => {
    const session = buildSession([userEvent(1, "hello"), userEvent(2, "world")]);
    const det = computeDeterministic(session);
    const out = buildPromptUserMessage(session, det);
    expect(out.truncated).toBe(false);
    expect(out.text).not.toContain(TRUNCATION_MARKER);
    expect(out.text).toContain("hello");
    expect(out.text).toContain("world");
    expect(out.text).toContain("Repo: github.com/example/big");
  });

  it("EDGE-004: synthetic 1M-char transcript triggers TRUNCATED MIDDLE marker", () => {
    // Build one event whose content is far larger than head + tail.
    const huge = "x".repeat((HEAD_TOKENS + TAIL_TOKENS) * APPROX_CHARS_PER_TOKEN + 50_000);
    const session = buildSession([userEvent(1, huge)]);
    const det = computeDeterministic(session);
    const out = buildPromptUserMessage(session, det);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain(TRUNCATION_MARKER);
    // The full transcript chars cannot exceed head+tail+marker (plus header overhead).
    const maxAllowed =
      (HEAD_TOKENS + TAIL_TOKENS) * APPROX_CHARS_PER_TOKEN + TRUNCATION_MARKER.length + 4_000; // header overhead
    expect(out.text.length).toBeLessThan(maxAllowed);
  });

  it("includes deterministic context (counts + files + PRs)", () => {
    const session = buildSession([userEvent(1, "hi")]);
    const det = computeDeterministic(session);
    const out = buildPromptUserMessage(session, det);
    expect(out.text).toContain("Tool call counts (deterministic):");
    expect(out.text).toContain("Files touched (deterministic):");
    expect(out.text).toContain("PRs mined (deterministic):");
  });
});
