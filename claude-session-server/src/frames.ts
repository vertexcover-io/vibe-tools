// AI-generated. See PROMPT.md for the prompts and model used.
import { z } from "zod";

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

const PromptFrameSchema = z.object({
  type: z.literal("prompt"),
  text: z.string(),
  thinking: ThinkingLevelSchema.optional(),
});

const SteerFrameSchema = z.object({
  type: z.literal("steer"),
  text: z.string(),
});

const FollowUpFrameSchema = z.object({
  type: z.literal("follow_up"),
  text: z.string(),
});

const AbortFrameSchema = z.object({
  type: z.literal("abort"),
});

export const InboundFrameSchema = z.discriminatedUnion("type", [
  PromptFrameSchema,
  SteerFrameSchema,
  FollowUpFrameSchema,
  AbortFrameSchema,
]);

export type InboundFrame = z.infer<typeof InboundFrameSchema>;
export type PromptFrame = z.infer<typeof PromptFrameSchema>;

export const ERROR_CODES = [
  "session_busy",
  "session_in_use",
  "auth_error",
  "rate_limited",
  "invalid_fork_point",
  "at_capacity",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ServerOutboundFrame =
  | { type: "session_ready"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
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
  | { type: "turn_end"; usage: unknown }
  | { type: "error"; code: ErrorCode; message: string };

export type ParseResult =
  | { ok: true; frame: InboundFrame }
  | { ok: false; error: string };

export const parseInboundFrame = (raw: unknown): ParseResult => {
  const parsed = InboundFrameSchema.safeParse(raw);
  if (parsed.success) return { ok: true, frame: parsed.data };
  return { ok: false, error: parsed.error.message };
};

export const serializeOutbound = (frame: ServerOutboundFrame): string =>
  JSON.stringify(frame);
