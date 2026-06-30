// AI-generated. See PROMPT.md for the prompts and model used.
//
// Observed pi 0.79.9 AgentSessionEvent shapes (verified from bundled .d.ts; field
// names confirmed via src/smoke.ts against live pi):
//   { type: "agent_start" }
//   { type: "turn_start" }
//   { type: "message_start", message }
//   { type: "message_update", message, assistantMessageEvent }   <- streaming deltas live HERE
//   { type: "message_end", message }
//   { type: "turn_end", message, toolResults }                   <- message.usage carries token/cost
//   { type: "tool_execution_start", toolCallId, toolName, args }
//   { type: "tool_execution_update", toolCallId, toolName, args, partialResult }
//   { type: "tool_execution_end", toolCallId, toolName, result, isError }
// (agent_end / queue_update / compaction_* / *_retry_* are excluded from AgentSessionEvent.)
//
// assistantMessageEvent (pi-ai) deltas — the actual text/thinking stream:
//   { type: "text_delta",     contentIndex, delta, partial }
//   { type: "thinking_delta", contentIndex, delta, partial }
//   { type: "toolcall_delta", contentIndex, delta, partial }
//   plus *_start / *_end variants and { type: "done", reason, message } / { type: "error", reason, error }.

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

export type ServerFrame =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "turn_start" }
  | { type: "turn_end"; usage: unknown }
  | { type: "raw"; event: AgentSessionEvent };

const stripApiKey = (): void => {
  if ("ANTHROPIC_API_KEY" in process.env) {
    delete process.env.ANTHROPIC_API_KEY;
  }
};

export const createSession = async (cfg: Config): Promise<AgentSession> => {
  stripApiKey();
  const { session } = await createAgentSession({
    cwd: cfg.workingDir,
    agentDir: cfg.configDir,
    sessionManager: SessionManager.create(cfg.workingDir),
  });
  return session;
};

export const openSession = async (
  cfg: Config,
  sessionFile: string,
): Promise<AgentSession> => {
  stripApiKey();
  const { session } = await createAgentSession({
    cwd: cfg.workingDir,
    agentDir: cfg.configDir,
    sessionManager: SessionManager.open(sessionFile),
  });
  return session;
};

export const toServerFrame = (event: AgentSessionEvent): ServerFrame => {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end": {
      const message = event.message as { usage?: unknown };
      return { type: "turn_end", usage: message.usage };
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        return {
          type: "text_delta",
          contentIndex: inner.contentIndex,
          delta: inner.delta,
        };
      }
      if (inner.type === "thinking_delta") {
        return {
          type: "thinking_delta",
          contentIndex: inner.contentIndex,
          delta: inner.delta,
        };
      }
      return { type: "raw", event };
    }
    default:
      return { type: "raw", event };
  }
};
