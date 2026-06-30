# agentwire-web

Minimal example web app demonstrating `@agentwire/client` running in a real browser,
talking to a running agentwire server over WS/REST.

## Run

1. Start the agentwire server (default port `8787`):

   ```sh
   SERVER_BEARER_TOKENS=devtoken npm run serve
   ```

2. Start this web dev server (default port `5173`):

   ```sh
   npm run web
   # or: tsx apps/web/src/serve.ts
   ```

3. Open the printed URL (e.g. `http://127.0.0.1:5173`).

4. In the page: set the **server base URL** (default `http://127.0.0.1:8787`) and paste the
   **bearer token** (`devtoken`), click **Connect**, type a prompt, and **Send**.

`New session` closes the current client and connects a fresh session.

## How it works

`src/serve.ts` is a tiny Node http server (run via `tsx`). It serves `src/index.html` at `/`
and an esbuild-bundled browser ESM build of `@agentwire/client` at `/client.js` (bundled once
at startup). The page imports the SDK with `import { createClient } from "/client.js"` and
wires `text_delta`, `tool_execution_start`, `turn_end`, `session_ready`, and `error` events
into the transcript — no framework, no build step for the page itself.
