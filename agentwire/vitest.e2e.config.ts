// AI-generated. See PROMPT.md for the prompts and model used.
import { defineConfig } from "vitest/config";

// Live e2e suite: real pi + Claude subscription. Long per-test timeouts; run
// serially so the single-writer / resume scenarios don't contend for the host
// subscription. Invoked via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ["{packages,apps}/**/src/e2e/**/*.e2e.test.ts"],
    testTimeout: 300000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
