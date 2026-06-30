// AI-generated. See PROMPT.md for the prompts and model used.

import { Hono } from "hono";

export const buildHealthRouter = (): Hono => {
  const router = new Hono();
  router.get("/", (c) => c.json({ status: "ok" }));
  return router;
};
