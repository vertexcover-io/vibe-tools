// AI-generated. See PROMPT.md for the prompts and model used.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Config } from "@agentwire/server";
import { APP_DIR } from "./config.ts";

export interface Settings {
  readonly packages: readonly string[];
}

export interface AuthEntry {
  readonly name: string;
  readonly authKind: string;
  readonly flow: string;
}

export type Installer = (pkg: string, configDir: string) => Promise<void>;
export type AuthRunner = (entry: AuthEntry) => Promise<{ ok: boolean }>;

export interface InitDeps {
  readonly installer: Installer;
  readonly authRunner: AuthRunner;
  readonly readSettings: () => Settings;
  readonly readRegistry: () => readonly AuthEntry[];
}

export interface InitSummary {
  readonly installed: readonly string[];
  readonly configured: readonly string[];
  readonly unconfigured: readonly string[];
}

export const readSettingsFile = (): Settings => {
  const raw = readFileSync(resolve(APP_DIR, "settings.json"), "utf8");
  return JSON.parse(raw) as Settings;
};

export const readRegistryFile = (): readonly AuthEntry[] => {
  const raw = readFileSync(resolve(APP_DIR, "auth-registry.json"), "utf8");
  return JSON.parse(raw) as readonly AuthEntry[];
};

export const runInit = async (
  cfg: Config,
  deps: InitDeps,
): Promise<InitSummary> => {
  const installed: string[] = [];
  for (const pkg of deps.readSettings().packages) {
    await deps.installer(pkg, cfg.configDir);
    installed.push(pkg);
  }

  const configured: string[] = [];
  const unconfigured: string[] = [];
  for (const entry of deps.readRegistry()) {
    const ok = await runAuthEntry(deps.authRunner, entry);
    (ok ? configured : unconfigured).push(entry.name);
  }

  return { installed, configured, unconfigured };
};

const runAuthEntry = async (
  authRunner: AuthRunner,
  entry: AuthEntry,
): Promise<boolean> => {
  try {
    const result = await authRunner(entry);
    return result.ok;
  } catch {
    return false;
  }
};

export const verifyConfigDir = (
  cfg: Config,
  readSettings: () => Settings = readSettingsFile,
): void => {
  const missing = readSettings().packages.filter(
    (pkg) => !existsSync(resolve(cfg.configDir, "node_modules", pkg)),
  );
  if (missing.length > 0) {
    throw new Error(`run init (config dir: ${cfg.configDir})`);
  }
};
