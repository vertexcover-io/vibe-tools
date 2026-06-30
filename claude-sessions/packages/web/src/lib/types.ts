// AI-generated. See PROMPT.md for the prompts and model used.

export interface User {
  id: string;
  email: string;
  role: "user" | "admin";
}

export interface RepoSummary {
  id: string;
  canonical_url: string;
  display_name: string | null;
  access: string;
  session_count: number;
  last_activity: string | null;
}

export interface SessionListItem {
  id: string;
  agent: string;
  branch: string | null;
  model: string | null;
  started_at: string;
  ended_at: string;
  total_cost_usd: string;
  is_private: boolean;
  name: string | null;
  repo?: string | null;
  title: string | null;
  summary: string | null;
  tags: string[];
  prs_referenced: string[];
  display_name: string;
}

export interface SessionSummaryPayload {
  title: string | null;
  summary: string | null;
  tags: string[];
  files_touched: string[];
  prs_referenced: string[];
  tool_call_counts: Record<string, number>;
  status: "pending" | "ok" | "failed";
}

export interface SessionDetail {
  id: string;
  agent?: string;
  agent_version?: string;
  repo_id?: string | null;
  repo?: { canonical_url: string; branch: string | null } | null;
  branch?: string | null;
  source_cwd_hint?: string;
  model?: string | null;
  started_at?: string;
  ended_at?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost_usd?: string;
  permission_mode?: string | null;
  is_private: boolean;
  name?: string | null;
  has_blob?: boolean;
  display_name: string;
  summary: SessionSummaryPayload | null;
}

export type CanonicalEventType = "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";

export interface TranscriptEvent {
  event_uuid: string;
  parent_uuid: string | null;
  ts: string;
  type: CanonicalEventType;
  payload: Record<string, unknown> & {
    content_md?: string;
    content?: string;
    tool?: string;
    tool_use_id?: string;
    input_summary?: string;
    output_summary?: string;
    is_error?: boolean;
    kind?: string;
  };
}

export interface SearchResult {
  session_id: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  repo: string | null;
  branch: string | null;
  agent: string;
  started_at: string;
  ended_at: string;
  total_cost_usd: string;
}
