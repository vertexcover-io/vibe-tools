# open-in-google-workspace

Open a local CSV, spreadsheet, document, or presentation in its matching Google
Workspace editor. The first `open` imports a Google copy and records its Drive ID; later
opens always use that same copy.

This is intentionally read-first. Nothing syncs in the background. `sync` is an explicit,
one-way pull from Google Workspace to the original local file, and it refuses to overwrite
local edits.

## Setup

Install [uv](https://docs.astral.sh/uv/), enable the Google Drive API in a Google Cloud
project, and create an **OAuth client ID for a Desktop app**. Download its JSON and either
put it at the state-directory location below as `credentials.json`, or pass it with
`--credentials`.

```sh
uv run open-in-google-workspace/open-in-google-workspace.py \
  --credentials /path/to/client-secret.json open ~/Documents/budget.xlsx
```

The first command opens a browser to sign in and approve access, then opens the imported
file in Google Sheets, Docs, or Slides. OAuth tokens and the local SQLite mapping are saved
outside this repository:

- macOS: `~/Library/Application Support/open-in-google-workspace/`
- Windows: `%APPDATA%\open-in-google-workspace\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/open-in-google-workspace/`

## Commands

```sh
# Create/reuse the mapped Google Workspace copy and open it in the default browser.
uv run open-in-google-workspace/open-in-google-workspace.py open report.docx

# Show the saved Drive ID and the last synced Drive version (no network request).
uv run open-in-google-workspace/open-in-google-workspace.py status report.docx

# Explicitly download Google-side edits to the original local path.
uv run open-in-google-workspace/open-in-google-workspace.py sync report.docx
```

To use double-clicks, configure your operating system's file association to invoke the
`open` command above with the selected path as its final argument. Keep the script at a
stable absolute path when configuring the association.

## Sync contract

At import or successful sync the app saves a SHA-256 hash of the local file and the Drive
file's version. On `sync`:

- only Google changed: export and atomically replace the local file;
- neither changed: do nothing;
- only local changed: stop without writing;
- both changed: report a conflict without writing.

This release never uploads later local modifications. It also never silently creates a
replacement mapping if the mapped Drive file is missing or trashed.

## Supported formats and limits

Round-trip-safe formats are CSV, XLSX, ODS, DOCX, ODT, PPTX, and ODP. Older `.xls`, `.doc`,
and `.ppt` files are rejected because Google Workspace cannot export them back in the same
legacy format safely. CSV sync exports only the first Sheet. Google Drive's regular export
endpoint has a 10 MB limit, and Office-to-Google conversion can change unsupported features;
review a sync result before relying on it.
