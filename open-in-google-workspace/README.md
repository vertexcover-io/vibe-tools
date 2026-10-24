# open-in-google-workspace

Open a local CSV, spreadsheet, document, or presentation in its matching Google
Workspace editor. The first `open` imports a Google copy and records its Drive ID; later
opens always use that same copy.

This is intentionally read-first. Nothing syncs in the background. `sync` is an explicit,
one-way pull from Google Workspace to the original local file, and it refuses to overwrite
local edits.

## Connect Google Drive

Install [uv](https://docs.astral.sh/uv/), then run from this tool's folder:

```sh
uv run open-in-google-workspace.py login
uv run open-in-google-workspace.py open ~/Documents/budget.xlsx
```

Choose your Google account in the browser and approve Drive access. Files are created in
your own Drive. A configured distribution includes the app's Desktop OAuth client, so end
users do not need a Google Cloud project. **This source checkout still needs the publisher's
client JSON before live login will work**; see Publisher setup below.

Login tokens are stored in macOS Keychain, Windows Credential Locker, or Linux Secret
Service. Linux needs an unlocked Secret Service keyring (for example GNOME Keyring).
There is no plaintext fallback when the credential store is unavailable.

SQLite file mappings are kept in:

- macOS: `~/Library/Application Support/open-in-google-workspace/`
- Windows: `%APPDATA%\open-in-google-workspace\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/open-in-google-workspace/`

## Commands

```sh
# Create/reuse the mapped Google Workspace copy and open it in the default browser.
uv run open-in-google-workspace.py open report.docx

# Show the saved Drive ID and the last synced Drive version (no network request).
uv run open-in-google-workspace.py status report.docx

# Explicitly download Google-side edits to the original local path.
uv run open-in-google-workspace.py sync report.docx

# Show the saved account; choose a different account; reconnect an expired login.
uv run open-in-google-workspace.py whoami
uv run open-in-google-workspace.py login
uv run open-in-google-workspace.py reconnect

# Forget this client's login on this device, keeping files and mappings.
uv run open-in-google-workspace.py logout
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
uv run open-in-google-workspace.py --credentials /path/to/desktop-client.json login
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

## Tests

```sh
uv run --with google-api-python-client --with google-auth-oauthlib --with keyring \
  python -m unittest discover -s . -p 'test_*.py'
```

Tests use temporary databases and fake Google/credential-store adapters; they do not sign
in, touch your keychain, or upload files. Live consent and native credential stores still
need smoke testing on each target OS with a real Desktop client.
