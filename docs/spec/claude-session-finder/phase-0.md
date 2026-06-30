# Phase 0: Monorepo skeleton + core schema

> **Status:** pending
> **Depends on:** —
> **Traces to:** REQ-001, REQ-002

## Overview

Set up the TypeScript monorepo at `claude-sessions/` inside vibe-tools. Establish shared types (canonical session + canonical event), tooling (Biome, Vitest, tsc strict), workspaces, and pricing helpers. After this phase: `bun install && bun test` works in an empty repo skeleton with `@claude-sessions/core` types exported.

## Files

- Create: `claude-sessions/package.json` (workspaces root)
- Create: `claude-sessions/turbo.json`
- Create: `claude-sessions/biome.json`
- Create: `claude-sessions/tsconfig.base.json`
- Create: `claude-sessions/.gitignore`, `.env.example`
- Create: `claude-sessions/README.md`, `claude-sessions/PROMPT.md`
- Create: `claude-sessions/packages/core/package.json`
- Create: `claude-sessions/packages/core/tsconfig.json`
- Create: `claude-sessions/packages/core/src/types.ts` — canonical event + session types
- Create: `claude-sessions/packages/core/src/pricing.ts` — model-name → token cost
- Create: `claude-sessions/packages/core/src/types.test.ts`
- Create: `claude-sessions/packages/test-config/package.json`
- Create: `claude-sessions/packages/test-config/vitest.config.ts`

## Canonical types (the contract)

```ts
// packages/core/src/types.ts

export type CanonicalEventType =
  | "user_msg"
  | "assistant_msg"
  | "tool_use"
  | "summary"
  | "system";

export interface CanonicalEventBase {
  ts: string;              // ISO 8601 UTC with Z suffix (REQ-049)
  event_uuid: string;      // stable id from the source (Claude's per-event uuid)
  parent_uuid: string | null;
  raw: unknown;            // original event for lossless replay
}

export interface UserMsgEvent extends CanonicalEventBase {
  type: "user_msg";
  content_md: string;
}

export interface AssistantMsgEvent extends CanonicalEventBase {
  type: "assistant_msg";
  content_md: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export interface ToolUseEvent extends CanonicalEventBase {
  type: "tool_use";
  tool: string;            // "Bash", "Edit", "Write", ...
  tool_use_id: string;
  input_summary: string;   // ≤200 chars, e.g., "ls /Users/foo"
  output_summary?: string; // ≤200 chars; absent if interrupted (EDGE-013)
  is_error?: boolean;
}

export interface SummaryEvent extends CanonicalEventBase {
  type: "summary";
  content: string;
}

export interface SystemEvent extends CanonicalEventBase {
  type: "system";
  kind: string;            // "hook_success", "interrupt", "unknown", "parse_error", ...
  content: string;
}

export type CanonicalEvent =
  | UserMsgEvent
  | AssistantMsgEvent
  | ToolUseEvent
  | SummaryEvent
  | SystemEvent;

export interface CanonicalSession {
  id: string;
  agent: "claude-code" | "cursor" | "codex" | "opencoder" | "continue" | "aider";
  agent_version: string;
  repo: string | null;          // canonical URL, lowercased, no `.git`
  branch: string | null;
  source_cwd_hint: string;      // original capturing machine cwd (kept for fork defaulting only — REQ-001)
  started_at: string;
  ended_at: string;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  permission_mode: string | null;
  events: CanonicalEvent[];
  raw_jsonl_blob_url: string | null;

  // Display name resolution (REQ-059)
  name: string | null;
}

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

export interface InterventionEvent {
  // Reserved for future intervention-mining feature; not populated in v0
  session_id: string;
  event_uuid: string;
  resolution_uuid: string | null;
  kind: string;
  excerpt: string;
  severity: "low" | "medium" | "high";
}
```

## Pricing helper

```ts
// packages/core/src/pricing.ts

interface ModelPrice { input: number; output: number; cache_write: number; cache_read: number } // $ per 1M tokens

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-7":     { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-sonnet-4-6":   { input:  3, output: 15, cache_write:  3.75, cache_read: 0.3 },
  "claude-haiku-4-5":    { input:  1, output:  5, cache_write:  1.25, cache_read: 0.1 },
};

export function computeCostUsd(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const family = matchFamily(model);  // strip suffixes; default to sonnet
  const p = PRICES[family] ?? PRICES["claude-sonnet-4-6"];
  return (
    (usage.input_tokens * p.input
    + usage.output_tokens * p.output
    + (usage.cache_creation_input_tokens ?? 0) * p.cache_write
    + (usage.cache_read_input_tokens ?? 0) * p.cache_read) / 1_000_000
  );
}
```

## Tests

- Type-only test: a fixture `CanonicalSession` literal compiles
- `computeCostUsd` for known usage on `claude-sonnet-4-6` returns expected dollar amount
- `computeCostUsd` for unknown model uses sonnet pricing as fallback
- All event variants serialize → JSON → parse → deepEqual the original

## Done When

- [ ] `bun install` succeeds at repo root
- [ ] `bun test` passes in `packages/core`
- [ ] `tsc --noEmit` passes across all workspace packages (even empty ones)
- [ ] `biome check .` passes

## Commit

`feat(claude-sessions): monorepo skeleton + canonical schema (phase 0)`
