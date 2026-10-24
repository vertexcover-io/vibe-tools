# AI-generated. See PROMPT.md for the prompts and model used.
"""Behavior tests for gdrive-open."""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch


SCRIPT_PATH = Path(__file__).with_name("gdrive-open.py")
SPEC = importlib.util.spec_from_file_location("gdrive_open", SCRIPT_PATH)
assert SPEC is not None
assert SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ActivityTests(unittest.TestCase):
    def test_spinner_is_silent_when_output_is_redirected(self) -> None:
        from rich.console import Console
        output = io.StringIO()
        with patch("rich.console.Console", return_value=Console(file=output, force_terminal=False)):
            with MODULE.activity("Uploading to Google Drive..."):
                pass
        self.assertEqual(output.getvalue(), "")

    def test_spinner_cleans_up_and_propagates_error(self) -> None:
        status = MagicMock()
        status.__exit__.return_value = False
        with patch("rich.console.Console") as factory:
            factory.return_value.is_terminal = True
            factory.return_value.status.return_value = status
            with self.assertRaisesRegex(ValueError, "upload failed"):
                with MODULE.activity("Uploading to Google Drive..."):
                    raise ValueError("upload failed")
            self.assertEqual(factory.return_value.status.call_args.args[0].plain, "Uploading to Google Drive...")
        self.assertEqual(status.__exit__.call_args.args[0], ValueError)


