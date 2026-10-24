#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-api-python-client>=2,<3", "google-auth-oauthlib>=1.2,<2", "keyring>=25,<26"]
# ///
"""Open local office files in Google Workspace and explicitly pull remote edits."""
from __future__ import annotations

import argparse
from contextlib import closing
from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from typing import Protocol
import webbrowser


@dataclass(frozen=True)
class FileFormat:
    source_mime_type: str
    workspace_mime_type: str
    export_mime_type: str


@dataclass(frozen=True)
class Mapping:
    source_path: Path
    drive_id: str
    workspace_mime_type: str
    export_mime_type: str
    baseline_hash: str
    drive_version: str


@dataclass(frozen=True)
class RemoteFile:
    drive_id: str
    version: str
    web_view_link: str
    trashed: bool


@dataclass(frozen=True)
class OpenResult:
    created: bool
    remote_file: RemoteFile


@dataclass(frozen=True)
class SyncResult:
    decision: SyncDecision


class DriveGateway(Protocol):
    def import_file(self, source_path: Path, file_format: FileFormat) -> RemoteFile: ...

    def get_file(self, drive_id: str) -> RemoteFile: ...

    def export_file(self, drive_id: str, export_mime_type: str) -> bytes: ...


class Browser(Protocol):
    def open(self, url: str) -> None: ...


class SystemBrowser:
    """Open editor links with the operating system's default browser."""

    def open(self, url: str) -> None:
        if not webbrowser.open(url, new=2):
            raise ValueError(f"Could not open a browser for {url}")


class GoogleDriveGateway:
    """Small adapter around the dynamic Google Drive Python client."""

    def __init__(self, service: object) -> None:
        self.service = service

    def _files_resource(self) -> object:
        files_factory = getattr(self.service, "files", None)
        if not callable(files_factory):
            raise ValueError("Google Drive client is missing its files resource")
        return files_factory()

    def _execute(self, request: object) -> object:
        execute = getattr(request, "execute", None)
        if not callable(execute):
            raise ValueError("Google Drive client returned an invalid request")
        return execute()

    def import_file(self, source_path: Path, file_format: FileFormat) -> RemoteFile:
        from googleapiclient.http import MediaFileUpload

        files_resource = self._files_resource()
        create = getattr(files_resource, "create", None)
        if not callable(create):
            raise ValueError("Google Drive client cannot create files")
        media = MediaFileUpload(str(source_path), mimetype=file_format.source_mime_type, resumable=True)
        request = create(
            body={"name": source_path.name, "mimeType": file_format.workspace_mime_type},
            media_body=media,
            fields="id,version,webViewLink,trashed",
        )
        return parse_remote_file(self._execute(request))

    def get_file(self, drive_id: str) -> RemoteFile:
        files_resource = self._files_resource()
        get = getattr(files_resource, "get", None)
        if not callable(get):
            raise ValueError("Google Drive client cannot retrieve files")
        request = get(fileId=drive_id, fields="id,version,webViewLink,trashed")
        return parse_remote_file(self._execute(request))

    def export_file(self, drive_id: str, export_mime_type: str) -> bytes:
        files_resource = self._files_resource()
        export = getattr(files_resource, "export", None)
        if not callable(export):
            raise ValueError("Google Drive client cannot export files")
        content = self._execute(export(fileId=drive_id, mimeType=export_mime_type))
        if not isinstance(content, bytes):
            raise ValueError("Google Drive returned a non-binary export")
        return content


class SyncDecision(str, Enum):
    UP_TO_DATE = "up_to_date"
    DOWNLOAD_REMOTE = "download_remote"
    LOCAL_CHANGED = "local_changed"
    CONFLICT = "conflict"


def decide_sync(
    *,
    baseline_hash: str,
    current_hash: str,
    saved_drive_version: str,
    remote_drive_version: str,
) -> SyncDecision:
    """Classify a manual sync without making a destructive choice."""
    local_changed = current_hash != baseline_hash
    remote_changed = remote_drive_version != saved_drive_version
    if local_changed and remote_changed:
        return SyncDecision.CONFLICT
    if local_changed:
        return SyncDecision.LOCAL_CHANGED
    if remote_changed:
        return SyncDecision.DOWNLOAD_REMOTE
    return SyncDecision.UP_TO_DATE


