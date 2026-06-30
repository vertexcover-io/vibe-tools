// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact — pattern matches (REQ-005)", () => {
  it("redacts an AWS access key", () => {
    const out = redact("token=AKIA0123456789ABCDEF here");
    expect(out.redacted).toContain("[REDACTED:aws-access-key]");
    expect(out.redacted).not.toContain("AKIA0123456789ABCDEF");
    expect(out.hits.find((h) => h.kind === "aws-access-key")?.count).toBe(1);
  });

  it("redacts a GitHub token", () => {
    const out = redact("auth=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done");
    expect(out.redacted).toContain("[REDACTED:github-token]");
    expect(out.redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("redacts an OpenAI key", () => {
    const out = redact("auth: sk-abcdefghijklmnopqrstuvwxyz0123 ok");
    expect(out.redacted).toContain("[REDACTED:openai-key]");
    expect(out.redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
  });

  it("redacts an Anthropic key", () => {
    const longBody = "A".repeat(95);
    const out = redact(`anthropic=sk-ant-${longBody} ok`);
    expect(out.redacted).toContain("[REDACTED:anthropic-key]");
    expect(out.redacted).not.toContain(longBody);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJabc123_-.eyJpYXQiOjE2MDAwMDAwMDB9.dGVzdHNpZ25hdHVyZQ";
    const out = redact(`Authorization=${jwt}`);
    expect(out.redacted).toContain("[REDACTED:jwt]");
    expect(out.redacted).not.toContain(jwt);
  });

  it("redacts an OAuth bearer token", () => {
    const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwx");
    expect(out.redacted).toContain("[REDACTED:oauth-bearer]");
    expect(out.redacted).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("redacts a private key PEM block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\nABCDEFG\n-----END RSA PRIVATE KEY-----";
    const out = redact(`key:\n${pem}\nend`);
    expect(out.redacted).toContain("[REDACTED:private-key-pem]");
    expect(out.redacted).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("redacts an env-line assignment", () => {
    const out = redact("AWS_ACCESS_KEY=AKIA0000000000000001\nother=line");
    expect(out.redacted).toContain("[REDACTED:env-line]");
    // env-line redaction wins; original RHS is gone.
    expect(out.redacted).not.toContain("AWS_ACCESS_KEY=AKIA0000000000000001");
  });
});

describe("redact — entropy detection (REQ-006)", () => {
  it("redacts a 40-char high-entropy base64-looking blob", () => {
    // 40 chars, deliberately high-entropy (base64 alphabet, varied)
    const blob = "aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP9lO8mN7oM6";
    const out = redact(`secret=${blob} done`);
    expect(out.redacted).toContain("[REDACTED:");
    expect(out.redacted).not.toContain(blob);
  });

  it("does NOT redact 40 repeated 'a' characters (low entropy)", () => {
    const lowEntropy = "a".repeat(40);
    const out = redact(`literal ${lowEntropy} text`);
    expect(out.redacted).toContain(lowEntropy);
    expect(out.hits.find((h) => h.kind === "high-entropy")).toBeUndefined();
  });

  it("does NOT redact short high-entropy tokens (length < 32)", () => {
    const shortToken = "aZ9bY8cX7dW6eV5";
    const out = redact(`small ${shortToken} ok`);
    expect(out.redacted).toContain(shortToken);
  });
});

describe("redact — idempotency (REQ-005, REQ-006)", () => {
  it("is idempotent across mixed inputs", () => {
    const sample = [
      "AWS_ACCESS_KEY=AKIA0123456789ABCDEF",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Bearer abcdefghijklmnopqrstuvwx",
      "aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP9lO8mN7oM6",
      "plain text in between",
    ].join("\n");

    const once = redact(sample).redacted;
    const twice = redact(once).redacted;
    expect(twice).toBe(once);
  });

  it("placeholder strings are not themselves redacted on a second pass", () => {
    const placeholder = "[REDACTED:aws-access-key]";
    const out = redact(placeholder);
    expect(out.redacted).toBe(placeholder);
  });
});

describe("redact — hit counts", () => {
  it("returns counts per kind", () => {
    const input = "AKIA0000000000000001 and AKIA0000000000000002";
    const out = redact(input);
    expect(out.hits.find((h) => h.kind === "aws-access-key")?.count).toBe(2);
  });
});
