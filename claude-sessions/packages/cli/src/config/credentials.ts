// AI-generated. See PROMPT.md for the prompts and model used.

import { atomicWriteJson, readJsonOr, withFileLock } from "./atomic.js";
import { credentialsPath } from "./paths.js";

export interface Credentials {
  server_url: string;
  token: string;
  user_email: string;
}

export const readCredentials = (): Credentials | null => {
  const data = readJsonOr<Partial<Credentials> | null>(credentialsPath(), null);
  if (!data) return null;
  if (!data.server_url || !data.token || !data.user_email) return null;
  return data as Credentials;
};

export const writeCredentials = async (creds: Credentials): Promise<void> => {
  await withFileLock(credentialsPath(), () => {
    atomicWriteJson(credentialsPath(), creds, 0o600);
  });
};

export const requireCredentials = (): Credentials => {
  const c = readCredentials();
  if (!c) {
    throw new Error("not logged in — run `claude-sessions login` first");
  }
  return c;
};
