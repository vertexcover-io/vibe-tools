// AI-generated. See PROMPT.md for the prompts and model used.
import { defineConfig } from "vitest/config";

// Default `vitest run` (npm test) is the fast/offline unit+integration suite.
// The live e2e suite under src/e2e/ talks to real pi + Claude and is excluded
// here — run it explicitly via `npm run test:e2e`.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**", "**/*.e2e.test.ts"],
  },
});
