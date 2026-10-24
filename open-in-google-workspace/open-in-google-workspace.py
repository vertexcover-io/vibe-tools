#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-api-python-client>=2.0.0", "google-auth-oauthlib>=1.2.0"]
# ///
"""Open local office files in Google Workspace and explicitly pull remote edits."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from enum import Enum
import hashlib
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

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
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

    def get(self, source_path: Path) -> Mapping | None:
        source_key = str(source_path.resolve())
        with self._connect() as connection:
            row = connection.execute(
                "SELECT source_path, drive_id, workspace_mime_type, export_mime_type, "
                "baseline_hash, drive_version FROM mappings WHERE source_path = ?",
                (source_key,),
            ).fetchone()
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
        with self._connect() as connection:
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


def create_google_drive_gateway(credentials_path: Path, token_path: Path) -> GoogleDriveGateway:
    """Authenticate a desktop user and return a Drive client limited to this app's files."""
    if not credentials_path.is_file():
        raise ValueError(
            "Missing OAuth desktop-client JSON. Create one in Google Cloud, then place it at "
            f"{credentials_path} or pass --credentials PATH."
        )
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    credentials: object | None = None
    if token_path.is_file():
        credentials = Credentials.from_authorized_user_file(str(token_path), [DRIVE_SCOPE])
    is_valid = bool(getattr(credentials, "valid", False))
    if not is_valid:
        is_expired = bool(getattr(credentials, "expired", False))
        refresh_token = getattr(credentials, "refresh_token", None)
        refresh = getattr(credentials, "refresh", None)
        if is_expired and isinstance(refresh_token, str) and refresh_token and callable(refresh):
            refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), [DRIVE_SCOPE])
            credentials = flow.run_local_server(port=0)
        to_json = getattr(credentials, "to_json", None)
        if not callable(to_json):
            raise ValueError("Google OAuth did not return usable credentials")
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(to_json(), encoding="utf-8")
    return GoogleDriveGateway(build("drive", "v3", credentials=credentials, cache_discovery=False))


def parser() -> argparse.ArgumentParser:
    """Build the command-line interface without executing it."""
    argument_parser = argparse.ArgumentParser(
        description="Open local office files in Google Workspace and explicitly pull remote edits."
    )
    argument_parser.add_argument("--state-dir", type=Path, help="Directory for the local mapping database and OAuth token")
    argument_parser.add_argument("--credentials", type=Path, help="Google OAuth desktop-client JSON path")
    subparsers = argument_parser.add_subparsers(dest="command", required=True)
    for command in ("open", "sync", "status"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("path", type=Path)
    return argument_parser


def main(arguments: list[str] | None = None) -> int:
    """Run the user-facing command and return a shell status code."""
    arguments_namespace = parser().parse_args(arguments)
    source_path = arguments_namespace.path.expanduser()
    state_dir = (arguments_namespace.state_dir or default_state_dir()).expanduser()
    store = SqliteMappingStore(state_dir / "mappings.sqlite3")
    try:
        if arguments_namespace.command == "status":
            mapping = store.get(source_path)
            if mapping is None:
                print("Not opened yet")
                return 1
            print(f"Drive ID: {mapping.drive_id}\nSaved Drive version: {mapping.drive_version}")
            return 0
        if not source_path.is_file():
            raise ValueError(f"Local file does not exist: {source_path}")
        credentials_path = (arguments_namespace.credentials or state_dir / "credentials.json").expanduser()
        drive = create_google_drive_gateway(credentials_path, state_dir / "token.json")
        if arguments_namespace.command == "open":
            result = open_local_file(source_path, store, drive, SystemBrowser())
            action = "Imported and opened" if result.created else "Opened"
            print(f"{action}: {result.remote_file.web_view_link}")
            return 0
        result = sync_remote_file(source_path, store, drive)
        messages = {
            SyncDecision.UP_TO_DATE: "No remote changes to download.",
            SyncDecision.DOWNLOAD_REMOTE: "Downloaded remote Google Workspace changes.",
            SyncDecision.LOCAL_CHANGED: "Sync stopped: the local file changed since its last baseline.",
            SyncDecision.CONFLICT: "Sync stopped: both the local and Google Workspace files changed.",
        }
        print(messages[result.decision])
        return 0 if result.decision in {SyncDecision.UP_TO_DATE, SyncDecision.DOWNLOAD_REMOTE} else 2
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
