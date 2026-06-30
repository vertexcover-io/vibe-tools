# agentwire

A WebSocket + REST server that exposes [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
`AgentSession`s backed by the host Claude subscription (no `ANTHROPIC_API_KEY`),
packaged as reusable libraries plus runnable apps.

> Documented exception to the repo's single-file rule: this is a long-running
> TypeScript service, not a one-shot tool.

## Packages

| Package | What it is |
|---------|------------|
| `@agentwire/protocol` | The wire protocol: zod-validated WS/REST frame and message types shared by server and client. |
| `@agentwire/client` | Browser/Node client SDK: connect over WS, send prompts, stream typed server frames, resume sessions. |
| `@agentwire/server` | The core library: pi adapter, session registry, idle scheduler, WS + REST handlers, and `startServer(config)`. |
| `apps/server` | Runnable server: `serve` (HTTP + WS) and `init` (provision extensions + auth registry) CLI. |
| `apps/chat` | Interactive pi-style REPL that auto-starts the server and streams responses. |
| `apps/web` | Single-page web client bundled from `@agentwire/client` and served over HTTP. |

## Develop

```bash
npm install
npm run typecheck    # typecheck every package + app
npm test             # fast, offline unit + integration suite (pi mocked, no network)
npm run test:e2e     # live suite: real pi + host Claude subscription (see below)
```

`npm test` never touches the network — pi is exercised through a mock adapter,
and the `src/e2e` suites are excluded from the default run.

## Run

```bash
npm run serve        # start the HTTP + WS server (defaults to port 8787)
npm run chat         # interactive REPL (auto-starts a background server)
npm run web          # bundle + serve the single-page web client
```

The server defaults its config dir to `~/.pi/agent`, where the host Claude Code
subscription creds are seeded (`auth.json`, by the `pi-claude-auth` pi
extension), so `serve` authenticates against the host subscription with no extra
env. Override resolution with the vars below.

| Env var | Default | Meaning |
|---------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `~/.pi/agent` | Isolated pi `agentDir` (where `auth.json` lives) |
| `PI_WORKING_DIR` | `apps/server/.sessions` | Pinned working dir for all sessions |
| `SERVER_BEARER_TOKENS` | (none) | CSV of accepted bearer tokens |
| `IDLE_MS` | `300000` | Idle window before a detached session is reaped |
| `MAX_HOT` | `50` | Max concurrent hot sessions |
| `PORT` | `8787` | Server port |

`init`-time runtime config (`settings.json`, `auth-registry.json`) lives in
`apps/server/`; the runnable app resolves them relative to itself.

## Live e2e

The live suite drives the real REST + WS server against **live pi** and the
**host's Claude subscription** — no `ANTHROPIC_API_KEY`. Auth is resolved from
`~/.pi/agent/auth.json` (seeded from the macOS Keychain by the `pi-claude-auth`
pi extension), so the run bills the host subscription, not an API key.

```bash
unset ANTHROPIC_API_KEY      # let pi use the seeded subscription auth
npm run test:e2e             # {packages,apps}/**/src/e2e only, serial, long timeouts
```

If the creds are absent the suite skips with a clear message (`describe.skipIf`);
when present it runs for real. Each test uses a throwaway `PI_WORKING_DIR`, so
session JSONL lands under `~/.pi/agent/sessions/<encoded-temp>/` and is cleaned
up on teardown. Coverage: WS connect + streamed responses with usage, thinking
on/off, `POST /complete`, `GET /sessions` + `/messages`, resume across
reconnect, detach-to-completion with buffered replay, single-writer
`session_busy`, and bearer enforcement.

## Interactive chat CLI

`npm run chat` starts a pi-style REPL that auto-starts the server in the
background and streams responses. To attach to an already-running server:

```bash
npx tsx apps/chat/src/chat.ts --connect ws://localhost:8787 --token secret123
```

In the REPL: type a prompt and watch text stream. Slash commands:
`/new`, `/resume <id>`, `/sessions`, `/thinking <off|low|medium|high|xhigh>`,
`/clear`, `/help`, `/quit`. Ctrl-C interrupts the current turn; Ctrl-D quits.
Tool calls show inline as `[tool: <name>]`.
