// AI-generated. See PROMPT.md for the prompts and model used.

import type { EmbedProvider } from "./index.js";

/**
 * Placeholder for future on-prem `bge-small-en-v1.5` (or larger) support.
 *
 * v0 ships OpenAI 1536-dim only. BGE-small produces 384 dims, BGE-large
 * produces 1024 dims — neither matches the schema's `vector(1536)`. When
 * we add this, we'll either:
 *   - migrate the schema to a flexible dim
 *   - default to BGE-large + zero-pad
 *   - or run BGE behind a projection head
 *
 * For now, fail loudly. TODO: add `onnxruntime-node` dep + model loader.
 */
export const bgeProvider = (): EmbedProvider => ({
  name: "bge-small-en-v1.5",
  embed: () =>
    Promise.reject(new Error("EMBED_PROVIDER=bge is not implemented in v0; use openai or fake")),
});
