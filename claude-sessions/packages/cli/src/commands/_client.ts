// AI-generated. See PROMPT.md for the prompts and model used.

import { requireCredentials } from "../config/credentials.js";
import { UploadClient } from "../upload/client.js";

export const buildClient = (): UploadClient => {
  const creds = requireCredentials();
  return new UploadClient({ serverUrl: creds.server_url, token: creds.token });
};
