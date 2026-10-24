# Prompt log

Model/agent: Codex (GPT-5).

## Origin

The user asked for a cross-platform app that opens local CSV, Excel, document, and
presentation files in Google apps in a browser, preserving the Google file created on first
open. They identified remote-to-local synchronization as the difficult part, then clarified
that the product is primarily for reading and should use an explicit sync feature rather than
automatic synchronization.

## Design decisions

- Built a portable Python CLI rather than a platform-specific GUI. It opens the default browser
  and can be used as the target of a local OS file association.
- Imported Google Docs, Sheets, and Slides files are mapped by canonical local path to a Drive
  ID in per-user SQLite state. A second `open` reuses the Drive ID.
- Uses desktop OAuth and the narrow `drive.file` scope. Client credentials and tokens stay out
  of the repository.
- Sync is intentionally manual and remote-to-local only. The saved baseline is a local
  SHA-256 hash plus the Drive file's monotonic version. The tool exports only when the remote
  changed and the local file did not; local or two-sided changes never cause an overwrite.
- Sync exports to a temporary sibling file and atomically replaces the original only after a
  complete export.
- Supports only file formats that can be exported back to their original extension. CSV is
  documented as a first-sheet-only exception.

## Validation

- Added 11 `unittest` behavior tests for format support, SQLite mappings, all sync decisions,
  open-once behavior, remote export, and local-edit conflict protection.
- Ran `uv run --no-project python -m unittest open-in-google-workspace/test_open_in_google_workspace.py`.
- Ran `uv run open-in-google-workspace/open-in-google-workspace.py --help`.
