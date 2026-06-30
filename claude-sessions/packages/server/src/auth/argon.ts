// AI-generated. See PROMPT.md for the prompts and model used.

import { hash, verify } from "@node-rs/argon2";

const argonOpts = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = async (password: string): Promise<string> => {
  return hash(password, argonOpts);
};

export const verifyPassword = async (password: string, digest: string): Promise<boolean> => {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
};