def sha256_file(source_path: Path) -> str:
    """Return a content hash without relying on filesystem timestamps."""
    digest = hashlib.sha256()
    with source_path.open("rb") as source_file:
        while chunk := source_file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def open_local_file(
    source_path: Path,
    store: SqliteMappingStore,
    drive: DriveGateway,
    browser: Browser,
) -> OpenResult:
    """Open the mapped Workspace file, importing once when no mapping exists."""
    normalized_path = source_path.resolve()
    existing_mapping = store.get(normalized_path)
    if existing_mapping is not None:
        remote_file = drive.get_file(existing_mapping.drive_id)
        if remote_file.trashed:
            raise ValueError("Mapped Google Workspace file is trashed; restore it in Drive first")
        browser.open(remote_file.web_view_link)
        return OpenResult(created=False, remote_file=remote_file)

    file_format = format_for_path(normalized_path)
    remote_file = drive.import_file(normalized_path, file_format)
    if remote_file.trashed:
        raise ValueError("Google Drive returned a trashed file after import")
    store.upsert(
        Mapping(
            source_path=normalized_path,
            drive_id=remote_file.drive_id,
            workspace_mime_type=file_format.workspace_mime_type,
            export_mime_type=file_format.export_mime_type,
            baseline_hash=sha256_file(normalized_path),
            drive_version=remote_file.version,
        )
    )
    browser.open(remote_file.web_view_link)
    return OpenResult(created=True, remote_file=remote_file)


def sync_remote_file(
    source_path: Path,
    store: SqliteMappingStore,
    drive: DriveGateway,
) -> SyncResult:
    """Explicitly export a remote edit only if the local baseline is unchanged."""
    normalized_path = source_path.resolve()
    mapping = store.get(normalized_path)
    if mapping is None:
        raise ValueError("No mapped Google Workspace file; run open first")
    remote_file = drive.get_file(mapping.drive_id)
    if remote_file.trashed:
        raise ValueError("Mapped Google Workspace file is trashed; restore it in Drive first")
    current_hash = sha256_file(normalized_path)
    decision = decide_sync(
        baseline_hash=mapping.baseline_hash,
        current_hash=current_hash,
        saved_drive_version=mapping.drive_version,
        remote_drive_version=remote_file.version,
    )
    if decision is not SyncDecision.DOWNLOAD_REMOTE:
        return SyncResult(decision=decision)
    exported_content = drive.export_file(mapping.drive_id, mapping.export_mime_type)
    if sha256_file(normalized_path) != current_hash:
        return SyncResult(decision=SyncDecision.CONFLICT)
    replace_file_atomically(normalized_path, exported_content)
    store.upsert(
        Mapping(
            source_path=normalized_path,
            drive_id=mapping.drive_id,
            workspace_mime_type=mapping.workspace_mime_type,
            export_mime_type=mapping.export_mime_type,
            baseline_hash=sha256_file(normalized_path),
            drive_version=remote_file.version,
        )
    )
    return SyncResult(decision=SyncDecision.DOWNLOAD_REMOTE)


def replace_file_atomically(destination: Path, content: bytes) -> None:
    """Replace a local file only after its complete export is safely staged."""
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary_file:
        temporary_file.write(content)
        temporary_path = Path(temporary_file.name)
    try:
        os.replace(temporary_path, destination)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


