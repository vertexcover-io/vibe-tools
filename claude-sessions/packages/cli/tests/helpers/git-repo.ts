// AI-generated. See PROMPT.md for the prompts and model used.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Make a real git repo in a tmp dir with a fake `origin` remote. */
export const makeTempGitRepo = (
  origin = "git@github.com:fixture/repo.git",
): {
  path: string;
  origin: string;
  cleanup: () => void;
} => {
  const path = mkdtempSync(join(tmpdir(), "cs-git-"));
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin]);
  // Need at least one file so .git is fully populated.
  mkdirSync(join(path, "src"), { recursive: true });
  return {
    path,
    origin,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
};
