// AI-generated. See PROMPT.md for the prompts and model used.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadEnv } from "../env.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

export const runMigrations = async (databaseUrl: string): Promise<string[]> => {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await sql`SELECT name FROM schema_migrations WHERE name = ${file}`;
      if (existing.length > 0) continue;
      const contents = await readFile(join(migrationsDir, file), "utf8");
      await sql.unsafe(contents);
      await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const env = loadEnv();
  runMigrations(env.DATABASE_URL)
    .then((applied) => {
      if (applied.length === 0) {
        console.log("No new migrations to apply.");
      } else {
        console.log(`Applied: ${applied.join(", ")}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
