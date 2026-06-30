// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const guessMime = (p: string): string =>
  MIME[extname(p).toLowerCase()] ?? "application/octet-stream";

/**
 * Static SPA host: serves files from `webDist` (defaults to packages/web/dist),
 * falls back to `index.html` for unknown paths so client-side routing works.
 *
 * If the dist folder is missing (dev / first run), the middleware no-ops and
 * lets the rest of the app handle the request.
 */
export const buildStaticSpa = (webDist?: string): MiddlewareHandler => {
  const root = resolve(webDist ?? process.env.WEB_DIST ?? join(process.cwd(), "packages/web/dist"));
  const indexPath = join(root, "index.html");

  return async (c, next) => {
    if (!existsSync(root) || !existsSync(indexPath)) return next();

    const url = new URL(c.req.url);
    const reqPath = decodeURIComponent(url.pathname);

    // Reserved API/MCP/health prefixes pass through.
    if (reqPath.startsWith("/api/") || reqPath.startsWith("/mcp") || reqPath === "/health") {
      return next();
    }

    const safePath = normalize(reqPath).replace(/^[/\\]+/, "");
    const candidate = safePath ? join(root, safePath) : indexPath;
    const resolved = resolve(candidate);
    if (!resolved.startsWith(root)) return next();

    if (existsSync(resolved) && statSync(resolved).isFile()) {
      const body = readFileSync(resolved);
      return c.body(body, 200, {
        "content-type": guessMime(resolved),
        "cache-control": resolved === indexPath ? "no-cache" : "public, max-age=31536000",
      });
    }

    // SPA fallback for client-side routes.
    const html = readFileSync(indexPath);
    return c.body(html, 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  };
};

export const buildStaticRouter = (webDist?: string): Hono => {
  const router = new Hono();
  router.use("*", buildStaticSpa(webDist));
  return router;
};
