// AI-generated. See PROMPT.md for the prompts and model used.

/**
 * Secret redaction for transcripts before they leave the device.
 *
 * Two layers:
 *   1. Named regex patterns for well-known credential shapes (REQ-005).
 *   2. Shannon-entropy heuristic for unknown high-entropy tokens (REQ-006).
 *
 * Output uses fixed placeholders `[REDACTED:<kind>]` so the function is
 * idempotent: a second pass over the redacted string is a no-op.
 *
 * IMPORTANT: pattern order matters. `env-line` is applied first so the
 * RHS of `KEY=secret` is collapsed even if the secret itself wouldn't
 * match a more specific pattern.
 */

export interface RedactHit {
  kind: string;
  count: number;
}

export interface RedactResult {
  redacted: string;
  hits: RedactHit[];
}

interface Pattern {
  kind: string;
  re: RegExp;
}

const PLACEHOLDER_RE = /\[REDACTED:[a-z-]+\]/g;

const PATTERNS: Pattern[] = [
  // Line-anchored env-var assignments — apply first so we don't waste a
  // more specific match on a value we'd hide anyway.
  { kind: "env-line", re: /^[A-Z][A-Z0-9_]{2,}=.+$/gm },
  // PEM blocks span multiple lines; apply before single-line patterns.
  {
    kind: "private-key-pem",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  // Anthropic before generic openai (sk-ant- is more specific than sk-).
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9-]{90,}\b/g },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: "oauth-bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi },
];

/**
 * Shannon entropy in bits per character.
 *
 * Returns 0 for the empty string (no information). Used to flag tokens
 * that look like random keys/secrets but don't match a known pattern.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY_MIN_LEN = 32;
const HIGH_ENTROPY_MIN_BITS = 4.5;

function isHighEntropyToken(token: string): boolean {
  return token.length >= HIGH_ENTROPY_MIN_LEN && shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS;
}

// Tokenize on whitespace and a few common separators. We keep delimiters
// out of tokens so a "word" like `foo=AKIA...` becomes ["foo", "AKIA..."]
// and only the high-entropy half is replaced.
const TOKEN_SPLIT_RE = /([\s,;:"'`<>(){}\[\]=]+)/;

function applyEntropyPass(input: string): { redacted: string; count: number } {
  let count = 0;
  // Split keeps the separators in the resulting array (capturing group).
  const parts = input.split(TOKEN_SPLIT_RE);
  const out = parts.map((part) => {
    // Don't touch placeholders.
    if (PLACEHOLDER_RE.test(part)) {
      PLACEHOLDER_RE.lastIndex = 0;
      return part;
    }
    if (isHighEntropyToken(part)) {
      count++;
      return "[REDACTED:high-entropy]";
    }
    return part;
  });
  return { redacted: out.join(""), count };
}

function bumpHit(hits: Map<string, number>, kind: string, by: number): void {
  if (by <= 0) return;
  hits.set(kind, (hits.get(kind) ?? 0) + by);
}

/**
 * Redact known secret patterns and high-entropy tokens from a string.
 *
 * Idempotent — running `redact` on its own output is a no-op.
 */
export function redact(input: string): RedactResult {
  const hits = new Map<string, number>();
  let work = input;

  for (const { kind, re } of PATTERNS) {
    let matchCount = 0;
    work = work.replace(re, () => {
      matchCount++;
      return `[REDACTED:${kind}]`;
    });
    bumpHit(hits, kind, matchCount);
  }

  const entropy = applyEntropyPass(work);
  work = entropy.redacted;
  bumpHit(hits, "high-entropy", entropy.count);

  return {
    redacted: work,
    hits: Array.from(hits, ([kind, count]) => ({ kind, count })),
  };
}
