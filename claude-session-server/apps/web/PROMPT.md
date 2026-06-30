# Prompt log — agentwire-web

**Model/agent:** Claude Opus 4.8 (1M context) via Claude Code, agentwire monorepo Phase 8.

## Prompt

Build `apps/web`, an example web app proving `@agentwire/client` works in a real browser
against a running agentwire server:

- `package.json` — `agentwire-web` (private, type module), dep `@agentwire/client`, devDeps
  `esbuild` + `tsx`, scripts `dev`/`web` (`tsx src/serve.ts`) and `typecheck`.
- `tsconfig.json` — extends the base config; node types for `serve.ts`.
- `src/serve.ts` — a tiny Node http dev server (via `tsx`) that serves `index.html` at `/` and
  an esbuild-bundled browser ESM of `@agentwire/client` (`packages/client/src/index.ts`,
  bundle, format esm, platform browser, write:false) at `/client.js`, cached at startup. Reads
  `PORT` (default 5173); prints the URL and a token hint.
- `src/index.html` — single vanilla-JS file: inputs for server base URL + bearer token, a
  Connect button, prompt textarea + Send, a transcript pane, and New session. Inline module
  script imports `createClient` from `/client.js`, wires `text_delta`, `tool_execution_start`,
  `turn_end`, `session_ready`, `error`, and calls `client.prompt(text)`. No framework, no
  dialogs.
- `README.md` — run steps.

Verify: `tsc --noEmit` clean; esbuild bundles the client cleanly (non-empty, contains
`createClient`); optionally curl `/` and `/client.js`.
