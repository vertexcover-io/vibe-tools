// AI-generated. See PROMPT.md for the prompts and model used.

import { bgeProvider } from "./bge.js";
import { fakeProvider } from "./fake.js";
import { openaiProvider } from "./openai.js";

/**
 * Provider abstraction for `vector(1536)` embeddings used by the search
 * index (REQ-038). The summary upload handler calls `embed()` inline so
 * the embedding row is persisted in the same request that wrote the
 * summary.
 *
 * v0 ships OpenAI as the canonical provider and a deterministic `fake`
 * provider for tests. `bge` is wired in as an explicit "not implemented
 * in v0" stub so callers fail loudly instead of silently swapping models.
 */
export interface EmbedProvider {
  name: string;
  embed: (text: string) => Promise<number[]>;
}

export const EMBED_DIM = 1536;

let cached: EmbedProvider | null = null;

export const getEmbedProvider = (): EmbedProvider => {
  if (cached) return cached;
  const choice = process.env.EMBED_PROVIDER ?? "openai";
  switch (choice) {
    case "openai":
      cached = openaiProvider();
      return cached;
    case "bge":
      cached = bgeProvider();
      return cached;
    case "fake":
      cached = fakeProvider();
      return cached;
    case "none":
      // Used only by phase 0-3 server tests that never POST a summary.
      cached = {
        name: "none",
        embed: () => Promise.reject(new Error("EMBED_PROVIDER=none cannot generate embeddings")),
      };
      return cached;
    default:
      throw new Error(`unknown EMBED_PROVIDER: ${choice}`);
  }
};

/** Tests reset the cached provider after mutating env. */
export const resetEmbedProvider = (): void => {
  cached = null;
};
