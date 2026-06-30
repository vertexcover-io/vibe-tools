// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { events } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { type TestPgHandle, startTestPostgres, truncateAll } from "./helpers/pg-test-container.js";
import { seedUser } from "./helpers/seed.js";

const TEST_ENV: Env = {
  DATABASE_URL: "",
  JWT_SECRET: "test-secret-test-secret-test",
  EMBED_PROVIDER: "none",
  OPENAI_EMBED_MODEL: "text-embedding-3-small",
  PORT: 0,
  NODE_ENV: "test",
};

interface IngestBody {
  session: {
    id: string;
    agent: "claude-code";
    agent_version: string;
    repo: { canonical_url: string; branch: string | null };
    source_cwd_hint: string;
    started_at: string;
    ended_at: string;
    model: string | null;
    permission_mode: string | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
  };
  events: Array<{
    event_uuid: string;
    parent_uuid: string | null;
    ts: string;
    type: "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";
    payload: unknown;
  }>;
}

const buildIngestPayload = (
  sessionId: string,
  repoUrl: string,
  events: IngestBody["events"],
): IngestBody => ({
  session: {
    id: sessionId,
    agent: "claude-code",
    agent_version: "1.0.0",
    repo: { canonical_url: repoUrl, branch: "main" },
    source_cwd_hint: "/tmp/work",
    started_at: "2026-05-01T10:00:00.000Z",
    ended_at: "2026-05-01T10:30:00.000Z",
    model: "claude-3-5-sonnet",
    permission_mode: "default",
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cost_usd: 0.01,
  },
  events,
});

let pg: TestPgHandle;
let db: Db;
let app: Hono;
let env: Env;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = pg.db;
  env = { ...TEST_ENV, DATABASE_URL: pg.url };
  app = buildApp(db.db, env);
}, 180_000);

afterAll(async () => {
  await pg.stop();
});

beforeEach(async () => {
  await truncateAll(db);
});

const post = async (path: string, token: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("POST /api/ingest", () => {
  it("REQ-033: idempotent — same batch posted twice yields one row per event", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "ingest-a@example.test",
      repoUrl: "github.com/example/idempotent",
    });
    const sessionId = "session-idempotent-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "user_msg",
        payload: { text: "hello" },
      },
      {
        event_uuid: "ev-2",
        parent_uuid: "ev-1",
        ts: "2026-05-01T10:00:02.000Z",
        type: "assistant_msg",
        payload: { text: "hi" },
      },
    ]);

    const r1 = await post("/api/ingest", seed.token, payload);
    expect(r1.status).toBe(200);
    const r2 = await post("/api/ingest", seed.token, payload);
    expect(r2.status).toBe(200);

    const j2 = (await r2.json()) as { accepted_events: number; skipped_duplicates: number };
    expect(j2.accepted_events).toBe(0);
    expect(j2.skipped_duplicates).toBe(2);

    const rows =
      await db.sql`SELECT count(*)::int AS c FROM events WHERE session_id = ${sessionId}`;
    expect(rows[0]?.c).toBe(2);
  });

  it("REQ-035: returns 403 if user has not enabled the repo", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "no-repo@example.test",
      grantRepo: false,
    });
    const payload = buildIngestPayload("s-no-repo", "github.com/foreign/repo", []);
    const res = await post("/api/ingest", seed.token, payload);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("repo not enabled for user");
  });

  it("REQ-041: cross-user RBAC — user B's token cannot ingest into user A's repo", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "a-rbac@example.test",
      repoUrl: "github.com/example/a-only",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "b-rbac@example.test",
      repoUrl: "github.com/example/b-only",
      grantRepo: true,
    });
    // B tries to ingest into A's repo
    const payload = buildIngestPayload("s-cross", a.repoCanonical, []);
    const res = await post("/api/ingest", b.token, payload);
    expect(res.status).toBe(403);
  });

  it("REQ-049: API responses serialize timestamps with Z suffix", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "ts@example.test",
      repoUrl: "github.com/example/tz",
    });
    const sessionId = "session-tz-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-z-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "user_msg",
        payload: { text: "z-test" },
      },
    ]);
    const r = await post("/api/ingest", seed.token, payload);
    expect(r.status).toBe(200);

    // Verify TIMESTAMPTZ storage and Z-suffix serialization via raw SQL.
    const rows = await db.sql<{ ts_iso: string; started_iso: string }[]>`SELECT
        to_char((SELECT ts FROM events WHERE session_id = ${sessionId} LIMIT 1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts_iso,
        to_char((SELECT started_at FROM sessions WHERE id = ${sessionId}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_iso`;
    expect(rows[0]?.ts_iso).toMatch(/Z$/);
    expect(rows[0]?.started_iso).toMatch(/Z$/);

    // And that JS Date round-trip via toISOString yields a Z suffix when read
    // through drizzle (which materializes TIMESTAMPTZ as a Date).
    const drizzleRows = await db.db
      .select({ ts: events.ts })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    expect(drizzleRows[0]?.ts.toISOString().endsWith("Z")).toBe(true);
  });

  it("REQ-034: payload containing AKIA... is redacted at rest", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "redact@example.test",
      repoUrl: "github.com/example/redact",
    });
    const sessionId = "session-redact-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-redact-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "tool_use",
        payload: { command: "echo AKIA0123456789ABCDEF run" },
      },
    ]);
    const r = await post("/api/ingest", seed.token, payload);
    expect(r.status).toBe(200);

    const rows = await db.db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    const stored = JSON.stringify(rows[0]?.payload ?? {});
    expect(stored).not.toContain("AKIA0123456789ABCDEF");
    expect(stored).toContain("[REDACTED:");
  });
});

describe("REQ-049: TIMESTAMPTZ column types", () => {
  it("all timestamp columns are TIMESTAMPTZ", async () => {
    const rows = await db.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('timestamp without time zone', 'timestamp with time zone')
    `;
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe(
        "timestamp with time zone",
      );
    }
  });
});
