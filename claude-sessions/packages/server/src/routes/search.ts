// AI-generated. See PROMPT.md for the prompts and model used.

import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import type { Env } from "../env.js";
import { searchInternal } from "../lib/search-internal.js";

const SearchQuery = z.object({
  q: z.string().min(1),
  repo: z.string().optional(),
  branch: z.string().optional(),
  agent: z.string().optional(),
  has_pr: z.coerce.boolean().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const buildSearchRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  router.get("/", async (c) => {
    const user = c.get("user");
    const raw = Object.fromEntries(new URL(c.req.url).searchParams);
    const parsed = SearchQuery.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const params = parsed.data;

    const result = await searchInternal(db, user.id, params.q, {
      ...(params.repo !== undefined ? { repo: params.repo } : {}),
      ...(params.branch !== undefined ? { branch: params.branch } : {}),
      ...(params.agent !== undefined ? { agent: params.agent } : {}),
      ...(params.has_pr !== undefined ? { hasPr: params.has_pr } : {}),
      ...(params.since !== undefined ? { since: params.since } : {}),
      limit: params.limit,
    });
    return c.json(result);
  });

  return router;
};
