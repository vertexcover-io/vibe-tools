// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { verifyPassword } from "../auth/argon.js";
import { signToken } from "../auth/jwt.js";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Env } from "../env.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const buildAuthRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  const requireAuth = buildRequireAuth(env);

  router.post("/login", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid email or password" }, 400);

    const { email, password } = parsed.data;
    const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = found[0];
    if (!user) return c.json({ error: "invalid email or password" }, 401);

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return c.json({ error: "invalid email or password" }, 401);

    const role = user.role === "admin" ? "admin" : "user";
    const cookieToken = await signToken(
      { sub: user.id, email: user.email, role, aud: "web" },
      env.JWT_SECRET,
    );
    const bearerToken = await signToken(
      { sub: user.id, email: user.email, role, aud: "cli" },
      env.JWT_SECRET,
    );
    setCookie(c, "session", cookieToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.json({
      token: bearerToken,
      user: { id: user.id, email: user.email, role },
    });
  });

  router.get("/me", requireAuth, (c) => {
    const user = c.get("user");
    return c.json({ user });
  });

  router.post("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  // POST /api/auth/mcp-token — issue a fresh JWT scoped for the MCP transport
  // (REQ-047). Caller must already be authenticated via cookie or bearer.
  router.post("/mcp-token", requireAuth, async (c) => {
    const user = c.get("user");
    const token = await signToken(
      { sub: user.id, email: user.email, role: user.role, aud: "mcp" },
      env.JWT_SECRET,
    );
    return c.json({ token });
  });

  return router;
};
