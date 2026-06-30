// AI-generated. See PROMPT.md for the prompts and model used.

import { type ChildProcess, type ExecFileException, execFile } from "node:child_process";

/**
 * Invoke `claude -p` (Claude Code's headless mode) per the same shape as
 * `pin/pin.py`'s `call_claude` and `aibash/aibash.sh`. We pass the prompt
 * on stdin, request `--output-format json`, and parse the envelope's
 * `structured_output` (preferred) or fall back to JSON-decoding `result`.
 *
 * Tools are explicitly disabled — the summarizer must never run shell
 * commands or touch the filesystem. `--no-session-persistence` ensures
 * each invocation is hermetic, and `--setting-sources ""` strips the
 * user's project-level Claude config so tests are reproducible.
 */

export interface RunClaudeOptions {
  systemPrompt: string;
  userMessage: string;
  schema: object;
  model?: string;
  /** Override binary name (tests typically inject "claude-mock"). */
  bin?: string;
  /** Override timeout in ms; default 120s. */
  timeoutMs?: number;
  /** Inject a custom execFile (tests use vi.mock; this is a clean seam). */
  execFileImpl?: typeof execFile;
}

const DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookEdit",
  "TodoWrite",
];

interface ClaudeEnvelope {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
}

const decodeEnvelope = (stdout: string): unknown => {
  let env: ClaudeEnvelope;
  try {
    env = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    throw new Error(`claude returned non-JSON output: ${stdout.slice(0, 256)}`);
  }
  if (env.is_error) {
    throw new Error(`claude reported is_error: ${env.result ?? "(no result)"}`);
  }
  if (env.structured_output !== undefined && env.structured_output !== null) {
    return env.structured_output;
  }
  if (typeof env.result === "string" && env.result.trim().length > 0) {
    try {
      return JSON.parse(env.result);
    } catch {
      throw new Error(`claude result string was not valid JSON: ${env.result.slice(0, 256)}`);
    }
  }
  throw new Error("claude envelope had neither structured_output nor parseable result");
};

const runOnce = (
  bin: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  execFileImpl: typeof execFile,
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child: ChildProcess = execFileImpl(
      bin,
      args as string[],
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (err: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          const errMsg =
            typeof stderr === "string"
              ? stderr
              : Buffer.isBuffer(stderr)
                ? stderr.toString("utf8")
                : err.message;
          reject(new Error(`claude failed (rc=${err.code ?? "?"}): ${errMsg || err.message}`));
          return;
        }
        if (typeof stdout === "string") resolve(stdout);
        else resolve(stdout.toString("utf8"));
      },
    );
    if (child.stdin) {
      child.stdin.end(input);
    }
  });

export const runClaude = async (opts: RunClaudeOptions): Promise<unknown> => {
  const bin = opts.bin ?? "claude";
  const args: string[] = [
    "-p",
    "--model",
    opts.model ?? "sonnet",
    "--append-system-prompt",
    opts.systemPrompt,
    "--json-schema",
    JSON.stringify(opts.schema),
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--",
  ];
  const stdout = await runOnce(
    bin,
    args,
    opts.userMessage,
    opts.timeoutMs ?? 120_000,
    opts.execFileImpl ?? execFile,
  );
  return decodeEnvelope(stdout);
};

export const _internal = { decodeEnvelope, DISALLOWED_TOOLS };
