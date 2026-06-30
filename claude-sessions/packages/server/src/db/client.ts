// AI-generated. See PROMPT.md for the prompts and model used.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;
export type Sql = postgres.Sql;

export interface Db {
  db: DbClient;
  sql: Sql;
  close: () => Promise<void>;
}

export const createDb = (databaseUrl: string): Db => {
  const sql = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
};
