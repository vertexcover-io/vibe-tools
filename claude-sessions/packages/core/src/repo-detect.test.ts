// AI-generated. See PROMPT.md for the prompts and model used.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeRemoteUrl, canonicalizeRepo, detectRepo, findGitRoot } from "./repo-detect.js";

describe("canonicalizeRepo (REQ-048)", () => {
  it("normalizes all four equivalent forms of a repo url", () => {
    const expected = "github.com/vertexcover-io/vibe-tools";
    const variants = [
      "https://github.com/vertexcover-io/vibe-tools.git",
      "https://github.com/vertexcover-io/vibe-tools",
      "git@github.com:vertexcover-io/vibe-tools.git",
      "git@github.com:vertexcover-io/vibe-tools",
    ];
    for (const v of variants) {
      expect(canonicalizeRepo(v)).toBe(expected);
    }
  });

  it("lowercases host and path", () => {
    expect(canonicalizeRepo("https://GitHub.com/Org/Repo")).toBe("github.com/org/repo");
  });

  it("strips trailing .git", () => {
    expect(canonicalizeRepo("github.com/foo/bar.git")).toBe("github.com/foo/bar");
  });

  it("collapses duplicate slashes", () => {
    expect(canonicalizeRepo("github.com//foo//bar")).toBe("github.com/foo/bar");
  });

  it("canonicalizeRemoteUrl is an alias for canonicalizeRepo", () => {
    expect(canonicalizeRemoteUrl("git@github.com:Org/Repo.git")).toBe(
      canonicalizeRepo("git@github.com:Org/Repo.git"),
    );
  });
});

describe("findGitRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-detect-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no ancestor has .git", () => {
    const sub = join(tmp, "deep", "nested");
    mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(null);
  });

  it("returns the toplevel when a .git dir exists", () => {
    execFileSync("git", ["init", "-q", tmp]);
    const sub = join(tmp, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(tmp);
  });
});

describe("detectRepo (REQ-010, REQ-011, EDGE-005, EDGE-006)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "detect-repo-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null in a non-git path (REQ-011)", () => {
    expect(detectRepo(tmp)).toBe(null);
  });

  it("returns canonical_url + toplevel when origin remote is set", () => {
    execFileSync("git", ["init", "-q", "-b", "main", tmp]);
    execFileSync("git", ["-C", tmp, "remote", "add", "origin", "git@github.com:foo/bar.git"]);
    const id = detectRepo(tmp);
    expect(id).not.toBeNull();
    expect(id?.canonical_url).toBe("github.com/foo/bar");
    expect(id?.toplevel).toBe(tmp);
  });

  it("EDGE-006: when no origin, falls back to first alphabetical remote", () => {
    execFileSync("git", ["init", "-q", "-b", "main", tmp]);
    execFileSync("git", ["-C", tmp, "remote", "add", "upstream", "git@github.com:zeta/up.git"]);
    execFileSync("git", ["-C", tmp, "remote", "add", "alpha", "git@github.com:alpha/down.git"]);
    const id = detectRepo(tmp);
    expect(id?.canonical_url).toBe("github.com/alpha/down");
  });
});
