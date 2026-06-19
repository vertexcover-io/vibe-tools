---
description: Spawn another Claude Code session (pluggable surface/mode/context)
argument-hint: [prompt] — then pick surface/mode/context if not obvious
allowed-tools: Bash(uv run /Users/vertexcover/Projects/vibe-tools/spawn-claude/spawn-claude.py:*), AskUserQuestion
---

Spawn a **new** Claude Code session for this task: `$ARGUMENTS`

Use the tool at `/Users/vertexcover/Projects/vibe-tools/spawn-claude/spawn-claude.py` (run with `uv run`).

**Always pass `--session-id ${CLAUDE_SESSION_ID}`** so `summary`/`fork` target THIS session — never let the script guess the parent from the filesystem (it can pick the wrong concurrent session). The current session id for this run is `${CLAUDE_SESSION_ID}`.

Decide the three axes — ask the user with AskUserQuestion only if the prompt doesn't make them obvious:

**Surface detection:** if the surface isn't given (or is `auto`), run `--detect-surface` first — it prints JSON `{confident, inside, available}` and launches nothing. If `confident` is a surface, use it silently. If `confident` is `null` (we're inside more than one surface, e.g. tmux-in-cmux, or ghostty-in-cmux), do **not** guess — ask the user with AskUserQuestion to pick among the `inside` candidates, then pass that as `--surface`. (Calling with `--surface auto` while ambiguous exits 2 with a `NEEDS_CONFIRMATION` message rather than guessing.)

- **--surface**: `auto` (default; uses `--detect-surface` and asks when ambiguous), or force `tmux`/`cmux`/`ghostty`/`terminal`/`headless`. Each surface has its own placement target:
  - **--cmux-target**: `tab` (default) / `window` / `workspace` / `split-h` / `split-v`.
  - **--tmux-target**: `window` (default, a new tab) / `split-h` / `split-v` / `session` (new detached session, switches to it).
  - **--ghostty-target**: `new-window` (default, brand-new app window) / `tab` / `split-h` / `split-v` (tab & splits drive the focused window via its keybinds).
  - `split-h` = side-by-side, `split-v` = stacked.
- **--mode**: `interactive` (a real session to watch/take over) or `headless` (runs to completion, returns output).
- **--context**:
  - `fresh` — just the prompt.
  - `summary` — seed the child with a summary of THIS session, then the task.
  - `fork` — branch off this session natively: opens `claude --resume <thisSessionId> --fork-session` in the new surface and **auto-sends `/rewind`** so you pick the branch point in the forked session's own UI. Interactive only. The task you pass is printed as a reminder to run *after* you select a point (it is not auto-submitted, since the rewind comes first).

Once the axes are settled, run it directly — no need to `--dry-run` every time. (`--dry-run` is still available to preview the resolved command when something is unclear.)

Examples (always include `--session-id ${CLAUDE_SESSION_ID}`):
- `uv run .../spawn-claude.py --session-id ${CLAUDE_SESSION_ID} --surface ghostty --context fresh "investigate the flaky test"`
- `uv run .../spawn-claude.py --session-id ${CLAUDE_SESSION_ID} --mode headless --context summary "write the migration"`
- `uv run .../spawn-claude.py --session-id ${CLAUDE_SESSION_ID} --context fork --surface cmux --cmux-target split-v "try the alternative approach"`  # forks + /rewind in a stacked split
- `uv run .../spawn-claude.py --session-id ${CLAUDE_SESSION_ID} --context fork --surface ghostty --ghostty-target tab "branch off here"`

The current working directory is passed through automatically; the parent session is auto-detected and never mutated.
