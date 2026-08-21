# ccpack

Pack a Claude Code session into a zip. "cc" for Claude Code, "pack" for what it does.

Pick a session from an `fzf` picker — date, project, title, and a live readable preview of
the actual conversation — then zip it. The preview shows **you and Claude talking**, not
raw JSONL. Tool calls collapse to one dim line each so the thread stays readable.

## Run

```bash
./ccpack.py                            # pick from every session
./ccpack.py granola                    # pre-filter the list, then pick
./ccpack.py 397965be                   # session id (8+ char prefix) — preview, then enter to zip
./ccpack.py -d                         # only sessions started in this folder or below
./ccpack.py -d ~/Projects/andromeda    # ...or any other folder
./ccpack.py 397965be --print           # dump the markdown transcript to stdout
```

Requires [`uv`](https://docs.astral.sh/uv/) and [`fzf`](https://github.com/junegunn/fzf).
No Python dependencies — stdlib only.

In the picker: `enter` zips, `esc` cancels, `tab` multi-selects, `ctrl-/` toggles preview.

## Web UI

```bash
./ccpack.py --serve          # http://127.0.0.1:8765
./ccpack.py --serve 9000     # pick a port
```

Same sessions, same transcripts, in a browser: filter box on the left, conversation on
the right, one button to download the zip. Arrow keys move through the list, `/` jumps to
the filter.

The server binds to `127.0.0.1` only, sends no CORS headers, and rejects requests whose
`Host` header is not localhost — so a web page you happen to be visiting cannot read your
sessions through it. It is still a plain local server with no password: do not port-forward it.

A browser cannot reach `~/.claude/projects` on its own — the File System Access API would
make you re-pick that hidden folder every visit, and it is Chrome-only. Serving from the
script sidesteps all of that.

A session id still opens the picker on that one session, so you see the preview before
anything is written. Pass `-y` to skip that. When output is piped or there is no terminal,
the confirm is skipped automatically and the picker refuses to launch rather than hang.

## Options

| Flag | What it does |
| --- | --- |
| `-d [PATH]` | Only sessions started in PATH or below it. Bare `-d` means the current folder |
| `--serve [PORT]` | Browse sessions in a local web UI (default port 8765) |
| `-o DIR` | Where to write the zip (default: current directory) |
| `-y` | Skip the confirm preview when given a session id |
| `--print` | Print the markdown transcript instead of zipping |
| `--no-subagents` | Leave subagent transcripts out of the zip |

## What is in the zip

Named `ccpack-SHORT_ID.zip`, using the first 8 characters of the session id:

```
ccpack-397965be.zip
```

Inside:

- `transcript.md` — the readable conversation
- `session.jsonl` — the untouched original, so nothing is lost
- `meta.json` — session id, project path, git branch, timestamps, message counts
- `subagents/*.jsonl` — any subagent transcripts belonging to the session

## How it finds sessions

Claude Code writes sessions to `~/.claude/projects/ENCODED_CWD/SESSION_ID.jsonl`, with
subagent transcripts under `SESSION_ID/subagents/`. The picker index is built by reading
only the first 128 KB and last 256 KB of each file — enough for the title, project path and
git branch — so listing ~150 sessions takes under a tenth of a second. Full parsing happens
only for the session you preview or export.

Titles come from the session's `ai-title` entry, falling back to your first prompt.
