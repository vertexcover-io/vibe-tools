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

## Iteration: loading indicator and standalone binary

Model/agent: Codex (GPT-6 Astra).

User asked: "While its opening can we show a small loader or progress bar or something",
then "Package into a binary" while that work was underway.

- Added a transient Rich spinner for login, upload/conversion, remote lookup, browser
  launch, and export. It is disabled for redirected output, and context managers stop it
  on errors/cancellation. It does not claim to measure the browser's page-load progress.
- Added `build-binary.py`, a self-contained uv/PyInstaller build command. Each build targets
  the host OS/architecture and creates a single executable, zip, and SHA-256 checksum.
- Bundles a validated Desktop OAuth client when supplied. The staging step reconstructs
  only the required public client fields and never copies user tokens or SQLite state.
- Preserves the runtime credential-store identity and existing state paths. Uses the
  existing bundled-resource lookup to find the embedded client in a frozen executable.
- The local artifact targets macOS ARM64. It is not a GUI installer, Developer ID signed,
  or notarized. Windows/Linux builds require their own build hosts and verification.
- Validation: 46 tests, Ruff, and whitespace checks passed. The native executable's help
  and invalid-config path were smoke-tested, its ad-hoc signature verified, and its archive
  checked for the required dependencies/client data and absence of token/database files.
  Live browser consent and a real Drive upload were not part of this packaging check.

## Iteration: shell build entry point

Model/agent: Codex (GPT-6 Astra).

User asked: "Create a shell script to create a binary for the platform and commit everything".

- Added executable `build-binary.sh`, which checks for uv, locates the Python builder
  relative to itself, and forwards arguments without depending on the working directory.
- Reuses the existing host-platform/architecture detection and packaging pipeline.
- Documented macOS/Linux, Git Bash on Windows, and direct PowerShell usage. Build artifacts
  remain ignored; all tool source/documentation changes are committed on the feature branch.
- Validated Bash syntax and built the macOS ARM64 executable from outside the repository
  with a client-config path containing spaces; the packaged executable passed its help check.

## Iteration: native binary installation

Model/agent: Codex (GPT-6).

User asked: "Commit to vibe-tools and push , cleanup worktree", then
"Create a install.sh shell script that will build the correct binary for the platform and then install it".

- Added `install.sh` with a default user installation in `~/.local/bin`, configurable
  `--bin-dir`, and optional `--client-config`. It uses the existing native build pipeline.
- The builder writes its exact executable path for the installer, avoiding duplicate
  platform detection. Installation stages the executable before replacing an older copy.
- Added checks for paths with spaces, failure preservation, invalid options, and the
  Windows executable name. Documented PATH setup, upgrades, and removal.
- Validation: 47 Python tests and installer shell checks passed. A real macOS ARM64
  build installed successfully into a temporary path containing spaces and ran `--help`.
  Windows/Linux execution still requires testing on those operating systems.
