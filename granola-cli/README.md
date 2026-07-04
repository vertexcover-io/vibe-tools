# granola-cli

Access your [Granola](https://granola.ai) meeting notes and transcripts from the
command line via Granola's private API. List/filter meetings by name, attendee,
date, or project/folder, then load the transcript or the AI-generated notes.

Auth is automatic: the CLI reads the local Granola session file
(`~/Library/Application Support/Granola/supabase.json`), uses its `refresh_token`
to mint a short-lived access token, and calls the API. You must have the Granola
desktop app installed and signed in.

## Run

Standalone via [`uv`](https://docs.astral.sh/uv/) (PEP 723 inline deps — nothing installed globally):

```bash
uv run granola-cli.py <command> [options]
```

## Commands

```bash
# list / filter (combine freely)
uv run granola-cli.py list --day today
uv run granola-cli.py list --with aman --project "Harness"
uv run granola-cli.py list --name "standup" --day "last week"

# resolve to a single best match + get load commands
uv run granola-cli.py get --with aman --day yesterday --project "Harness"

# load content (by document id or by title query)
uv run granola-cli.py transcript <id-or-title>
uv run granola-cli.py notes <id-or-title>

# projects/folders
uv run granola-cli.py folders
```

Filters: `--name/-n`, `--with/--person/-p`, `--day/--date/-d`
(`today`/`yesterday`/`this week`/`last week`/`YYYY-MM-DD`),
`--project/--folder/-f`, `--limit/-l`, `--json`.

## API

Refresh: `POST /v1/refresh-access-token {refresh_token}` → `access_token`. Then,
with `Authorization: Bearer <token>`:
`v2/get-documents` (list, optional `list_id` folder scope),
`v1/get-document-transcript`, `v1/get-document-panels`,
`v1/get-document-lists-metadata`. All requests/responses are JSON.

Search (`search-meetings-turbopuffer`) is intentionally not used — its body is
built server-side and rejects every client payload; local filtering over
`get-documents` is exact and richer.
