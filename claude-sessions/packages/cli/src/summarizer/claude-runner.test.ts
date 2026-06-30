// AI-generated. See PROMPT.md for the prompts and model used.

import type { ChildProcess, ExecFileException } from "node:child_process";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { _internal, runClaude } from "./claude-runner.js";

type ExecFileCb = (err: ExecFileException | null, stdout: string, stderr: string) => void;

const fakeExec = (
  envelope: unknown,
  options: {
    isError?: boolean;
    stderr?: string;
    rc?: number;
    throwInsteadOfEnvelope?: string;
  } = {},
): ((cmd: string, args: readonly string[], opts: object, cb: ExecFileCb) => ChildProcess) => {
  return ((_cmd: string, _args: readonly string[], _opts: object, cb: ExecFileCb) => {
    setImmediate(() => {
      if (options.throwInsteadOfEnvelope) {
        const err = new Error("boom") as ExecFileException;
        err.code = options.rc ?? 1;
        cb(err, "", options.stderr ?? "boom-stderr");
        return;
      }
      const body = options.isError
        ? JSON.stringify({ is_error: true, result: "rate-limited" })
        : typeof envelope === "string"
          ? envelope
          : JSON.stringify(envelope);
      cb(null, body, "");
    });
    return {
      stdin: new Writable({ write: (_chunk, _enc, done) => done() }),
    } as unknown as ChildProcess;
  }) as unknown as (
    cmd: string,
    args: readonly string[],
    opts: object,
    cb: ExecFileCb,
  ) => ChildProcess;
};

describe("decodeEnvelope", () => {
  it("returns structured_output when present", () => {
    const out = _internal.decodeEnvelope(JSON.stringify({ structured_output: { title: "ok" } }));
    expect(out).toEqual({ title: "ok" });
  });

  it("falls back to JSON-parsing the result string when structured_output is missing", () => {
    const out = _internal.decodeEnvelope(
      JSON.stringify({ result: JSON.stringify({ title: "fallback" }) }),
    );
    expect(out).toEqual({ title: "fallback" });
  });

  it("throws on non-JSON output", () => {
    expect(() => _internal.decodeEnvelope("not json")).toThrow(/non-JSON/);
  });

  it("throws when is_error is true", () => {
    expect(() =>
      _internal.decodeEnvelope(JSON.stringify({ is_error: true, result: "rate" })),
    ).toThrow(/is_error/);
  });

  it("throws when neither field can be parsed", () => {
    expect(() => _internal.decodeEnvelope(JSON.stringify({}))).toThrow(/neither structured_output/);
    expect(() => _internal.decodeEnvelope(JSON.stringify({ result: "not-json" }))).toThrow(
      /not valid JSON/,
    );
  });
});

describe("runClaude", () => {
  it("invokes execFile with disallowed tools and parses structured_output", async () => {
    let receivedArgs: readonly string[] = [];
    const exec = ((cmd: string, args: readonly string[], opts: object, cb: ExecFileCb) => {
      receivedArgs = args;
      return fakeExec({ structured_output: { title: "summary" } })(cmd, args, opts, cb);
    }) as unknown as typeof import("node:child_process").execFile;

    const out = await runClaude({
      systemPrompt: "you are a summarizer",
      userMessage: "transcript here",
      schema: { type: "object" },
      execFileImpl: exec,
    });
    expect(out).toEqual({ title: "summary" });
    expect(receivedArgs).toContain("--no-session-persistence");
    expect(receivedArgs).toContain("--disallowedTools");
    expect(receivedArgs).toContain("Bash");
    expect(receivedArgs).toContain("--json-schema");
    // setting-sources empty string is required
    const idx = receivedArgs.indexOf("--setting-sources");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(receivedArgs[idx + 1]).toBe("");
  });

  it("falls back to result-string parsing when structured_output is absent", async () => {
    const exec = fakeExec({
      result: JSON.stringify({ title: "result-string", summary: "x" }),
    }) as unknown as typeof import("node:child_process").execFile;
    const out = await runClaude({
      systemPrompt: "sys",
      userMessage: "u",
      schema: {},
      execFileImpl: exec,
    });
    expect(out).toEqual({ title: "result-string", summary: "x" });
  });

  it("surfaces stderr when claude exits non-zero", async () => {
    const exec = fakeExec(null, {
      throwInsteadOfEnvelope: "boom",
      stderr: "rate limited",
      rc: 1,
    }) as unknown as typeof import("node:child_process").execFile;
    await expect(
      runClaude({
        systemPrompt: "sys",
        userMessage: "u",
        schema: {},
        execFileImpl: exec,
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
