# Prompt log

**Model/agent:** Claude Opus 4.8 (1M context) via Claude Code.

## Original request

> Can I build a claude command that uses cmux/ghostty api to start another claude
> session with a prompt from within the current session?

## Refined requirements (via clarifying questions)

- **Surface**: pluggable core supporting tmux / cmux / ghostty / default terminal / headless.
- **Mode**: both interactive and headless.
- **Context**: fresh, summary-of-current-context, and fork-from-a-point.
- **Fork point**: select a message via an fzf-style picker.
- **Packaging**: Python script core + a thin slash command entry point.
- **Location**: a tool folder in this repo, symlinked into `~/.claude/commands/`.

## Key facts discovered during build

- Claude Code CLI (v2.1.183) natively supports `--fork-session`, `--resume <id>`,
  `--session-id <uuid>`, and `-p/--print` — so forking doesn't require hand-editing transcripts,
  though forking from an *arbitrary* message still needs a truncated transcript copy.
- Transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; each `user`/`assistant`
  line carries `uuid`, `timestamp`, and content blocks — ideal for the fzf picker.
- The encoded cwd replaces every non-alphanumeric char with `-`.
- The *live* session is the transcript whose last message is most recent (mtime is unreliable because
  metadata sidecar files get touched).
- macOS cannot launch Ghostty's emulator from the CLI; must use `open -na Ghostty.app --args -e`.
- cmux ships a real CLI at `/Applications/cmux.app/Contents/Resources/bin/cmux` with
  `new-window` and workspace commands.

## Design

A single `spawn-claude.py` with: parent-session detection → context provider (fresh/summary/fork,
fork using an fzf picker + truncated transcript copy that rewrites `sessionId` and leaves the parent
untouched) → surface adapter (one small `launch(argv, cwd)` function per surface) → launch.
`spawn.md` is the `/spawn` slash command that drives it.

## Iteration: smarter surface detection

> Improve spawn identification of surface select tmux/cmux/ghostty if not provided
> based on what is running currently; if not clear ask for confirmation. No need to
> run dry-run every time.

- Replaced the "first match wins" `detect_surface()` with `probe_surface()`, which separates
  surfaces we're demonstrably *inside* (strong env signals: `$TMUX`, `$CMUX_WORKSPACE_ID`/
  `$CMUX_SURFACE_ID`, `$TERM_PROGRAM=ghostty`/`$GHOSTTY_RESOURCES_DIR`) from those merely
  *available* (on PATH / app bundle present).
- `auto` resolves silently only when exactly one surface is `inside` (or nothing at all is
  present → plain `terminal`). Otherwise it raises `AmbiguousSurface` and the CLI exits 2 with a
  `NEEDS_CONFIRMATION` message + JSON candidates instead of guessing. Nesting like ghostty-in-cmux
  is genuinely ambiguous, so the agent confirms with the user via AskUserQuestion.
- Added `--detect-surface` (prints `{confident, inside, available}` JSON, launches nothing) so the
  `/spawn` skill can probe before launching.
- `/spawn` no longer requires a `--dry-run` every time; it's kept as an optional preview.
