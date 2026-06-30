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
npm test
```
