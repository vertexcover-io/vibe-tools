// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import { fakeProvider } from "./fake.js";

describe("fakeProvider", () => {
  const provider = fakeProvider();

  it("returns 1536-dim L2-normalized vectors", async () => {
    const v = await provider.embed("hello world");
    expect(v).toHaveLength(1536);
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("is deterministic for the same input", async () => {
    const a = await provider.embed("same input string");
    const b = await provider.embed("same input string");
    expect(a).toEqual(b);
  });

  it("differs noticeably for different inputs", async () => {
    const a = await provider.embed("phase 4 summarizer");
    const b = await provider.embed("phase 5 search ui");
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) diff++;
    }
    expect(diff).toBeGreaterThan(1500);
  });
});
