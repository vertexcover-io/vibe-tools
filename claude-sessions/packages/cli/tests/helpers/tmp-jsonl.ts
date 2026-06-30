// AI-generated. See PROMPT.md for the prompts and model used.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helpers for building Claude-Code-shaped JSONL fixtures inside a tmp dir.
 *
 * Each event is the minimum shape `parseLine` needs (`type`, `uuid`,
 * `timestamp`, `sessionId`, `cwd`, `message`). Tests append more events
 * mid-run to simulate live writes (REQ-014, EDGE-009).
 */

export interface FixtureEnv {
  configHome: string;
  projectsRoot: string;
  cleanup: () => void;
}

export const makeFixtureEnv = (): FixtureEnv => {
  const configHome = mkdtempSync(join(tmpdir(), "cs-config-"));
  const projectsRoot = mkdtempSync(join(tmpdir(), "cs-projects-"));
  process.env.CLAUDE_SESSIONS_HOME = configHome;
  process.env.CLAUDE_PROJECTS_DIR = projectsRoot;
  return {
    configHome,
    projectsRoot,
    cleanup: () => {
      rmSync(configHome, { recursive: true, force: true });
      rmSync(projectsRoot, { recursive: true, force: true });
      process.env.CLAUDE_SESSIONS_HOME = undefined;
      process.env.CLAUDE_PROJECTS_DIR = undefined;
    },
  };
};

export interface BuildEventOpts {
  uuid: string;
  parentUuid?: string | null;
  sessionId: string;
  cwd: string;
  ts?: string;
  type?: "user" | "assistant";
  text?: string;
}

export const buildEvent = (opts: BuildEventOpts): Record<string, unknown> => {
  const ts = opts.ts ?? new Date().toISOString();
  const isAssistant = opts.type === "assistant";
  return {
    type: opts.type ?? "user",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid ?? null,
    timestamp: ts,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    version: "1.0.0",
    gitBranch: "main",
    permissionMode: "default",
    message: isAssistant
      ? {
          role: "assistant",
          model: "claude-3-5-sonnet",
          content: [{ type: "text", text: opts.text ?? `assistant ${opts.uuid}` }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      : {
          role: "user",
          content: opts.text ?? `user ${opts.uuid}`,
        },
  };
};

const encodeCwd = (path: string): string => path.replace(/\//g, "-");

export interface FixtureFile {
  path: string;
  cwd: string;
  sessionId: string;
}

export const createSessionFile = (
  projectsRoot: string,
  cwd: string,
  sessionId: string,
  events: Record<string, unknown>[],
): FixtureFile => {
  const dir = join(projectsRoot, encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const text = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  writeFileSync(path, text);
  return { path, cwd, sessionId };
};

export const appendToSessionFile = (path: string, events: Record<string, unknown>[]): void => {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  appendFileSync(path, text);
};
