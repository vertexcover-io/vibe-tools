// AI-generated. See PROMPT.md for the prompts and model used.

import { redact } from "@claude-sessions/core";

/**
 * Defense-in-depth redaction for ingest payloads (REQ-034). The CLI redacts
 * before upload; the server redacts again at write time so a misconfigured
 * client can never poison the cloud store with secrets.
 *
 * Walks unknown JSON-shaped data and replaces secret-looking substrings
 * inside every string leaf with the core `redact()` placeholders.
 */
export const redactDeep = (input: unknown): unknown => {
  if (typeof input === "string") {
    return redact(input).redacted;
  }
  if (Array.isArray(input)) {
    return input.map(redactDeep);
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return input;
};
