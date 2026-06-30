// AI-generated. See PROMPT.md for the prompts and model used.

import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { type Db, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

export interface TestPgHandle {
  url: string;
  container: StartedTestContainer | null;
  db: Db;
  stop: () => Promise<void>;
}

const buildUrl = (host: string, port: number, user: string, pw: string, dbName: string): string =>
  `postgres://${user}:${pw}@${host}:${port}/${dbName}`;

export const startTestPostgres = async (): Promise<TestPgHandle> => {
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    await runMigrations(url);
    const db = createDb(url);
    return {
      url,
      container: null,
      db,
      stop: async () => {
        await db.close();
      },
    };
  }

  const container = await new GenericContainer("pgvector/pgvector:pg16")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "claude_sessions_test",
    })
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = buildUrl(host, port, "postgres", "postgres", "claude_sessions_test");

  // Wait briefly for postgres to be ready, then run migrations.
  await new Promise((r) => setTimeout(r, 1000));
  await runMigrations(url);
  const db = createDb(url);

  return {
    url,
    container,
    db,
    stop: async () => {
      await db.close();
      await container.stop();
    },
  };
};

export const truncateAll = async (db: Db): Promise<void> => {
  await db.sql`TRUNCATE
    audit_log,
    session_pr_links,
    session_blobs,
    embeddings,
    summaries,
    events,
    sessions,
    user_repos,
    repos,
    users
    RESTART IDENTITY CASCADE`;
};