class RenameCompatibilityTests(unittest.TestCase):
    def test_new_installs_use_gdrive_open_state_directory_on_each_platform(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for platform, base in (("darwin", root / "Library" / "Application Support"),
                                   ("win32", root / "roaming"), ("linux", root / "config")):
                with self.subTest(platform=platform), patch.object(MODULE.sys, "platform", platform), \
                     patch.object(Path, "home", return_value=root), \
                     patch.dict(MODULE.os.environ, {"APPDATA": str(root / "roaming"), "XDG_CONFIG_HOME": str(root / "config")}):
                    self.assertEqual(MODULE.default_state_dir(), base / "gdrive-open")

    def test_existing_state_is_reused_even_if_new_named_directory_also_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "open-in-google-workspace"
            legacy.mkdir()
            (root / "gdrive-open").mkdir()
            with patch.object(MODULE.sys, "platform", "linux"), \
                 patch.dict(MODULE.os.environ, {"XDG_CONFIG_HOME": str(root)}):
                self.assertEqual(MODULE.default_state_dir(), legacy)

    def test_rename_keeps_existing_keyring_service_and_username(self) -> None:
        import hashlib
        client = MODULE.OAuthClient("123.apps.googleusercontent.com", "desktop-secret")
        state_dir = Path("/existing/custom/state")
        with patch.object(MODULE.SystemTokenVault, "_native_backend"):
            vault = MODULE.SystemTokenVault(client, state_dir)
        expected = hashlib.sha256(json.dumps([client.client_id, str(state_dir.resolve())]).encode()).hexdigest()
        self.assertEqual(vault.service, "open-in-google-workspace")
        self.assertEqual(vault.username, expected)


class SupportedFormatTests(unittest.TestCase):
    def test_csv_imports_to_google_sheets_and_exports_as_csv(self) -> None:
        file_format = MODULE.format_for_path(Path("budget.csv"))

        self.assertEqual(file_format.workspace_mime_type, "application/vnd.google-apps.spreadsheet")
        self.assertEqual(file_format.export_mime_type, "text/csv")

    def test_office_files_map_to_their_matching_workspace_editor(self) -> None:
        cases = (
            ("report.xlsx", "application/vnd.google-apps.spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("letter.docx", "application/vnd.google-apps.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("pitch.pptx", "application/vnd.google-apps.presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        )

        for filename, workspace_mime, export_mime in cases:
            with self.subTest(filename=filename):
                file_format = MODULE.format_for_path(Path(filename))
                self.assertEqual(file_format.workspace_mime_type, workspace_mime)
                self.assertEqual(file_format.export_mime_type, export_mime)

    def test_unknown_file_type_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported file type"):
            MODULE.format_for_path(Path("notes.pdf"))

    def test_opendocument_files_are_supported(self) -> None:
        cases = (
            ("budget.ods", "application/vnd.google-apps.spreadsheet"),
            ("letter.odt", "application/vnd.google-apps.document"),
            ("pitch.odp", "application/vnd.google-apps.presentation"),
        )

        for filename, workspace_mime in cases:
            with self.subTest(filename=filename):
                self.assertEqual(MODULE.format_for_path(Path(filename)).workspace_mime_type, workspace_mime)

    def test_legacy_formats_are_rejected_to_prevent_mismatched_exports(self) -> None:
        for filename in ("budget.xls", "letter.doc", "pitch.ppt"):
            with self.subTest(filename=filename):
                with self.assertRaisesRegex(ValueError, "Unsupported file type"):
                    MODULE.format_for_path(Path(filename))


class MappingStoreTests(unittest.TestCase):
    def test_mapping_round_trips_through_local_sqlite_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state_path = Path(temporary_directory) / "state.sqlite3"
            source_path = Path(temporary_directory) / "Quarterly Budget.xlsx"
            expected = MODULE.Mapping(
                source_path=source_path.resolve(),
                drive_id="drive-file-123",
                workspace_mime_type="application/vnd.google-apps.spreadsheet",
                export_mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                baseline_hash="a" * 64,
                drive_version="42",
            )
            store = MODULE.SqliteMappingStore(state_path)

            store.upsert(expected)

            self.assertEqual(store.get(source_path), expected)

    def test_absent_mapping_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = MODULE.SqliteMappingStore(Path(temporary_directory) / "state.sqlite3")

            self.assertIsNone(store.get(Path(temporary_directory) / "not-opened.docx"))


class SyncDecisionTests(unittest.TestCase):
    def test_only_remote_changes_can_be_downloaded(self) -> None:
        baseline_hash = "a" * 64
        cases = (
            (baseline_hash, "8", "8", MODULE.SyncDecision.UP_TO_DATE),
            (baseline_hash, "8", "9", MODULE.SyncDecision.DOWNLOAD_REMOTE),
            ("b" * 64, "8", "8", MODULE.SyncDecision.LOCAL_CHANGED),
            ("b" * 64, "8", "9", MODULE.SyncDecision.CONFLICT),
        )

        for current_hash, saved_version, remote_version, expected in cases:
            with self.subTest(current_hash=current_hash, remote_version=remote_version):
                actual = MODULE.decide_sync(
                    baseline_hash=baseline_hash,
                    current_hash=current_hash,
                    saved_drive_version=saved_version,
                    remote_drive_version=remote_version,
                )
                self.assertEqual(actual, expected)


class FakeDrive:
    def __init__(self, remote_file: object, exported_content: bytes = b"") -> None:
        self.remote_file = remote_file
        self.exported_content = exported_content
        self.imported_paths: list[Path] = []
        self.exported_ids: list[str] = []

    def import_file(self, source_path: Path, file_format: object) -> object:
        del file_format
        self.imported_paths.append(source_path)
        return self.remote_file

    def get_file(self, drive_id: str) -> object:
        del drive_id
        return self.remote_file

    def export_file(self, drive_id: str, export_mime_type: str) -> bytes:
        del export_mime_type
        self.exported_ids.append(drive_id)
        return self.exported_content


class FakeBrowser:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def open(self, url: str) -> None:
        self.urls.append(url)


class OpenAndSyncTests(unittest.TestCase):
    def test_open_imports_once_then_reopens_the_mapped_drive_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = Path(temporary_directory) / "budget.csv"
            source_path.write_text("month,total\nOctober,100\n", encoding="utf-8")
            store = MODULE.SqliteMappingStore(Path(temporary_directory) / "state.sqlite3")
            remote_file = MODULE.RemoteFile("drive-123", "1", "https://docs.google.com/spreadsheets/d/drive-123/edit", False)
            drive = FakeDrive(remote_file)
            browser = FakeBrowser()

            first = MODULE.open_local_file(source_path, store, drive, browser)
            second = MODULE.open_local_file(source_path, store, drive, browser)

            self.assertTrue(first.created)
            self.assertFalse(second.created)
            self.assertEqual(drive.imported_paths, [source_path.resolve()])
            self.assertEqual(browser.urls, [remote_file.web_view_link, remote_file.web_view_link])

    def test_manual_sync_writes_remote_content_only_when_local_file_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = Path(temporary_directory) / "budget.csv"
            source_path.write_text("old local copy", encoding="utf-8")
            store = MODULE.SqliteMappingStore(Path(temporary_directory) / "state.sqlite3")
            baseline_hash = MODULE.sha256_file(source_path)
            mapping = MODULE.Mapping(
                source_path=source_path.resolve(),
                drive_id="drive-123",
                workspace_mime_type="application/vnd.google-apps.spreadsheet",
                export_mime_type="text/csv",
                baseline_hash=baseline_hash,
                drive_version="1",
            )
            store.upsert(mapping)
            remote_file = MODULE.RemoteFile("drive-123", "2", "https://docs.google.com/spreadsheets/d/drive-123/edit", False)
            drive = FakeDrive(remote_file, b"new remote copy")

            result = MODULE.sync_remote_file(source_path, store, drive)

            self.assertEqual(result.decision, MODULE.SyncDecision.DOWNLOAD_REMOTE)
            self.assertEqual(source_path.read_bytes(), b"new remote copy")
            self.assertEqual(drive.exported_ids, ["drive-123"])
            saved_mapping = store.get(source_path)
            self.assertIsNotNone(saved_mapping)
            assert saved_mapping is not None
            self.assertEqual(saved_mapping.drive_version, "2")
            self.assertEqual(saved_mapping.baseline_hash, MODULE.sha256_file(source_path))

    def test_manual_sync_refuses_a_locally_modified_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = Path(temporary_directory) / "budget.csv"
            source_path.write_text("old local copy", encoding="utf-8")
            store = MODULE.SqliteMappingStore(Path(temporary_directory) / "state.sqlite3")
            mapping = MODULE.Mapping(
                source_path=source_path.resolve(),
                drive_id="drive-123",
                workspace_mime_type="application/vnd.google-apps.spreadsheet",
                export_mime_type="text/csv",
                baseline_hash=MODULE.sha256_file(source_path),
                drive_version="1",
            )
            store.upsert(mapping)
            source_path.write_text("locally edited", encoding="utf-8")
            remote_file = MODULE.RemoteFile("drive-123", "2", "https://docs.google.com/spreadsheets/d/drive-123/edit", False)
            drive = FakeDrive(remote_file, b"new remote copy")

            result = MODULE.sync_remote_file(source_path, store, drive)

            self.assertEqual(result.decision, MODULE.SyncDecision.CONFLICT)
            self.assertEqual(source_path.read_text(encoding="utf-8"), "locally edited")
            self.assertEqual(drive.exported_ids, [])


class AccountMappingTests(unittest.TestCase):
    def test_same_local_path_has_separate_mappings_per_account_and_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "mappings.sqlite3"
            source = Path(directory) / "file.csv"
            first = MODULE.SqliteMappingStore(database, account_key="client1:alice")
            second = MODULE.SqliteMappingStore(database, account_key="client1:bob")
            other_client = MODULE.SqliteMappingStore(database, account_key="client2:alice")
            mapping = MODULE.Mapping(source.resolve(), "alice-file", "sheet", "text/csv", "hash", "1")
            first.upsert(mapping)
            self.assertIsNone(second.get(source))
            self.assertIsNone(other_client.get(source))
            second.upsert(replace(mapping, drive_id="bob-file"))
            self.assertEqual(first.get(source).drive_id, "alice-file")
            self.assertEqual(second.get(source).drive_id, "bob-file")

    def test_legacy_mapping_is_not_silently_assigned_to_new_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "mappings.sqlite3"
            source = Path(directory) / "file.csv"
            legacy = MODULE.SqliteMappingStore(database)
            legacy.upsert(MODULE.Mapping(source.resolve(), "old-file", "sheet", "text/csv", "hash", "1"))
            scoped = MODULE.SqliteMappingStore(database, account_key="bob")
            with self.assertRaisesRegex(ValueError, "legacy"):
                scoped.get(source)
            self.assertEqual(legacy.get(source).drive_id, "old-file")


class MemoryVault:
    def __init__(self) -> None:
        self.value: str | None = None

    def read(self) -> str | None:
        return self.value

    def write(self, value: str) -> None:
        self.value = value

    def clear(self) -> None:
        self.value = None


class LoginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.client = MODULE.OAuthClient("123.apps.googleusercontent.com", "desktop-secret")
        self.alice = MODULE.Account("alice-id", "alice@example.com")
        self.bob = MODULE.Account("bob-id", "bob@example.com")
        self.session = MODULE.LoginSession(self.alice, "private-token-json", Mock())
        self.provider = Mock()
        self.provider.login.return_value = self.session
        self.provider.resume.return_value = self.session
        self.vault = MemoryVault()

    def connect(self, *, force_login: bool = False) -> object:
        return MODULE.connect_account(
            client=self.client, state_dir=self.state, vault=self.vault,
            provider=self.provider, force_login=force_login,
        )

    def test_first_login_stores_token_in_vault_without_plaintext_token_file(self) -> None:
        result = self.connect()
        self.assertEqual(result.account, self.alice)
        self.provider.login.assert_called_once_with(self.client)
        self.assertIn("private-token-json", self.vault.read())
        self.assertFalse((self.state / "token.json").exists())

    def test_existing_login_resumes_and_persists_refreshed_credentials(self) -> None:
        self.connect()
        self.provider.resume.return_value = replace(self.session, credentials_json="refreshed")
        result = self.connect()
        self.assertEqual(result.credentials_json, "refreshed")
        self.assertEqual(self.provider.login.call_count, 1)
        self.assertEqual(json.loads(self.vault.read())["credentials"], "refreshed")

    def test_switch_account_uses_browser_and_preserves_separate_mapping_identity(self) -> None:
        self.connect()
        self.provider.login.return_value = replace(self.session, account=self.bob)
        result = self.connect(force_login=True)
        self.assertEqual(result.account, self.bob)
        self.assertNotEqual(self.alice.key(self.client), self.bob.key(self.client))

    def test_cancelled_login_preserves_previous_account(self) -> None:
        self.connect()
        saved = self.vault.read()
        self.provider.login.side_effect = ValueError("Login cancelled")
        with self.assertRaisesRegex(ValueError, "cancelled"):
            self.connect(force_login=True)
        self.assertEqual(self.vault.read(), saved)

    def test_expired_revoked_login_requires_explicit_reconnect(self) -> None:
        self.connect()
        self.provider.resume.side_effect = MODULE.LoginRequired("Run login again")
        with self.assertRaises(MODULE.LoginRequired):
            self.connect()
        self.assertEqual(self.provider.login.call_count, 1)
        self.connect(force_login=True)
        self.assertEqual(self.provider.login.call_count, 2)

    def test_changed_identity_from_saved_token_is_rejected(self) -> None:
        self.connect()
        self.provider.resume.return_value = replace(self.session, account=self.bob)
        with self.assertRaisesRegex(ValueError, "account"):
            self.connect()

    def test_verified_legacy_login_migrates_mapping_before_removing_plaintext_token(self) -> None:
        source = self.state / "file.csv"
        legacy = MODULE.SqliteMappingStore(self.state / "mappings.sqlite3")
        mapping = MODULE.Mapping(source.resolve(), "old-drive-id", "sheet", "text/csv", "hash", "7")
        legacy.upsert(mapping)
        (self.state / "token.json").write_text("legacy-credentials", encoding="utf-8")
        self.connect()
        scoped = MODULE.SqliteMappingStore(self.state / "mappings.sqlite3", account_key=self.alice.key(self.client))
        self.assertEqual(scoped.get(source), mapping)
        self.assertFalse((self.state / "token.json").exists())
        self.provider.login.assert_not_called()

    def test_keyring_failure_leaves_legacy_credentials_and_mappings_intact(self) -> None:
        token = self.state / "token.json"
        token.write_text("legacy-credentials", encoding="utf-8")
        with patch.object(self.vault, "write", side_effect=ValueError("Keychain locked")):
            with self.assertRaisesRegex(ValueError, "locked"):
                self.connect()
        self.assertEqual(token.read_text(), "legacy-credentials")

    def test_secret_values_are_excluded_from_debug_representations(self) -> None:
        self.assertNotIn("desktop-secret", repr(self.client))
        self.assertNotIn("private-token-json", repr(self.session))

    def test_expired_legacy_token_does_not_block_explicit_login_or_claim_old_files(self) -> None:
        source = self.state / "file.csv"
        legacy = MODULE.SqliteMappingStore(self.state / "mappings.sqlite3")
        legacy.upsert(MODULE.Mapping(source.resolve(), "old-file", "sheet", "text/csv", "hash", "1"))
        token = self.state / "token.json"
        token.write_text("expired-legacy", encoding="utf-8")
        def resume(client: object, value: str) -> object:
            if value == "expired-legacy":
                raise MODULE.LoginRequired("expired")
            return self.session
        self.provider.resume.side_effect = resume
        self.assertEqual(self.connect(force_login=True).account, self.alice)
        self.assertEqual(self.connect().account, self.alice)
        scoped = MODULE.SqliteMappingStore(self.state / "mappings.sqlite3", account_key=self.alice.key(self.client))
        with self.assertRaisesRegex(ValueError, "legacy"):
            scoped.get(source)
        self.assertEqual(token.read_text(), "expired-legacy")

    def test_failed_legacy_migration_preserves_token_for_retry(self) -> None:
        token = self.state / "token.json"
        token.write_text("legacy", encoding="utf-8")
        with patch.object(MODULE.SqliteMappingStore, "migrate_legacy", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.connect()
        self.assertTrue(token.exists())
        self.connect()
        self.assertFalse(token.exists())


class ClientConfigTests(unittest.TestCase):
    def test_missing_bundled_client_explains_publisher_setup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "publisher"):
                MODULE.load_oauth_client(None, root, root / "missing.json")

    def test_packaged_desktop_client_is_used_without_user_setup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled = root / "oauth-client.json"
            bundled.write_text(json.dumps({"installed": {
                "client_id": "123.apps.googleusercontent.com", "client_secret": "public-client-secret",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }}))
            client = MODULE.load_oauth_client(None, root / "state", bundled)
            self.assertEqual(client.client_id, "123.apps.googleusercontent.com")

    def test_web_clients_and_non_google_endpoints_are_rejected(self) -> None:
        cases = (
            {"web": {"client_id": "123.apps.googleusercontent.com"}},
            {"installed": {"client_id": "123.apps.googleusercontent.com", "client_secret": "x", "token_uri": "https://evil.example/token"}},
        )
        for value in cases:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                client_file = root / "client.json"
                client_file.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    MODULE.load_oauth_client(client_file, root, root / "missing.json")


class LoginCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.client = MODULE.OAuthClient("123.apps.googleusercontent.com", "public-secret")
        self.account = MODULE.Account("alice", "alice@example.com")
        self.session = MODULE.LoginSession(self.account, "SECRET", Mock())
        self.vault = MemoryVault()
        self.provider = Mock()
        self.provider.login.return_value = self.session
        self.provider.resume.return_value = self.session

    def run_command(self, *arguments: str) -> tuple[int, str]:
        with patch.object(MODULE, "load_oauth_client", return_value=self.client), \
             patch.object(MODULE, "SystemTokenVault", return_value=self.vault), \
             patch.object(MODULE, "GoogleLoginProvider", return_value=self.provider), \
             patch("sys.stdout", new_callable=io.StringIO) as output, \
             patch("sys.stderr", new_callable=io.StringIO) as errors:
            result = MODULE.main(["--state-dir", str(self.state), *arguments])
            return result, output.getvalue() + errors.getvalue()

    def test_login_whoami_and_logout_need_no_document_path(self) -> None:
        self.assertEqual(self.run_command("login")[0], 0)
        result, output = self.run_command("whoami")
        self.assertEqual(result, 0)
        self.assertIn("alice@example.com", output)
        self.assertNotIn("SECRET", output)
        self.provider.resume.assert_not_called()
        self.assertEqual(self.run_command("logout")[0], 0)
        self.assertIsNone(self.vault.read())
        self.assertEqual(self.run_command("whoami")[0], 1)
        self.assertEqual(self.run_command("logout")[0], 0)

    def test_status_after_logout_does_not_launch_browser_or_access_another_account(self) -> None:
        result, output = self.run_command("status", "test.csv")
        self.assertEqual(result, 1)
        self.assertIn("login", output)
        self.provider.login.assert_not_called()

    def test_reconnect_runs_account_chooser_again(self) -> None:
        self.run_command("login")
        self.assertEqual(self.run_command("reconnect")[0], 0)
        self.assertEqual(self.provider.login.call_count, 2)

    def test_missing_input_file_is_reported_before_starting_login(self) -> None:
        result, output = self.run_command("open", str(self.state / "missing.csv"))
        self.assertEqual(result, 1)
        self.assertIn("does not exist", output)
        self.provider.login.assert_not_called()

    def test_failed_keyring_access_has_no_file_fallback(self) -> None:
        with patch.object(self.vault, "read", side_effect=ValueError("Keychain locked")):
            result, output = self.run_command("login")
        self.assertEqual(result, 1)
        self.assertIn("locked", output)
        self.provider.login.assert_not_called()
        self.assertFalse((self.state / "token.json").exists())


class GoogleLoginAdapterTests(unittest.TestCase):
    def test_drive_account_identity_is_looked_up_before_saving_tokens(self) -> None:
        credentials = Mock()
        credentials.refresh_token = "refresh"
        credentials.granted_scopes = [MODULE.DRIVE_SCOPE]
        credentials.to_json.return_value = "stored-credentials"
        with patch("googleapiclient.discovery.build") as build:
            build.return_value.about.return_value.get.return_value.execute.return_value = {
                "user": {"permissionId": "stable-id", "emailAddress": "alice@example.com"},
            }
            session = MODULE.GoogleLoginProvider()._session(credentials)
            self.assertEqual(session.account, MODULE.Account("stable-id", "alice@example.com"))
            build.return_value.about.return_value.get.assert_called_once_with(fields="user(permissionId,emailAddress)")
            self.assertEqual(session.credentials_json, "stored-credentials")

    def test_missing_offline_or_drive_access_does_not_create_a_session(self) -> None:
        credentials = Mock()
        credentials.refresh_token = None
        with self.assertRaises(MODULE.LoginRequired):
            MODULE.GoogleLoginProvider()._session(credentials)
        credentials.refresh_token = "refresh"
        credentials.granted_scopes = ["openid"]
        with self.assertRaises(MODULE.LoginRequired):
            MODULE.GoogleLoginProvider()._session(credentials)

    def test_login_requests_pkce_offline_access_and_account_chooser_on_loopback(self) -> None:
        client = MODULE.OAuthClient("123.apps.googleusercontent.com", "public-secret")
        provider = MODULE.GoogleLoginProvider()
        with patch("google_auth_oauthlib.flow.InstalledAppFlow.from_client_config") as make_flow, \
             patch.object(provider, "_session", return_value="session"):
            self.assertEqual(provider.login(client), "session")
            self.assertTrue(make_flow.call_args.kwargs["autogenerate_code_verifier"])
            self.assertEqual(make_flow.call_args.args[1], [MODULE.DRIVE_SCOPE])
            kwargs = make_flow.return_value.run_local_server.call_args.kwargs
            self.assertEqual(kwargs["host"], "127.0.0.1")
            self.assertEqual(kwargs["port"], 0)
            self.assertEqual(kwargs["prompt"], "consent select_account")
            self.assertEqual(kwargs["access_type"], "offline")
            self.assertEqual(kwargs["timeout_seconds"], 180)

    def test_revoked_refresh_returns_reconnect_instruction_without_token_details(self) -> None:
        from google.auth.exceptions import RefreshError
        client = MODULE.OAuthClient("123.apps.googleusercontent.com", "public-secret")
        provider = MODULE.GoogleLoginProvider()
        with patch("google.oauth2.credentials.Credentials.from_authorized_user_info") as restore:
            restore.return_value.valid = False
            restore.return_value.refresh.side_effect = RefreshError("invalid_grant SECRET")
            with self.assertRaises(MODULE.LoginRequired) as error:
                provider.resume(client, json.dumps({"client_id": client.client_id}))
            self.assertNotIn("SECRET", str(error.exception))
            self.assertIn("login", str(error.exception))

    def test_refresh_uses_google_endpoint_and_rejects_other_client(self) -> None:
        client = MODULE.OAuthClient("123.apps.googleusercontent.com", "public-secret")
        provider = MODULE.GoogleLoginProvider()
        with patch("google.oauth2.credentials.Credentials.from_authorized_user_info") as restore:
            for data in ({"client_id": "other"}, {"client_id": client.client_id, "token_uri": "https://evil.example"}):
                with self.assertRaises(MODULE.LoginRequired):
                    provider.resume(client, json.dumps(data))
            restore.assert_not_called()


class NativeVaultTests(unittest.TestCase):
    def test_tokens_are_sent_only_to_native_backend_and_namespaced_by_client(self) -> None:
        client = MODULE.OAuthClient("123.apps.googleusercontent.com", "secret")
        with patch.object(MODULE.SystemTokenVault, "_native_backend") as factory:
            vault = MODULE.SystemTokenVault(client, Path("/example/state"))
            factory.return_value.get_password.return_value = "private-token"
            vault.write("private-token")
            self.assertEqual(vault.read(), "private-token")
            factory.return_value.set_password.assert_called_once_with(vault.service, vault.username, "private-token")
            other = MODULE.SystemTokenVault(replace(client, client_id="other"), Path("/example/state"))
            self.assertNotEqual(vault.username, other.username)
            vault.clear()
            factory.return_value.delete_password.assert_called_once_with(vault.service, vault.username)

    def test_native_backend_failure_does_not_expose_credentials(self) -> None:
        with patch.object(MODULE.SystemTokenVault, "_native_backend") as factory:
            vault = MODULE.SystemTokenVault(MODULE.OAuthClient("client", "secret"), Path("/state"))
            factory.return_value.set_password.side_effect = RuntimeError("private-token")
            with self.assertRaisesRegex(ValueError, "credential store") as error:
                vault.write("private-token")
            self.assertNotIn("private-token", str(error.exception))


if __name__ == "__main__":
    unittest.main()
