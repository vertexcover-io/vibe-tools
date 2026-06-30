// AI-generated. See PROMPT.md for the prompts and model used.

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { findUserRepoAccess, upsertRepo } from "../db/repos.js";
import { events, sessions } from "../db/schema.js";
import type { Env } from "../env.js";
import { redactDeep } from "../redact.js";

const eventSchema = z.object({
  event_uuid: z.string(),
  parent_uuid: z.string().nullable(),
  ts: z.string().datetime(),
  type: z.enum(["user_msg", "assistant_msg", "tool_use", "summary", "system"]),
  payload: z.unknown(),
});

const ingestSchema = z.object({
  session: z.object({
    id: z.string(),
    agent: z.literal("claude-code"),
    agent_version: z.string(),
    repo: z.object({ canonical_url: z.string(), branch: z.string().nullable() }),
    source_cwd_hint: z.string(),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime(),
    model: z.string().nullable(),
    permission_mode: z.string().nullable(),
    total_input_tokens: z.number().int().nonnegative(),
    total_output_tokens: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
  }),
  events: z.array(eventSchema).max(500),
});

export const buildIngestRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  router.post("/", async (c) => {
    const user = c.get("user");
    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    const repo = await upsertRepo(db, body.session.repo.canonical_url);
    const access = await findUserRepoAccess(db, user.id, repo.id);
    if (!access) return c.json({ error: "repo not enabled for user" }, 403);

    const redacted = body.events.map((e) => ({ ...e, payload: redactDeep(e.payload) }));

    const result = await db.transaction(async (tx) => {
      await tx
        .insert(sessions)
        .values({
          id: body.session.id,
          userId: user.id,
          repoId: repo.id,
          agent: body.session.agent,
          agentVersion: body.session.agent_version,
          branch: body.session.repo.branch,
          sourceCwdHint: body.session.source_cwd_hint,
          model: body.session.model,
          permissionMode: body.session.permission_mode,
          startedAt: new Date(body.session.started_at),
          endedAt: new Date(body.session.ended_at),
          totalInputTokens: body.session.total_input_tokens,
          totalOutputTokens: body.session.total_output_tokens,
          totalCostUsd: body.session.total_cost_usd.toString(),
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            agentVersion: body.session.agent_version,
            branch: body.session.repo.branch,
            sourceCwdHint: body.session.source_cwd_hint,
            model: body.session.model,
            permissionMode: body.session.permission_mode,
            startedAt: new Date(body.session.started_at),
            endedAt: new Date(body.session.ended_at),
            totalInputTokens: body.session.total_input_tokens,
            totalOutputTokens: body.session.total_output_tokens,
            totalCostUsd: body.session.total_cost_usd.toString(),
            updatedAt: sql`now()`,
          },
        });

      let inserted: { eventUuid: string }[] = [];
      if (redacted.length > 0) {
        inserted = await tx
          .insert(events)
          .values(
            redacted.map((e) => ({
              sessionId: body.session.id,
              eventUuid: e.event_uuid,
              parentUuid: e.parent_uuid,
              ts: new Date(e.ts),
              type: e.type,
              payload: e.payload as object,
            })),
          )
          .onConflictDoNothing()
          .returning({ eventUuid: events.eventUuid });
      }
      return {
        accepted: inserted.length,
        skipped: redacted.length - inserted.length,
      };
    });

    return c.json({
      ok: true,
      session_id: body.session.id,
      accepted_events: result.accepted,
      skipped_duplicates: result.skipped,
    });
  });

  return router;
};
