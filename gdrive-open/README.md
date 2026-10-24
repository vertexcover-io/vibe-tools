# gdrive-open

Open a local CSV, spreadsheet, document, or presentation in its matching Google
Workspace editor. The first `open` imports a Google copy and records its Drive ID; later
opens always use that same copy.

This is intentionally read-first. Nothing syncs in the background. `sync` is an explicit,
one-way pull from Google Workspace to the original local file, and it refuses to overwrite
local edits.

## Standalone executable

Extract the zip for your OS/architecture, then run the executable from a terminal:

```sh
./gdrive-open login
./gdrive-open open ~/Documents/budget.xlsx
./gdrive-open sync ~/Documents/budget.xlsx
```

On Windows use `.\gdrive-open.exe`. Python and `uv` are not needed for the executable.
The commands and state directory are shared with the source version, so existing logins
and mapped Drive IDs continue to work. A build with a bundled Desktop OAuth client only
needs the user's Google sign-in; a build without one needs `--credentials PATH`.

Interactive terminals show a small animated loader during sign-in, uploads/conversion,
file lookup, browser launch, and downloads. It clears on success, failure, or cancellation.
Redirected output contains no spinner/animation. The loader ends when the browser is
launched; it cannot measure Google's page-loading progress. This is a CLI executable,
not a native windowed installer.

## Connect Google Drive

To run from source, install [uv](https://docs.astral.sh/uv/), then run from this tool's folder:

```sh
uv run gdrive-open.py login
uv run gdrive-open.py open ~/Documents/budget.xlsx
```

Choose your Google account in the browser and approve Drive access. Files are created in
your own Drive. This source checkout includes the app's Desktop OAuth configuration, so
users do not need a Google Cloud project or a separate credentials file.

Login tokens are stored in macOS Keychain, Windows Credential Locker, or Linux Secret
Service. Linux needs an unlocked Secret Service keyring (for example GNOME Keyring).
There is no plaintext fallback when the credential store is unavailable.

SQLite file mappings are kept in:

- macOS: `~/Library/Application Support/gdrive-open/`
- Windows: `%APPDATA%\gdrive-open\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gdrive-open/`

Existing installations continue using the original `open-in-google-workspace` state folder
when it exists, including its `credentials.json` and mappings. The internal keyring service
name is also retained, so saved logins still work (including custom `--state-dir` paths).
Keep using that folder if you already configured credentials there; no migration is needed.

## Commands

```sh
# Create/reuse the mapped Google Workspace copy and open it in the default browser.
uv run gdrive-open.py open report.docx

# Show the saved Drive ID and the last synced Drive version (no network request).
uv run gdrive-open.py status report.docx

# Explicitly download Google-side edits to the original local path.
uv run gdrive-open.py sync report.docx

# Show the saved account; choose a different account; reconnect an expired login.
uv run gdrive-open.py whoami
uv run gdrive-open.py login
uv run gdrive-open.py reconnect

# Forget this client's login on this device, keeping files and mappings.
uv run gdrive-open.py logout
```

`open` and `sync` prompt for login if needed. `whoami` and `status` work offline using the
saved account. Each Google account and OAuth client has separate mappings; returning to the
same account restores its original file associations. One account is active per client and
state directory. `logout` removes the local login; revoke the app in your Google Account's
connections settings if you also want to remove Google's authorization grant.

To use double-clicks, configure your operating system's file association to invoke the
`open` command above with the selected path as its final argument. Keep the script at a
stable absolute path when configuring the association.

## Publisher setup (once per app)

The included configuration is ready for builds. These steps are for publishers using
their own Google Cloud project:

1. Enable Google Drive API in your Google Cloud project.
2. Configure Google Auth Platform branding, an **External** audience, and only the
   `https://www.googleapis.com/auth/drive.file` scope.
3. Create a **Desktop app** OAuth client. Bundle its downloaded JSON next to the script as
   `oauth-client.json`. It must contain Google's `installed` configuration, not `web`.
4. For testing, add users under Audience → Test users. For general distribution, move the
   app to Production and complete Google's applicable branding/verification requirements.

Desktop clients are public clients; the bundled client identifies the app and is not a user's
login token. Never distribute `token.json` or a credential-store export. Authorization uses
PKCE, Google's browser consent screen, and a temporary loopback callback on `127.0.0.1`.
There is no backend server to deploy. See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).

