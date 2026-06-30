import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig, DEFAULT_PI_AGENT_DIR, APP_DIR } from "./config.ts";

describe("loadConfig", () => {
  it("test_REQ_027_config_dir_resolution: defaults to the pi agent dir (where auth lives), env override wins", () => {
    const def = loadConfig({});
    expect(def.configDir).toBe(DEFAULT_PI_AGENT_DIR);

    const overridden = loadConfig({ CLAUDE_CONFIG_DIR: "/custom/pi-config" });
    expect(overridden.configDir).toBe(resolve("/custom/pi-config"));
  });

  it("test_REQ_023_pinned_cwd_consistent: working dir is pinned/stable across calls", () => {
    const a = loadConfig({});
    const b = loadConfig({});
    expect(a.workingDir).toBe(b.workingDir);
    expect(a.workingDir).toBe(resolve(APP_DIR, ".sessions"));

    const overridden = loadConfig({ PI_WORKING_DIR: "/pinned/work" });
    expect(overridden.workingDir).toBe(resolve("/pinned/work"));
  });

  it("parses bearer tokens, idle, capacity, and port with defaults", () => {
    const def = loadConfig({});
    expect(def.bearerTokens).toEqual([]);
    expect(def.idleMs).toBe(300000);
    expect(def.maxHot).toBe(50);
    expect(def.port).toBe(8787);

    const env = loadConfig({
      SERVER_BEARER_TOKENS: "a, b ,c",
      IDLE_MS: "1000",
      MAX_HOT: "5",
      PORT: "9000",
    });
    expect(env.bearerTokens).toEqual(["a", "b", "c"]);
    expect(env.idleMs).toBe(1000);
    expect(env.maxHot).toBe(5);
    expect(env.port).toBe(9000);
  });
});