class SqliteMappingStore:
    """Persist local-file to Drive-file identities in a user-owned SQLite database."""

    def __init__(self, database_path: Path, *, account_key: str = "") -> None:
        self.database_path = database_path
        self.account_key = account_key
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS mappings (
                    source_path TEXT PRIMARY KEY,
                    drive_id TEXT NOT NULL,
                    workspace_mime_type TEXT NOT NULL,
                    export_mime_type TEXT NOT NULL,
                    baseline_hash TEXT NOT NULL,
                    drive_version TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS account_mappings ("
                "account_key TEXT NOT NULL, source_path TEXT NOT NULL, drive_id TEXT NOT NULL, "
                "workspace_mime_type TEXT NOT NULL, export_mime_type TEXT NOT NULL, "
                "baseline_hash TEXT NOT NULL, drive_version TEXT NOT NULL, "
                "PRIMARY KEY(account_key, source_path))"
            )
            connection.execute("CREATE TABLE IF NOT EXISTS legacy_owner (account_key TEXT PRIMARY KEY)")

    def migrate_legacy(self) -> None:
        """Bind old mappings only after authenticating the original token's owner."""
        if not self.account_key:
            raise ValueError("An account is required to migrate legacy mappings")
        with closing(self._connect()) as connection, connection:
            owner = connection.execute("SELECT account_key FROM legacy_owner").fetchone()
            if owner is not None and owner[0] != self.account_key:
                raise ValueError("The legacy mappings belong to a different account")
            connection.execute(
                "INSERT OR IGNORE INTO account_mappings SELECT ?, source_path, drive_id, "
                "workspace_mime_type, export_mime_type, baseline_hash, drive_version FROM mappings",
                (self.account_key,),
            )
            connection.execute("INSERT OR IGNORE INTO legacy_owner VALUES (?)", (self.account_key,))

    def get(self, source_path: Path) -> Mapping | None:
        source_key = str(source_path.resolve())
        with closing(self._connect()) as connection:
            if self.account_key:
                row = connection.execute(
                    "SELECT * FROM account_mappings WHERE account_key = ? AND source_path = ?",
                    (self.account_key, source_key),
                ).fetchone()
                legacy = connection.execute("SELECT 1 FROM mappings WHERE source_path = ?", (source_key,)).fetchone()
                owner = connection.execute("SELECT 1 FROM legacy_owner").fetchone()
                if row is None and legacy and not owner:
                    raise ValueError("Unclaimed legacy mapping: restore the original token.json and OAuth client to migrate it safely")
            else:
                row = connection.execute("SELECT * FROM mappings WHERE source_path = ?", (source_key,)).fetchone()
        if row is None:
            return None
        return Mapping(
            source_path=Path(str(row["source_path"])),
            drive_id=str(row["drive_id"]),
            workspace_mime_type=str(row["workspace_mime_type"]),
            export_mime_type=str(row["export_mime_type"]),
            baseline_hash=str(row["baseline_hash"]),
            drive_version=str(row["drive_version"]),
        )

    def upsert(self, mapping: Mapping) -> None:
        source_key = str(mapping.source_path.resolve())
        if self.account_key:
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    "INSERT INTO account_mappings VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(account_key, source_path) DO UPDATE SET "
                    "drive_id=excluded.drive_id, workspace_mime_type=excluded.workspace_mime_type, "
                    "export_mime_type=excluded.export_mime_type, baseline_hash=excluded.baseline_hash, "
                    "drive_version=excluded.drive_version",
                    (self.account_key, source_key, mapping.drive_id, mapping.workspace_mime_type,
                     mapping.export_mime_type, mapping.baseline_hash, mapping.drive_version),
                )
            return
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO mappings (
                    source_path, drive_id, workspace_mime_type, export_mime_type,
                    baseline_hash, drive_version
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_path) DO UPDATE SET
                    drive_id = excluded.drive_id,
                    workspace_mime_type = excluded.workspace_mime_type,
                    export_mime_type = excluded.export_mime_type,
                    baseline_hash = excluded.baseline_hash,
                    drive_version = excluded.drive_version
                """,
                (
                    source_key,
                    mapping.drive_id,
                    mapping.workspace_mime_type,
                    mapping.export_mime_type,
                    mapping.baseline_hash,
                    mapping.drive_version,
                ),
            )


SUPPORTED_FORMATS = {
    ".csv": FileFormat(
        source_mime_type="text/csv",
        workspace_mime_type="application/vnd.google-apps.spreadsheet",
        export_mime_type="text/csv",
    ),
    ".xlsx": FileFormat(
        source_mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workspace_mime_type="application/vnd.google-apps.spreadsheet",
        export_mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    ".ods": FileFormat(
        source_mime_type="application/vnd.oasis.opendocument.spreadsheet",
        workspace_mime_type="application/vnd.google-apps.spreadsheet",
        export_mime_type="application/vnd.oasis.opendocument.spreadsheet",
    ),
    ".docx": FileFormat(
        source_mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        workspace_mime_type="application/vnd.google-apps.document",
        export_mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    ".odt": FileFormat(
        source_mime_type="application/vnd.oasis.opendocument.text",
        workspace_mime_type="application/vnd.google-apps.document",
        export_mime_type="application/vnd.oasis.opendocument.text",
    ),
    ".pptx": FileFormat(
        source_mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        workspace_mime_type="application/vnd.google-apps.presentation",
        export_mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    ".odp": FileFormat(
        source_mime_type="application/vnd.oasis.opendocument.presentation",
        workspace_mime_type="application/vnd.google-apps.presentation",
        export_mime_type="application/vnd.oasis.opendocument.presentation",
    ),
}


DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"


def format_for_path(path: Path) -> FileFormat:
    """Return the Google conversion format for a file path."""
    file_format = SUPPORTED_FORMATS.get(path.suffix.lower())
    if file_format is None:
        raise ValueError(f"Unsupported file type: {path.suffix or '(no extension)'}")
    return file_format


def parse_remote_file(response: object) -> RemoteFile:
    """Validate the metadata fields required for a safe mapping."""
    if not isinstance(response, dict):
        raise ValueError("Google Drive returned invalid file metadata")
    drive_id = response.get("id")
    version = response.get("version")
    web_view_link = response.get("webViewLink")
    trashed = response.get("trashed", False)
    if not isinstance(drive_id, str) or not drive_id:
        raise ValueError("Google Drive response did not include a file ID")
    if not isinstance(version, str) or not version:
        raise ValueError("Google Drive response did not include a file version")
    if not isinstance(web_view_link, str) or not web_view_link:
        raise ValueError("Google Drive response did not include an editor URL")
    if not isinstance(trashed, bool):
        raise ValueError("Google Drive response included an invalid trashed flag")
    return RemoteFile(drive_id=drive_id, version=version, web_view_link=web_view_link, trashed=trashed)


def default_state_dir() -> Path:
    """Choose a conventional per-user state directory on each supported platform."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "open-in-google-workspace"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        return Path(app_data) / "open-in-google-workspace" if app_data else Path.home() / "AppData" / "Roaming" / "open-in-google-workspace"
    config_home = os.environ.get("XDG_CONFIG_HOME")
    return Path(config_home or Path.home() / ".config") / "open-in-google-workspace"


AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
BUNDLED_CLIENT = Path(__file__).with_name("oauth-client.json")


class LoginRequired(ValueError):
    """The user must explicitly reconnect their Google account."""


@dataclass(frozen=True)
class OAuthClient:
    client_id: str
    client_secret: str = field(repr=False)

    def google_config(self) -> dict[str, object]:
        return {"installed": {
            "client_id": self.client_id, "client_secret": self.client_secret,
            "auth_uri": AUTH_URI, "token_uri": TOKEN_URI,
            "redirect_uris": ["http://localhost"],
        }}


@dataclass(frozen=True)
class Account:
    permission_id: str
    email: str

    def key(self, client: OAuthClient) -> str:
        return hashlib.sha256(json.dumps([client.client_id, self.permission_id]).encode()).hexdigest()


@dataclass(frozen=True)
class LoginSession:
    account: Account
    credentials_json: str = field(repr=False)
    drive: DriveGateway = field(repr=False)


class TokenVault(Protocol):
    def read(self) -> str | None: ...
    def write(self, value: str) -> None: ...
    def clear(self) -> None: ...


class LoginProvider(Protocol):
    def login(self, client: OAuthClient) -> LoginSession: ...
    def resume(self, client: OAuthClient, credentials_json: str) -> LoginSession: ...


def json_object(raw: str) -> dict[str, object]:
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError("Invalid JSON configuration or saved login") from None
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return {str(key): item for key, item in value.items()}


