// AI-generated. See PROMPT.md for the prompts and model used.

export type {
  CanonicalEventType,
  CanonicalEventBase,
  UserMsgEvent,
  AssistantMsgEvent,
  ToolUseEvent,
  SummaryEvent,
  SystemEvent,
  CanonicalEvent,
  CanonicalSession,
  SessionSummary,
  InterventionEvent,
} from "./types.js";

export { computeCostUsd, matchFamily } from "./pricing.js";
export type { UsageBlock } from "./pricing.js";

export { redact, shannonEntropy } from "./redact.js";
export type { RedactResult, RedactHit } from "./redact.js";

export {
  canonicalizeRepo,
  canonicalizeRemoteUrl,
  detectRepo,
  findGitRoot,
} from "./repo-detect.js";
export type { RepoIdentity } from "./repo-detect.js";
