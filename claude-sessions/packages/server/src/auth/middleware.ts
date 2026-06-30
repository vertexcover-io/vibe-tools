// AI-generated. See PROMPT.md for the prompts and model used.

import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env.js";
import { verifyToken } from "./jwt.js";

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

export interface AuthVariables {
  user: AuthUser;
}

export const buildRequireAuth = (env: Pick<Env, "JWT_SECRET">) =>
  createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const cookie = getCookie(c, "session");
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const token = cookie ?? bearer;
    if (!token) return c.json({ error: "unauthorized" }, 401);
    try {
      const payload = await verifyToken(token, env.JWT_SECRET);
      c.set("user", { id: payload.sub, email: payload.email, role: payload.role });
      await next();
    } catch {
      return c.json({ error: "unauthorized" }, 401);
    }
  });