def required_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing or invalid {name}")
    return value


def load_oauth_client(
    override: Path | None, state_dir: Path, bundled_path: Path = BUNDLED_CLIENT,
) -> OAuthClient:
    """One distributable Desktop client identifies the app for all its users."""
    candidates = (state_dir / "credentials.json", bundled_path)
    selected = override.expanduser() if override else next((p for p in candidates if p.is_file()), None)
    if selected is None:
        raise ValueError(
            "This build has no OAuth client configured. The publisher must bundle oauth-client.json "
            "beside the script. Developers can use --credentials /path/to/desktop-client.json."
        )
    installed = json_object(selected.read_text(encoding="utf-8")).get("installed")
    if not isinstance(installed, dict):
        raise ValueError("OAuth configuration must be for a Desktop app (installed), not a web client")
    client_id = required_string(installed.get("client_id"), "OAuth client ID")
    secret = required_string(installed.get("client_secret"), "Desktop client secret")
    if not client_id.endswith(".apps.googleusercontent.com"):
        raise ValueError("Expected a Google OAuth client ID")
    if installed.get("auth_uri", AUTH_URI) not in {AUTH_URI, "https://accounts.google.com/o/oauth2/v2/auth"}:
        raise ValueError("OAuth authorization endpoint must be Google")
    if installed.get("token_uri", TOKEN_URI) != TOKEN_URI:
        raise ValueError("OAuth token endpoint must be Google")
    return OAuthClient(client_id, secret)


class SystemTokenVault:
    """Use an OS credential store explicitly; never fall back to plaintext backends."""

    def __init__(self, client: OAuthClient, state_dir: Path) -> None:
        self.username = hashlib.sha256(json.dumps([client.client_id, str(state_dir.resolve())]).encode()).hexdigest()
        self.service = "open-in-google-workspace"
        self.backend = self._native_backend()

    @staticmethod
    def _native_backend() -> object:
        try:
            if sys.platform == "darwin":
                from keyring.backends.macOS import Keyring
                return Keyring()
            if sys.platform == "win32":
                from keyring.backends.Windows import WinVaultKeyring
                return WinVaultKeyring()
            from keyring.backends.SecretService import Keyring as SecretServiceKeyring
            return SecretServiceKeyring()
        except (ImportError, RuntimeError):
            raise ValueError("OS credential store unavailable. On Linux, install and unlock a Secret Service keyring.") from None

    def _call(self, method: str, *arguments: str) -> object:
        operation = getattr(self.backend, method)
        try:
            return operation(self.service, self.username, *arguments)
        except Exception:
            # Backends expose different OS exceptions; never print their secret-bearing arguments.
            raise ValueError("Cannot access the OS credential store. Unlock it and try again; no plaintext fallback is used.") from None

    def read(self) -> str | None:
        value = self._call("get_password")
        if value is not None and not isinstance(value, str):
            raise ValueError("Invalid credential-store response")
        return value

    def write(self, value: str) -> None:
        self._call("set_password", value)

    def clear(self) -> None:
        if self.read() is not None:
            self._call("delete_password")


def saved_login(session: LoginSession) -> str:
    return json.dumps({"account_id": session.account.permission_id, "email": session.account.email,
                       "credentials": session.credentials_json})


def account_from_saved(value: str) -> Account:
    record = json_object(value)
    return Account(required_string(record.get("account_id"), "account ID"),
                   required_string(record.get("email"), "account email"))


