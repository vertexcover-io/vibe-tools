// AI-generated. See PROMPT.md for the prompts and model used.

import { EMBED_DIM, type EmbedProvider } from "./index.js";

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Calls OpenAI's `text-embedding-3-small` (1536 dims) over the public
 * Embeddings API. Implemented with raw `fetch` to avoid pulling the
 * official SDK into the server bundle for one endpoint.
 */
export const openaiProvider = (): EmbedProvider => {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

  return {
    name: model,
    embed: async (text: string): Promise<number[]> => {
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required when EMBED_PROVIDER=openai");
      }
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`openai embed failed: HTTP ${res.status} ${body}`);
      }
      const data = (await res.json()) as OpenAIEmbedResponse;
      const vec = data.data[0]?.embedding;
      if (!Array.isArray(vec)) throw new Error("openai embed: missing embedding in response");
      if (vec.length !== EMBED_DIM) {
        throw new Error(`openai embed: expected ${EMBED_DIM} dims, got ${vec.length}`);
      }
      return vec;
    },
  };
};
