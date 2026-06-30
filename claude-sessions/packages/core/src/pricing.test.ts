// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import { computeCostUsd, matchFamily } from "./pricing.js";

describe("matchFamily", () => {
  it("returns the family key for an exact match", () => {
    expect(matchFamily("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(matchFamily("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(matchFamily("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("strips date suffixes from full model ids", () => {
    expect(matchFamily("claude-opus-4-7-20250514")).toBe("claude-opus-4-7");
    expect(matchFamily("claude-sonnet-4-6-20250101")).toBe("claude-sonnet-4-6");
    expect(matchFamily("claude-haiku-4-5-20251231")).toBe("claude-haiku-4-5");
  });

  it("falls back to sonnet for unknown models", () => {
    expect(matchFamily("gpt-4o")).toBe("claude-sonnet-4-6");
    expect(matchFamily("claude-future-7-0")).toBe("claude-sonnet-4-6");
    expect(matchFamily("")).toBe("claude-sonnet-4-6");
  });
});

describe("computeCostUsd", () => {
  it("computes cost for sonnet with known usage", () => {
    // sonnet: input=$3/M, output=$15/M
    // 1M input + 1M output = $3 + $15 = $18
    const cost = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it("includes cache-write and cache-read tokens", () => {
    // sonnet cache_write=$3.75/M, cache_read=$0.3/M
    // 1M cache_write + 1M cache_read = $3.75 + $0.3 = $4.05
    const cost = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4.05, 6);
  });

  it("computes opus cost correctly", () => {
    // opus: input=$15/M, output=$75/M
    // 100k input + 50k output = (100_000 * 15 + 50_000 * 75) / 1_000_000
    //   = (1_500_000 + 3_750_000) / 1_000_000 = 5.25
    const cost = computeCostUsd("claude-opus-4-7", {
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    expect(cost).toBeCloseTo(5.25, 6);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    const unknown = computeCostUsd("gpt-4o", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    const sonnet = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(unknown).toBe(sonnet);
  });

  it("handles missing cache fields as zero", () => {
    const cost = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(cost).toBeCloseTo(3, 6);
  });

  it("returns 0 for all-zero usage", () => {
    const cost = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost).toBe(0);
  });
});
