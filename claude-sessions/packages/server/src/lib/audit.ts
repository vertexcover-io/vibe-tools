// AI-generated. See PROMPT.md for the prompts and model used.

import type { Context } from "hono";
import type { AuthVariables } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { auditLog } from "../db/schema.js";

/**
 * Thin helper: write a single audit_log row tied to the calling user and
 * an optional target session (REQ-036). Uses the bound DbClient + the
 * authenticated user from the Hono context, so callers don't have to
 * thread either of those through manually.
 */
export const writeAudit = async (
  db: DbClient,
  c: Context<{ Variables: AuthVariables }>,
  action: string,
  targetSessionId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> => {
  const user = c.get("user");
  const ip = c.req.header("x-forwarded-for") ?? null;
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action,
    targetSessionId,
    detail: { ...detail, ip },
  });
};

/**
 * Wrap a request handler so that every successful invocation results in
 * exactly one audit_log row. The wrapped function runs first; we only
 * write the audit row if it returns without throwing — failures should
 * surface in error-tracking, not the audit trail.
 */
export const withAudit = async <T>(
  db: DbClient,
  c: Context<{ Variables: AuthVariables }>,
  action: string,
  targetSessionId: string | null,
  fn: () => Promise<T>,
): Promise<T> => {
  const result = await fn();
  await writeAudit(db, c, action, targetSessionId);
  return result;
};
