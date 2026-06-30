// AI-generated. See PROMPT.md for the prompts and model used.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/claude_sessions",
  },
  strict: true,
  verbose: true,
});
