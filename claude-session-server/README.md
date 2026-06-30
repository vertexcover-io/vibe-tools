# claude-session-server

A WebSocket + REST server that exposes [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
`AgentSession`s backed by the host Claude subscription (no `ANTHROPIC_API_KEY`).

> Documented exception to the repo's single-file rule: this is a long-running TypeScript service, not a one-shot tool.

## Status

Phase 1 — package scaffold, config loader, and a thin pi adapter. The WS/REST server,
session registry, and `init` CLI land in later phases.

## Layout

- `src/config.ts` — pure `loadConfig(env)` returning the server `Config` (config dir, bearer tokens, pinned working dir, idle window, max-hot cap, port).
- `src/pi-adapter.ts` — thin wrapper over `createAgentSession` / `SessionManager`: `createSession`, `openSession`, and `toServerFrame` (maps a pi `AgentSessionEvent` to a normalized server frame).

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `<pkg>/.pi-config` | Isolated pi `agentDir` |
| `PI_WORKING_DIR` | `<pkg>/.sessions` | Pinned working dir for all sessions |
| `SERVER_BEARER_TOKENS` | (none) | CSV of accepted bearer tokens |
| `IDLE_MS` | `300000` | Idle window before a detached session is reaped |
| `MAX_HOT` | `50` | Max concurrent hot sessions |
| `PORT` | `8787` | Server port |

## Develop

```bash
cd claude-session-server
npm install
npm run typecheck
npm test          # fast, offline unit + integration suite (63 tests)
```

`npm test` never touches the network — pi is exercised through a mock adapter,
and `src/e2e` is excluded from the default run.

## Live e2e

The live suite drives the real REST + WS server against **live pi** and the
**host's Claude subscription** — no `ANTHROPIC_API_KEY`. Auth is resolved from
`~/.pi/agent/auth.json` (seeded from the macOS Keychain by the `pi-claude-auth`
pi extension), so the run bills the host subscription, not an API key.

```bash
cd claude-session-server
unset ANTHROPIC_API_KEY      # let pi use the seeded subscription auth
npm run test:e2e            # vitest.e2e.config.ts — src/e2e only, serial, long timeouts
```

Requirements: pi installed, the host Claude Code subscription creds present
(`~/.pi/agent/auth.json` with an `anthropic` entry), and network. If those creds
are absent the suite skips with a clear message (`describe.skipIf`); when present
it runs for real. Each test uses a throwaway `PI_WORKING_DIR`, so session JSONL
lands under `~/.pi/agent/sessions/<encoded-temp>/` and is cleaned up on teardown.

The e2e covers: WS connect + streamed `PONG` with usage, thinking on/off,
`POST /complete`, `GET /sessions` + `/messages`, resume across reconnect
(remembers a fact), detach-to-completion with buffered replay, single-writer
`session_busy`, and bearer enforcement (4401 / 401).
