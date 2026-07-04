---
name: granola-cli
description: >
  Access your Granola meeting notes and transcripts from the private Granola API.
  Find a specific call by name, attendee, date, or project/folder — then load its
  transcript or AI notes. Trigger on requests like "find my call with <person>",
  "what did we discuss in <meeting> yesterday", "get the transcript for the
  <folder> sync", "list my meetings today / this week / in <project>", "pull the
  notes from my last <topic> call". Also trigger on any mention of Granola
  meetings, standups, or syncs by name/person/date.
license: MIT
allowed-tools: Bash Read
metadata:
  author: vibe-tools
  version: "1.0"
---

# granola-cli

Reads the local Granola auth (`~/Library/Application Support/Granola/supabase.json`)
to mint a fresh access token, then calls the Granola private API. The CLI does the
fetching and filtering; **you** (the agent) do the disambiguation and reading.

## The script

`granola-cli.py` lives beside this file. Run with `uv run` (PEP 723 — deps are
self-contained). Locate it:

```bash
SKILL_DIR=$(for d in ~/.agents ~/.claude ~/.copilot ~/.gemini ~/.cursor ~/.windsurf ~/.opencode ~/.codex; do
  [ -f "$d/skills/granola-cli/granola-cli.py" ] && echo "$d/skills/granola-cli" && break
done)
[ -z "$SKILL_DIR" ] && echo "granola-cli not installed into a skills dir" && exit 1
```

Then `uv run "$SKILL_DIR/granola-cli.py" <command> [options]`.

## Commands

- `list` (alias `ls`) — list/filter meetings. Combine any filters:
  - `--name <text>` / `-n` — title contains
  - `--with <person>` / `--person` / `-p` — attendee name or email contains
  - `--day <when>` / `--date` / `-d` — `today`, `yesterday`, `tomorrow`,
    `this week`, `last week`, or `YYYY-MM-DD`
  - `--project <name>` / `--folder` / `-f` — scope to a Granola folder (fuzzy title match)
  - `--limit <n>` / `-l`, `--json`
- `get` (alias `find`) — same filters as `list`, but resolves to the single best
  (most recent) match and prints the exact `transcript <id>` / `notes <id>`
  commands to load it. Use this to answer "find my call with X".
- `transcript <id-or-title>` — full transcript with speaker turns and `[m:ss]`
  timestamps. Accepts a document id or a title query (resolves to most recent match).
- `notes <id-or-title>` — the meeting's markdown notes + AI-generated panels (summary).
- `folders` — list all projects/folders with their ids.

All commands take `--json` for machine-readable output.

## How to handle requests

The canonical flow is **find, then load**. For a request like
*"find my conversation with Aman yesterday in the Harness sync and show me the transcript"*:

1. Resolve the meeting with `get`, layering the filters the user gave:
   `get --with aman --day yesterday --project "Harness"`.
   - `get` prints the best match plus ready-to-run `transcript <id>` / `notes <id>` lines.
   - If several plausible meetings match (it lists up to 10), and the user's
     intent is ambiguous, show them the short list and ask which one — or just
     take the most recent if the request implies "the latest".
2. Load what they asked for — `transcript <id>` for the spoken record, `notes <id>`
   for the written/AI summary. If they didn't say which, default to notes (shorter)
   and offer the transcript.
3. Then work with the content in conversation: summarize, answer questions, pull
   action items, quote with `[m:ss]` timestamps. Don't shell out again — you read
   the returned text directly.

Guidance:

- **"list my meetings today / this week"** → `list --day today` / `list --day "this week"`.
- **"what's in the <X> project/folder"** → `list --project "<X>"`; use `folders`
  first if unsure of the exact name.
- **"my calls with <person>"** → `list --with <person>`. Attendee matching is a
  substring on name+email, so a short name can over-match (e.g. "aman" also hits
  "Naman"); narrow with `--project` or `--day`, or pick from the list.
- **"the transcript/notes for <meeting title>"** → `transcript "<title>"` /
  `notes "<title>"` directly (title query resolves to the most recent match).
- When summarizing or answering, preserve what was actually said; cite timestamps
  from the transcript; don't invent content.

## Search note

There is a `search-meetings-turbopuffer` endpoint, but its request body is
constructed server-side and returns an opaque `400` for every client payload, so
this tool does **not** use it. Filtering is done client-side over `get-documents`,
which is exact and supports attendee/date/folder filters that keyword search
can't. This is a feature, not a limitation.

## Errors

The script prints `ERROR: <message>` and exits non-zero. Common cases:
`supabase.json not found` (Granola not installed / not signed in),
`refresh failed` (stale refresh token — reopen Granola to re-auth),
`no folder matching <name>` (lists available folders),
`no meeting matched` (loosen the filters).