def connect_account(
    *, client: OAuthClient, state_dir: Path, vault: TokenVault,
    provider: LoginProvider, force_login: bool = False,
) -> LoginSession:
    saved = vault.read()  # Detect a missing/locked keyring before asking for browser consent.
    legacy_token = state_dir / "token.json"
    if legacy_token.is_file():
        try:
            legacy = provider.resume(client, legacy_token.read_text(encoding="utf-8"))
        except LoginRequired:
            if not saved and not force_login:
                raise LoginRequired("Legacy login cannot be restored. Run login; old mappings will remain protected.") from None
            print("Legacy login could not be verified; token.json and unclaimed mappings were preserved.", file=sys.stderr)
        else:
            vault.write(saved_login(legacy) if saved is None else saved)
            SqliteMappingStore(state_dir / "mappings.sqlite3", account_key=legacy.account.key(client)).migrate_legacy()
            legacy_token.unlink()
            print("Migrated the legacy login to the OS credential store and removed token.json.")
            saved = vault.read()
    if saved and not force_login:
        credentials = required_string(json_object(saved).get("credentials"), "saved credentials")
        session = provider.resume(client, credentials)
        if session.account.permission_id != account_from_saved(saved).permission_id:
            raise ValueError("Saved login resolved to a different account. Run login to reconnect.")
    else:
        session = provider.login(client)
    vault.write(saved_login(session))
    return session


class GoogleLoginProvider:
    def login(self, client: OAuthClient) -> LoginSession:
        from google_auth_oauthlib.flow import InstalledAppFlow

        flow = InstalledAppFlow.from_client_config(
            client.google_config(), [DRIVE_SCOPE], autogenerate_code_verifier=True,
        )
        try:
            credentials = flow.run_local_server(
                host="127.0.0.1", port=0, timeout_seconds=180,
                prompt="consent select_account", access_type="offline",
                success_message="Google Drive connected. You can close this tab.",
            )
        except (AttributeError, TimeoutError):
            raise LoginRequired("Login did not finish within three minutes. Run login again.") from None
        return self._session(credentials)

    def resume(self, client: OAuthClient, credentials_json: str) -> LoginSession:
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        value = json_object(credentials_json)
        if value.get("client_id") != client.client_id:
            raise LoginRequired("Saved login belongs to another OAuth client. Use the original client configuration.")
        if value.get("token_uri", TOKEN_URI) != TOKEN_URI:
            raise LoginRequired("Saved login has an invalid token endpoint. Run login again.")
        try:
            credentials = Credentials.from_authorized_user_info(value, [DRIVE_SCOPE])
        except ValueError:
            raise LoginRequired("Saved login is incomplete. Run login again.") from None
        if not credentials.valid:
            try:
                credentials.refresh(Request())
            except RefreshError as error:
                if error.retryable:
                    raise ValueError("Google login refresh is temporarily unavailable. Try again later.") from None
                raise LoginRequired("Google login expired or was revoked. Run login to reconnect.") from None
        return self._session(credentials)

    def _session(self, credentials: object) -> LoginSession:
        from googleapiclient.discovery import build

        if not getattr(credentials, "refresh_token", None):
            raise LoginRequired("Google did not grant offline access. Run login and approve Drive access.")
        granted = getattr(credentials, "granted_scopes", None)
        if granted is not None and DRIVE_SCOPE not in granted:
            raise LoginRequired("Drive access was not granted. Run login and approve Drive access.")
        service = build("drive", "v3", credentials=credentials, cache_discovery=False)
        response = service.about().get(fields="user(permissionId,emailAddress)").execute()
        user = response.get("user", {}) if isinstance(response, dict) else {}
        if not isinstance(user, dict):
            raise ValueError("Google returned invalid account details")
        account = Account(required_string(user.get("permissionId"), "Drive account ID"),
                          required_string(user.get("emailAddress"), "Drive account email"))
        serialize = getattr(credentials, "to_json")
        return LoginSession(account, serialize(strip=["id_token"]), GoogleDriveGateway(service))


