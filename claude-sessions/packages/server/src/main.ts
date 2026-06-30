// AI-generated. See PROMPT.md for the prompts and model used.

import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const app = buildApp(db, env);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
