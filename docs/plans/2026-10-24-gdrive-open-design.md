# gdrive-open — Design

## Problem Statement

Open supported local office files in their native Google Workspace editor, creating one
converted Drive file on first use and reopening that same file on later use. The local
file remains untouched while reading; pulling Google edits back is a deliberate command.

## Context

This repository contains small, standalone tools. No existing tool integrates with Google
Drive or establishes a shared test framework. The first release is deliberately a
cross-platform CLI, suitable for users to attach to OS file associations, rather than a
native GUI package.

## Requirements

### Functional Requirements

1. `open PATH` imports a supported file into Docs, Sheets, or Slides once, persists its
   Drive ID and opens its browser editor URL.
2. A later `open PATH` uses the recorded Drive ID and never creates a duplicate.
3. `sync PATH` explicitly exports a remotely edited Workspace file to the original local
   format only when the local source is unchanged since the last successful baseline.
4. If the local source changed, or the Drive item cannot safely be exported, `sync` stops
   without writing anything.
5. The tool reports an actionable error for missing OAuth credentials, unsupported formats,
   trashed Drive files, missing local files, and conflicts.

### Non-Functional Requirements

- Runs on macOS, Windows, and Linux with Python 3.11+ and `uv`.
- Stores only metadata in a per-user SQLite database; OAuth tokens use the native OS
  credential store. The October 2026 distribution update replaces the initial token file.
- Requests the narrow `drive.file` scope, limiting access to files created or opened by
  this app.
- Uses atomic replacement for successful remote-to-local syncs.

### Edge Cases and Boundary Conditions

- CSV export includes only the first Google Sheet, so it is supported but documented as
  potentially lossy after multi-sheet edits.
- Drive exports are limited to 10 MB; failures leave the original intact.
- Files moved locally no longer match their stored absolute path; `open` imports them as a
  new file in the first release.
- A missing or trashed remote mapping is an error, never an implicit re-import.

## Key Insights

- Google conversion is an import/export translation, not a byte-preserving shared file.
- Google Drive's monotonic `version` together with a local SHA-256 baseline is sufficient
  for a manual read-first sync; polling or change notifications add no value.
- A local change cannot be merged structurally with a Google Workspace export, so safety
  requires refusing to overwrite it.

## Architectural Challenges

- The app must remember identity without making Drive metadata the source of truth.
- Sync needs a reliable baseline across program runs and must survive interrupted writes.
- OAuth configuration must be approachable without embedding client secrets.

## Approaches Considered

### Approach A: Native desktop app with background synchronization

Would deliver double-click integration, but requires platform packaging and a conflict
engine. It risks unexpected writes and is disproportionate to the read-first use case.

### Approach B: Browser launcher with manual pull sync

A Python CLI imports and maps once, opens the editor URL through the operating system, and
exports only on an explicit command. It is cross-platform, safe, and allows OS association
setup separately.

### Approach C: Store unconverted Office files in Drive

This preserves the original bytes but opens Google Drive's Office compatibility editor, not
the native Google Docs/Sheets/Slides editors requested here.

## Chosen Approach

Approach B. It accepts a one-time setup step and no automatic uploading in exchange for
predictable, non-destructive operation.

## High-Level Design

`open` validates the extension, hashes the local file, reads an account/client/path-keyed mapping from
SQLite, and either opens its `webViewLink` or uploads the file while declaring the target
Google Workspace MIME type. It records the Drive ID, target type, original export MIME
type, local SHA-256 baseline, and Drive version.

`sync` reads the mapping, retrieves current Drive metadata, rehashes the source, and compares
it to the saved baseline. A changed local hash is a conflict. An unchanged hash permits a
Google export into a sibling temporary file followed by atomic replacement. The mapping gets
the exported file hash and new Drive version only after replacement succeeds.

## Open Questions

- Packaging native installers and registering double-click associations are deferred; the
  README will include platform-specific association guidance.
- Local rename/move detection is deferred to avoid heuristic identity collisions.

## Risks and Mitigations

- Conversion loss: document known CSV and Office round-trip limitations; never auto-sync.
- OAuth setup friction: validate a named `credentials.json` path and provide exact console
  setup steps.
- Concurrent local edits during export: re-check the local hash immediately before atomic
  replacement.

## Assumptions

- The user owns or can edit the created Drive files.
- The publisher configures a Google Cloud OAuth desktop client and Drive API access once,
  then distributes its client JSON. Users authorize their own Google accounts in the browser.
- Manual sync is intentionally remote-to-local only for this release.
