#!/usr/bin/env -S npx tsx
// AI-generated. See PROMPT.md for the prompts and model used.
import { main } from "./cli.ts";

main(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
