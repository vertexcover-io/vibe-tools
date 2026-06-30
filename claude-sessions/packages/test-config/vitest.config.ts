// AI-generated. See PROMPT.md for the prompts and model used.

import { defineConfig } from "vitest/config";

/**
 * Shared vitest config for all packages in the monorepo.
 *
 * Each package can extend this via `defineConfig({ ...sharedVitestConfig, ... })`
 * or import the export below directly.
 */
export const sharedVitestConfig = defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});

export default sharedVitestConfig;
