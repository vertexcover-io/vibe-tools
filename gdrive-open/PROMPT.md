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

## Iteration: built-in login for distribution

Model/agent: Codex (GPT-6 Astra).

User asked: "Can i add oauth login support to the app itself so that anyone can login using
their own account to use the app", then "Update" after discussing bundled Desktop client
configuration, login/logout/reconnect, secure storage, PKCE, and account-specific mappings.

- Added `login`, `reconnect`, `logout`, and offline `whoami`; opening a file also starts
  authorization when there is no saved login.
- Loads a distributable `oauth-client.json` beside the script, with existing per-user and
  explicit developer configuration overrides. A real publisher client was not supplied
  during implementation; this checkout does not contain invented credentials.
- Uses PKCE, account selection, offline access, and a three-minute loopback callback timeout.
- Stores each active login in a native OS credential store with no plaintext fallback.
- Keys file mappings by Google's stable Drive permission ID and OAuth client ID. Switching
  accounts cannot reuse another account's file mappings.
- Migrates old mappings only using the verified original token's account; removes the old
  plaintext token only after credentials and mappings are persisted. Expired legacy tokens
  leave old mappings protected while allowing a new explicit login.
- Regression tests cover account isolation, secure-store failures, token refresh, cancelled
  and revoked login, CLI commands, consent parameters, and legacy migration/retry.
- Validation: 39 unit tests passed with Google and credential-store boundaries mocked;
  Ruff and `git diff --check` passed, and the script's `--help` exposes the new commands.
- No live Google consent, real keychain operation, or Windows/Linux end-to-end run was
  performed. These remain release checks once the publisher supplies its Desktop client.

## Iteration: rename to gdrive-open

Model/agent: Codex (GPT-6 Astra).

User asked: "rename app to gdrive-open".

- Renamed the tool folder, main script, tests, CLI help, and current documentation.
- Fresh installs use the `gdrive-open` state folder. Existing installations keep the original
  state directory and credential-store identity so saved logins and Drive mappings survive.
- Historical prompt entries above retain their original command names.
- Google Cloud consent-screen branding is managed separately in the Cloud Console.
- Validation: all 42 tests passed, including state-directory and keyring compatibility;
  Ruff, CLI `--help`, and whitespace checks passed.
