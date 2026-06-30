import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@agentwire/server";
import { runInit, verifyConfigDir } from "./init.ts";

const SETTINGS = {
  packages: ["pi-mono-linear", "@e9n/pi-gmail", "pi-agent-browser-native"],
};

const REGISTRY = [
  { name: "linear", authKind: "api-key", flow: "linear-auth" },
  { name: "notion", authKind: "mcp-oauth", flow: "mcp-auth notion" },
  { name: "gmail", authKind: "google-oauth", flow: "gmail-consent" },
] as const;

const makeCfg = (configDir: string): Config => ({
  configDir,
  bearerTokens: [],
  workingDir: "/tmp/work",
  idleMs: 1000,
  maxHot: 1,
  port: 0,
});

describe("runInit", () => {
  it("test_REQ_026_init_installs_declared: installer called once per declared package with configDir", async () => {
    const cfg = makeCfg("/cfg");
    const calls: Array<{ pkg: string; dir: string }> = [];
    const installer = async (pkg: string, dir: string): Promise<void> => {
      calls.push({ pkg, dir });
    };
    const authRunner = async (): Promise<{ ok: boolean }> => ({ ok: true });

    const summary = await runInit(cfg, {
      installer,
      authRunner,
      readSettings: () => SETTINGS,
      readRegistry: () => [...REGISTRY],
    });

    expect(calls.map((c) => c.pkg)).toEqual(SETTINGS.packages);
    expect(calls.every((c) => c.dir === "/cfg")).toBe(true);
    expect(summary.installed).toEqual(SETTINGS.packages);
  });

  it("test_REQ_028_init_auth_registry_continue_on_fail: iterates in order, failing entry → unconfigured, continues", async () => {
    const cfg = makeCfg("/cfg");
    const seen: string[] = [];
    const installer = async (): Promise<void> => {};
    const authRunner = async (entry: {
      name: string;
    }): Promise<{ ok: boolean }> => {
      seen.push(entry.name);
      if (entry.name === "notion") return { ok: false };
      return { ok: true };
    };

    const summary = await runInit(cfg, {
      installer,
      authRunner,
      readSettings: () => SETTINGS,
      readRegistry: () => [...REGISTRY],
    });

    expect(seen).toEqual(["linear", "notion", "gmail"]);
    expect(summary.configured).toEqual(["linear", "gmail"]);
    expect(summary.unconfigured).toEqual(["notion"]);
  });

  it("test_EDGE_018_unconfigured_service: a thrown authRunner is treated as unconfigured and init proceeds", async () => {
    const cfg = makeCfg("/cfg");
    const seen: string[] = [];
    const installer = async (): Promise<void> => {};
    const authRunner = async (entry: {
      name: string;
    }): Promise<{ ok: boolean }> => {
      seen.push(entry.name);
      if (entry.name === "linear") throw new Error("missing credential");
      return { ok: true };
    };

    const summary = await runInit(cfg, {
      installer,
      authRunner,
      readSettings: () => SETTINGS,
      readRegistry: () => [...REGISTRY],
    });

    expect(seen).toEqual(["linear", "notion", "gmail"]);
    expect(summary.unconfigured).toEqual(["linear"]);
    expect(summary.configured).toEqual(["notion", "gmail"]);
  });
});

describe("verifyConfigDir", () => {
  it("test_EDGE_015_config_dir_mismatch_fails_fast: throws run-init message when a declared package is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "css-cfg-"));
    try {
      const cfg = makeCfg(base);
      expect(() =>
        verifyConfigDir(cfg, () => ({ packages: ["pi-mono-linear"] })),
      ).toThrow(`run init (config dir: ${base})`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("passes when all declared packages are resolvable under configDir", () => {
    const base = mkdtempSync(join(tmpdir(), "css-cfg-"));
    try {
      mkdirSync(join(base, "node_modules", "pi-mono-linear"), {
        recursive: true,
      });
      const cfg = makeCfg(base);
      expect(() =>
        verifyConfigDir(cfg, () => ({ packages: ["pi-mono-linear"] })),
      ).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
