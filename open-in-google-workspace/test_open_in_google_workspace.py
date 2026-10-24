"""Behavior tests for open-in-google-workspace."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("open-in-google-workspace.py")
SPEC = importlib.util.spec_from_file_location("open_in_google_workspace", SCRIPT_PATH)
assert SPEC is not None
assert SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


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


if __name__ == "__main__":
    unittest.main()
