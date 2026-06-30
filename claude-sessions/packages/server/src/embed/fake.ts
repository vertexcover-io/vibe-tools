// AI-generated. See PROMPT.md for the prompts and model used.

import { createHash } from "node:crypto";
import { EMBED_DIM, type EmbedProvider } from "./index.js";

/**
 * Deterministic, hash-derived embedding for tests. Identical input text
 * always produces the identical 1536-vector; different inputs produce
 * very different vectors. This lets the embedding-store/embedding-search
 * tests run without an OpenAI key.
 *
 * The vector is L2-normalized so cosine distance comparisons in pgvector
 * behave like a real model (similar texts will have non-zero similarity).
 */
export const fakeProvider = (): EmbedProvider => ({
  name: "fake-embed-v1",
  embed: (text: string): Promise<number[]> => {
    const out = new Array<number>(EMBED_DIM);
    // Stretch a SHA-256 hash into 1536 floats by re-hashing with an index.
    const blocks = Math.ceil((EMBED_DIM * 4) / 32); // 32 bytes per sha256
    const buf = Buffer.alloc(blocks * 32);
    for (let i = 0; i < blocks; i++) {
      const h = createHash("sha256");
      h.update(text);
      h.update(Buffer.from([i & 0xff, (i >> 8) & 0xff]));
      h.digest().copy(buf, i * 32);
    }
    let sumSq = 0;
    for (let i = 0; i < EMBED_DIM; i++) {
      // Treat 4 bytes as int32 → map to [-1, 1].
      const v = buf.readInt32LE(i * 4) / 0x7fffffff;
      out[i] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < EMBED_DIM; i++) {
      out[i] = (out[i] ?? 0) / norm;
    }
    return Promise.resolve(out);
  },
});
