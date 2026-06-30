// AI-generated. See PROMPT.md for the prompts and model used.

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),
  JWT_SECRET: z.string().min(8),
  EMBED_PROVIDER: z.enum(["openai", "bge", "fake", "none"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBED_MODEL: z.string().default("text-embedding-3-small"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(source);
};
