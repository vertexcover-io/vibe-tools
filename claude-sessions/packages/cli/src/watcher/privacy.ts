// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../config/paths.js";

/**
 * Path to the per-session sidecar marker. The user (or an MCP tool) drops
 * a zero-byte file at `<configHome>/sessions/<sessionId>.private` to opt
 * a session out of cloud sync (REQ-040). Every consume tick re-checks
 * this — it's intentionally cheap so it can run on every event batch.
 */
export const sidecarPath = (sessionId: string): string =>
  join(configHome(), "sessions", `${sessionId}.private`);

export const isSessionMarkedPrivate = (sessionId: string): boolean =>
  existsSync(sidecarPath(sessionId));