Developers may override the bundle without editing it:

```sh
uv run gdrive-open.py --credentials /path/to/desktop-client.json login
```

Configuration precedence: `--credentials`, existing state-directory `credentials.json`,
then bundled `oauth-client.json`. Continue supplying the override on subsequent commands if
you use one. External apps in Testing have seven-day refresh tokens; `reconnect` signs in
again after expiration. `--state-dir PATH` isolates mappings and the associated keyring entry.

Upgrading from the previous release: when the original `token.json` still authenticates,
the app verifies its Drive account, migrates its mappings, saves the login in the credential
store, then removes that plaintext token. If it cannot verify the old login, it preserves the
old state and blocks imports for unclaimed legacy paths. `login` still lets you connect and
use new paths. It never assigns old mappings to whichever account signs in next.

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

Supported formats are CSV, XLSX, ODS, DOCX, ODT, PPTX, and ODP. Older `.xls`, `.doc`,
and `.ppt` files are rejected because Google Workspace cannot export them back in the same
legacy format safely. CSV sync exports only the first Sheet. Google Drive's regular export
endpoint has a 10 MB limit, and Office-to-Google conversion can change unsupported features;
review a sync result before relying on it.

## Install a binary

Install `uv`, then run from this folder:

```sh
./install.sh
```

This builds for the current OS/CPU and installs `gdrive-open` into `~/.local/bin`
(`gdrive-open.exe` on Windows). Use `--bin-dir /path/to/bin` to choose another directory.
The app's Desktop OAuth configuration is included in `oauth-client.json` and bundled
automatically. After installing, run `gdrive-open login` to sign in with your own account.
No sudo is needed for the default location. If that directory is missing from PATH,
the script prints an export command; add it to your shell startup file for future sessions.
Use Bash on macOS/Linux or Git Bash with native Windows `uv`; WSL installs a Linux binary.

Rerun to upgrade. The existing executable is replaced only after a successful build and
copy. Close a running Windows executable before upgrading. To uninstall, remove the
installed executable; account credentials and file mappings are kept separately.
Developers using their own Google Cloud project can override the bundled app configuration
with `--client-config /path/to/desktop-client.json`. Personal login tokens are never bundled.

## Build a binary

Install `uv`, then run from this folder:

```sh
./build-binary.sh
```

The shell command works from any working directory, forwards all arguments to the Python
builder, and builds for the current OS and CPU architecture. Use macOS/Linux Bash, or Git
Bash with Windows `uv` for a Windows binary. WSL produces a Linux binary. In PowerShell,
run `uv run build-binary.py` directly.

This creates `dist/<os>-<architecture>/gdrive-open` (or `gdrive-open.exe`), a distribution
zip containing the executable and README, and `SHA256SUMS` for the executable. The Python
runtime, libraries, Drive discovery document, and validated Desktop client settings are
embedded. Login tokens, mappings, and other local state are never bundled.

If `--client-config` is omitted, a sibling `oauth-client.json` is used when present;
otherwise the binary is built without a bundled client. Only Google's Desktop (`installed`)
configuration is accepted. User token files and web-client configurations are rejected.

Build on each target OS/architecture: PyInstaller does not cross-compile. The local build
has been tested on macOS Apple Silicon; Windows and Linux builds still need testing on
those hosts. Linux users need a working Secret Service credential store. macOS builds
are locally signed by PyInstaller, but are not Developer ID signed or notarized for public
distribution. The shell installer does not register automatic file associations.
Generated binaries, archives, and checksums stay in the ignored `dist/` directory; Git
tracks the build scripts and source.

## Tests

```sh
uv run --with google-api-python-client --with google-auth-oauthlib --with keyring --with rich \
  python -m unittest discover -s . -p 'test_*.py'
bash test_install.sh
```

Tests use temporary databases and fake Google/credential-store adapters; they do not sign
in, touch your keychain, or upload files. Live consent and native credential stores still
need smoke testing on each target OS with a real Desktop client.
