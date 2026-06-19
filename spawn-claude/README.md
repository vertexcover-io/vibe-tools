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

## Flags (help-style overview)

```
uv run spawn-claude.py [prompt] [flags] [-- extra args for claude]

positional:
  prompt                  Prompt for the new session. Optional for fork (the
                          task is shown as a reminder after you pick a branch point).

axes:
  --surface SURFACE       Where it runs. One of:
                            auto (default)  detect what's running; ask if ambiguous
                            tmux            pane/window in the current tmux session
                            cmux            surface in cmux
                            ghostty         a Ghostty window/tab/split
                            terminal        macOS Terminal.app (AppleScript)
                            headless        run to completion, capture output
  --mode MODE             How it runs:
                            interactive (default)  a live session to watch/take over
                            headless               non-interactive; forces --surface headless
  --context CONTEXT       What it starts with:
                            fresh (default)  just the prompt
                            summary          seed with a summary of the parent session
                            fork             branch off via --fork-session, auto-/rewind

placement targets (per surface):
  --tmux-target T         window (default) | split-h | split-v | session
  --cmux-target T         tab (default) | window | workspace | split-h | split-v
  --ghostty-target T      new-window (default) | tab | split-h | split-v
                          (split-h = side-by-side, split-v = stacked)

parent session (for summary/fork):
  --session-id UUID       Parent session id. Recommended — avoids guessing among
                          concurrent sessions sharing a project dir.

other:
  --model MODEL           Model for the child session (passed to claude --model)
  --cwd PATH              Working directory (defaults to current; passed through)
  --detect-surface        Print surface detection as JSON and exit (no launch):
                          {confident, inside, available}
  --dry-run               Print the resolved claude command without launching
  extra...                Any trailing args are forwarded straight to claude

exit codes:
  0  success (or detection/dry-run printed)
  1  usage error (no claude on PATH, fork without parent, etc.)
  2  NEEDS_CONFIRMATION — `auto` was ambiguous; pass --surface explicitly
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

# just check what surface auto-detection sees (prints JSON, launches nothing)
uv run spawn-claude.py --detect-surface
```

## How each axis works

**Surfaces** each reduce to "run `claude …` somewhere", and each takes a placement target:
- `tmux` (requires `$TMUX`) → `--tmux-target {window,split-h,split-v,session}`. `window` (default) is a new tab; `split-h`/`split-v` split the current pane side-by-side/stacked; `session` creates a new detached session and switches the client to it.
- `cmux` → `--cmux-target {tab,window,workspace,split-h,split-v}`. `tab` (default) and the splits open in the current workspace; `workspace` opens a separate workspace in the current window; `window` opens a fresh window.
- `ghostty` → `--ghostty-target {new-window,tab,split-h,split-v}`. `new-window` (default) launches a brand-new app window via `open -na`; `tab`/`split-h`/`split-v` drive the **focused** Ghostty window via its default keybinds (so Ghostty must be frontmost — true when you spawn from inside it).
- `terminal` → `osascript` driving Terminal.app.
- `headless` → `claude -p …` in the foreground, output captured. `--mode headless` forces this surface.

`split-h` is side-by-side, `split-v` is stacked.

**`--surface auto`** detects what's actually running rather than guessing. It separates surfaces it's
*inside* (strong env signals: `$TMUX` → tmux, `$CMUX_WORKSPACE_ID`/`$CMUX_SURFACE_ID` → cmux,
`$TERM_PROGRAM=ghostty`/`$GHOSTTY_RESOURCES_DIR` → ghostty) from those merely *available* (on PATH or
app bundle present). It resolves silently only when exactly one surface is *inside* — or nothing is
present at all, in which case it falls back to `terminal`. When more than one surface is inside
(e.g. ghostty-in-cmux or tmux-in-cmux nesting), it **refuses to guess**: it exits with code `2` and a
`NEEDS_CONFIRMATION` message listing the candidates, so the caller can confirm. Run `--detect-surface`
to see the same `{confident, inside, available}` result as JSON without launching anything.

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

## Install

The script runs standalone via `uv` — nothing to install for the script itself:

```bash
git clone https://github.com/vertexcover-io/vibe-tools.git
uv run vibe-tools/spawn-claude/spawn-claude.py --detect-surface
```

To use it as the `/spawn` slash command in Claude Code, symlink `spawn.md` into `~/.claude/commands/`:

```bash
ln -s "$PWD/vibe-tools/spawn-claude/spawn.md" ~/.claude/commands/spawn.md
# then in Claude Code:  /spawn <your prompt>
```

`spawn.md` hardcodes the absolute path to `spawn-claude.py`, so if you clone elsewhere, edit that path
inside `spawn.md` to match.
