// AI-generated. See PROMPT.md for the prompts and model used.

/**
 * Per-million-token prices (USD) for each Claude model family.
 *
 * Pricing reference: https://www.anthropic.com/pricing#api (2025).
 * Cache-write rate is the documented 1.25x of input; cache-read is 0.1x.
 * Unknown models fall through to sonnet pricing in `computeCostUsd` —
 * sonnet is the most common default and produces a reasonable estimate
 * rather than a $0 silent miss.
 */
interface ModelPrice {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-7": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
};

const FALLBACK_FAMILY = "claude-sonnet-4-6";

/**
 * Strip date and revision suffixes from a Claude model id to get the family
 * key used in `PRICES`.
 *
 * Examples:
 *   "claude-opus-4-7-20250514"  -> "claude-opus-4-7"
 *   "claude-sonnet-4-6"          -> "claude-sonnet-4-6"
 *   "gpt-4o"                     -> "gpt-4o" (no match -> caller falls back)
 *
 * Strategy: longest-prefix match against known family keys. We don't try to
 * be clever with regex here — the family list is small and explicit.
 */
export function matchFamily(model: string): string {
  const families = Object.keys(PRICES);
  // Try exact match first, then prefix match (longest first).
  if (families.includes(model)) return model;
  const sorted = [...families].sort((a, b) => b.length - a.length);
  for (const family of sorted) {
    if (model.startsWith(`${family}-`) || model.startsWith(family)) {
      return family;
    }
  }
  return FALLBACK_FAMILY;
}

export interface UsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Compute USD cost for a single assistant turn from its `usage` block.
 *
 * Sums input, output, cache-write, and cache-read tokens at the family's
 * per-million rates. Unknown models fall back to sonnet pricing rather than
 * throwing or returning 0 — see `matchFamily` rationale.
 */
export function computeCostUsd(model: string, usage: UsageBlock): number {
  const family = matchFamily(model);
  const p = PRICES[family] ?? PRICES[FALLBACK_FAMILY];
  if (!p) return 0;
  const total =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    (usage.cache_creation_input_tokens ?? 0) * p.cache_write +
    (usage.cache_read_input_tokens ?? 0) * p.cache_read;
  return total / 1_000_000;
}
