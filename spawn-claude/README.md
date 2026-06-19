# spawn-claude

Spawn another Claude Code session from within (or outside) a session, with three
independent pluggable axes:

| Axis | Flag | Options |
|------|------|---------|
| **Surface** — where it runs | `--surface` | `auto` (default) · `tmux` · `cmux` · `ghostty` · `terminal` · `headless` |
| **Mode** — how it runs | `--mode` | `interactive` (default) · `headless` |
| **Context** — what it starts with | `--context` | `fresh` (default) · `summary` · `fork` |

## Run

```bash
uv run spawn-claude.py [prompt] [flags]
```

Examples:

```bash
# fresh interactive session in a new Ghostty window
uv run spawn-claude.py --surface ghostty "investigate the flaky test"

# headless: run to completion and return output, seeded with a summary of the current session
uv run spawn-claude.py --mode headless --context summary "write the migration"

# fork this session: opens claude --fork-session and auto-runs /rewind so you
# pick the branch point in the new session, here in a stacked tmux split
uv run spawn-claude.py --context fork --surface tmux --tmux-target split-v "try the alternative approach"

# fork in a ghostty split (side-by-side)
uv run spawn-claude.py --context fork --surface ghostty --ghostty-target split-h "branch off here"

# see the resolved claude command without launching
uv run spawn-claude.py --context fresh --surface ghostty --dry-run "hello"
```

## How each axis works

**Surfaces** each reduce to "run `claude …` somewhere", and each takes a placement target:
- `tmux` (requires `$TMUX`) → `--tmux-target {window,split-h,split-v,session}`. `window` (default) is a new tab; `split-h`/`split-v` split the current pane side-by-side/stacked; `session` creates a new detached session and switches the client to it.
- `cmux` → `--cmux-target {tab,window,workspace,split-h,split-v}`. `tab` (default) and the splits open in the current workspace; `workspace` opens a separate workspace in the current window; `window` opens a fresh window.
- `ghostty` → `--ghostty-target {new-window,tab,split-h,split-v}`. `new-window` (default) launches a brand-new app window via `open -na`; `tab`/`split-h`/`split-v` drive the **focused** Ghostty window via its default keybinds (so Ghostty must be frontmost — true when you spawn from inside it).
- `terminal` → `osascript` driving Terminal.app.
- `headless` → `claude -p …` in the foreground, output captured. `--mode headless` forces this surface.

`split-h` is side-by-side, `split-v` is stacked.

`--surface auto` picks: `$TMUX` → tmux, else `$TERM_PROGRAM=ghostty` → ghostty, else cmux if installed, else terminal.

**Context:**
- `fresh` → `claude "<prompt>"`.
- `summary` → seeds the child with a short summary of the most recent parent messages, then the task.
- `fork` → native branch via `claude --resume <parent-id> --fork-session`, which gives the new session
  its own id without touching the parent. The script then **auto-sends `/rewind`** into the new session so
  you pick the branch point in its own UI. Interactive only; the task prompt is printed as a reminder to run
  *after* you select a point (not auto-submitted, since the rewind happens first). On surfaces that can't
  inject keystrokes (cmux window/workspace, ghostty new-window, terminal) the `/rewind` step is a printed hint.

## Parent-session detection

For `summary`/`fork`, the parent is auto-detected as the transcript in the project dir whose **last
message is most recent** (i.e. the live session). Override with `--session-id <uuid>`. Use `--cwd` to
target a different project directory.

## Requirements

`claude` CLI with `--fork-session` support. Surfaces require their respective tools
(`tmux`, `cmux`, Ghostty.app) to be installed. Ghostty tab/split targets and the `terminal` surface
use AppleScript (`osascript`) and need macOS Accessibility permission for keystroke sending.

## Slash command

`spawn.md` is installed as `/spawn` by symlinking it into `~/.claude/commands/`.
