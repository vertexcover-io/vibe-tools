// AI-generated. See PROMPT.md for the prompts and model used.

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// vitest brings its own pinned vite version; cast keeps the react plugin
// usable across both vite trees without forcing a single resolved path.
export default defineConfig({
  // biome-ignore lint/suspicious/noExplicitAny: cross-vite-tree plugin compat
  plugins: [react() as any],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
  },
});
