// AI-generated. See PROMPT.md for the prompts and model used.

import { hashPassword } from "../../src/auth/argon.js";
import { signToken } from "../../src/auth/jwt.js";
import type { DbClient } from "../../src/db/client.js";
import { grantUserRepo, upsertRepo } from "../../src/db/repos.js";
import { users } from "../../src/db/schema.js";

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: "user" | "admin";
}

export interface SeedResult {
  user: SeededUser;
  token: string;
  repoId: string;
  repoCanonical: string;
}

export interface SeedOptions {
  email?: string;
  password?: string;
  role?: "user" | "admin";
  repoUrl?: string;
  grantRepo?: boolean;
}

const randomEmail = (): string => `user-${Math.random().toString(36).slice(2, 10)}@example.test`;

export const seedUser = async (
  db: DbClient,
  jwtSecret: string,
  opts: SeedOptions = {},
): Promise<SeedResult> => {
  const email = opts.email ?? randomEmail();
  const password = opts.password ?? "correct-horse-battery-staple";
  const role = opts.role ?? "user";
  const repoUrl = opts.repoUrl ?? "github.com/example/repo";
  const grantRepo = opts.grantRepo ?? true;

  const passwordHash = await hashPassword(password);
  const inserted = await db
    .insert(users)
    .values({ email, passwordHash, role })
    .returning({ id: users.id, email: users.email, role: users.role });
  const row = inserted[0];
  if (!row) throw new Error("Failed to seed user");

  const repo = await upsertRepo(db, repoUrl);
  if (grantRepo) {
    await grantUserRepo(db, row.id, repo.id, "owner");
  }

  const token = await signToken(
    {
      sub: row.id,
      email: row.email,
      role: role,
      aud: "cli",
    },
    jwtSecret,
  );

  return {
    user: { id: row.id, email: row.email, password, role },
    token,
    repoId: repo.id,
    repoCanonical: repo.canonicalUrl,
  };
};
