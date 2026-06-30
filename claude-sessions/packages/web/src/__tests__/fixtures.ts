// AI-generated. See PROMPT.md for the prompts and model used.

import type {
  RepoSummary,
  SessionDetail,
  SessionSummaryPayload,
  TranscriptEvent,
} from "../lib/types";

export const fixtureSummary = (
  over: Partial<SessionSummaryPayload> = {},
): SessionSummaryPayload => ({
  title: "Build pin: CLI bookmark manager",
  summary:
    "Designed and shipped pin, a Python CLI bookmark manager that uses the Claude Code CLI for natural-language adds and intent-based search.",
  tags: ["cli-tooling", "bookmark-manager", "claude-cli", "shipped"],
  files_touched: ["pin/pin.py", "pin/README.md", "pin/PROMPT.md"],
  prs_referenced: ["https://github.com/example/repo/pull/5"],
  tool_call_counts: { Bash: 4, Read: 2 },
  status: "ok",
  ...over,
});

export const fixtureSession = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: "fixture-session-1",
  agent: "claude-code",
  agent_version: "1.0.0",
  branch: "master",
  source_cwd_hint: "/tmp/work",
  model: "sonnet",
  started_at: "2026-05-01T10:00:00.000Z",
  ended_at: "2026-05-01T10:07:23.000Z",
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cost_usd: "0.21",
  permission_mode: "default",
  is_private: false,
  name: null,
  has_blob: true,
  display_name: "Build pin: CLI bookmark manager",
  repo: { canonical_url: "github.com/example/vibe-tools", branch: "master" },
  summary: fixtureSummary(),
  ...over,
});

export const fixtureRepo = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  id: "repo-1",
  canonical_url: "github.com/example/vibe-tools",
  display_name: null,
  access: "owner",
  session_count: 7,
  last_activity: "2026-05-01T10:00:00.000Z",
  ...over,
});

export const fixtureEvents = (): TranscriptEvent[] => [
  {
    event_uuid: "u-1",
    parent_uuid: null,
    ts: "2026-05-01T10:00:00.000Z",
    type: "user_msg",
    payload: { content_md: "Help me create a CLI based bookmarking tool" },
  },
  {
    event_uuid: "a-1",
    parent_uuid: "u-1",
    ts: "2026-05-01T10:00:30.000Z",
    type: "assistant_msg",
    payload: {
      content_md: "I'll explore the repo conventions and design the tool.",
      model: "sonnet",
    },
  },
  {
    event_uuid: "t-1",
    parent_uuid: "a-1",
    ts: "2026-05-01T10:00:45.000Z",
    type: "tool_use",
    payload: {
      tool: "Bash",
      tool_use_id: "t1",
      input_summary: "ls /Users/vertexcover/Projects/vibe-tools/",
      output_summary: "5 lines of output",
    },
  },
];
