// AI-generated. See PROMPT.md for the prompts and model used.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
