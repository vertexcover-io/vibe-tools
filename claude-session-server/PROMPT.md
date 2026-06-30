# Prompts & model

**Agent:** Claude Code, model Opus 4.8 (1M context).

This package is built phase-by-phase from a harness spec/plan:

- Spec: `.harness/features/claude-session-server/spec.md`
- Plan: `.harness/features/claude-session-server/plan.md`
- Phase files: `.harness/runtime/claude-session-server/phase-*.md`

## Phase 1

> Invoke the **tdd** skill. Build Phase 1 of the Claude Session Server: a buildable,
> typechecking TS package with config loading and a thin pi adapter that can
> create/dispose a session against live pi 0.79.9.
>
> Scope: `package.json` / `tsconfig.json` / `.gitignore`; `src/config.ts`
> (pure `loadConfig(env)`); `src/pi-adapter.ts` (`createSession`, `openSession`,
> `toServerFrame`, with `ANTHROPIC_API_KEY` never forwarded); `src/config.test.ts`
> (REQ-027 config-dir resolution + override, REQ-023 pinned working dir). TDD: failing
> config test first, then implement. A throwaway smoke confirmed the pi import, a
> returned `sessionId`, and dispose against live pi; observed `AgentSessionEvent` field
> names are captured in a comment at the top of `pi-adapter.ts`.

Built against pi 0.79.9, verified from the package's bundled `.d.ts` files (not guessed).