def parser() -> argparse.ArgumentParser:
    """Build the command-line interface without executing it."""
    argument_parser = argparse.ArgumentParser(
        description="Open local office files in Google Workspace and explicitly pull remote edits."
    )
    argument_parser.add_argument("--state-dir", type=Path, help="Directory for local file mappings (tokens stay in the OS credential store)")
    argument_parser.add_argument("--credentials", type=Path, help="Developer override for the bundled Desktop OAuth client JSON")
    subparsers = argument_parser.add_subparsers(dest="command", required=True)
    for command, help_text in (
        ("login", "Connect Google Drive, or choose a different account"),
        ("reconnect", "Authorize Google Drive again after login expires"),
        ("logout", "Remove this client's saved login from this device"),
        ("whoami", "Show the locally saved Google account without a network request"),
    ):
        subparsers.add_parser(command, help=help_text)
    for command in ("open", "sync", "status"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("path", type=Path)
    return argument_parser


def require_saved_account(vault: TokenVault) -> Account:
    saved = vault.read()
    if saved is None:
        raise LoginRequired("Not connected. Run login to connect Google Drive.")
    return account_from_saved(saved)


def show_status(source_path: Path, store: SqliteMappingStore) -> int:
    mapping = store.get(source_path)
    if mapping is None:
        print("Not opened yet for this Google account")
        return 1
    print(f"Drive ID: {mapping.drive_id}\nSaved Drive version: {mapping.drive_version}")
    return 0


def run_command(args: argparse.Namespace) -> int:
    state_dir = (args.state_dir or default_state_dir()).expanduser()
    source_path = args.path.expanduser() if hasattr(args, "path") else None
    if source_path is not None and args.command in {"open", "sync"}:
        if not source_path.is_file():
            raise ValueError(f"Local file does not exist: {source_path}")
        format_for_path(source_path)
    client = load_oauth_client(args.credentials, state_dir)
    vault = SystemTokenVault(client, state_dir)
    if args.command == "whoami":
        print(f"Connected as {require_saved_account(vault).email}")
        return 0
    if args.command == "logout":
        vault.clear()
        legacy = state_dir / "token.json"
        if legacy.is_file():
            legacy.unlink()
            print("Removed legacy token.json. Unclaimed legacy file mappings are preserved.")
        print("Signed out on this device. Drive files and local mappings are preserved.")
        return 0
    if args.command == "status":
        account = require_saved_account(vault)
        assert source_path is not None
        return show_status(source_path, SqliteMappingStore(state_dir / "mappings.sqlite3", account_key=account.key(client)))
    session = connect_account(
        client=client, state_dir=state_dir, vault=vault, provider=GoogleLoginProvider(),
        force_login=args.command in {"login", "reconnect"},
    )
    if args.command in {"login", "reconnect"}:
        print(f"Connected as {session.account.email}")
        return 0
    assert source_path is not None
    store = SqliteMappingStore(state_dir / "mappings.sqlite3", account_key=session.account.key(client))
    if args.command == "open":
        opened = open_local_file(source_path, store, session.drive, SystemBrowser())
        action = "Imported and opened" if opened.created else "Opened"
        print(f"{action}: {opened.remote_file.web_view_link}")
        return 0
    synced = sync_remote_file(source_path, store, session.drive)
    messages = {
        SyncDecision.UP_TO_DATE: "No remote changes to download.",
        SyncDecision.DOWNLOAD_REMOTE: "Downloaded remote Google Workspace changes.",
        SyncDecision.LOCAL_CHANGED: "Sync stopped: the local file changed since its last baseline.",
        SyncDecision.CONFLICT: "Sync stopped: both the local and Google Workspace files changed.",
    }
    print(messages[synced.decision])
    return 0 if synced.decision in {SyncDecision.UP_TO_DATE, SyncDecision.DOWNLOAD_REMOTE} else 2


def main(arguments: list[str] | None = None) -> int:
    """Keep authentication errors and tokens out of tracebacks and terminal logs."""
    args = parser().parse_args(arguments)
    from google.auth.exceptions import GoogleAuthError
    from googleapiclient.errors import HttpError
    from oauthlib.oauth2 import OAuth2Error
    from requests.exceptions import RequestException

    try:
        return run_command(args)
    except (GoogleAuthError, OAuth2Error):
        print("Google authorization failed or was declined. Run login to try again.", file=sys.stderr)
    except HttpError as error:
        print(f"Google Drive request failed (HTTP {error.resp.status}). Check Drive API access and account permissions.", file=sys.stderr)
    except RequestException:
        print("Could not reach Google. Check your connection and try again.", file=sys.stderr)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"Error: {error}", file=sys.stderr)
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        return 130
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
