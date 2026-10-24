# AI-generated. See PROMPT.md for the prompts and model used.
"""Distribution checks: only public client configuration belongs in the binary."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("gdrive_open_build", Path(__file__).with_name("build-binary.py"))
assert SPEC is not None and SPEC.loader is not None
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class BuildCredentialTests(unittest.TestCase):
    def test_only_desktop_client_fields_are_staged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "download.json"
            source.write_text(json.dumps({"installed": {
                "client_id": "123.apps.googleusercontent.com", "client_secret": "desktop-secret",
                "refresh_token": "DO-NOT-SHIP", "token": "DO-NOT-SHIP",
            }, "token": "DO-NOT-SHIP"}))
            result = BUILD.stage_oauth_client(source, root)
            content = result.read_text()
            self.assertNotIn("DO-NOT-SHIP", content)
            self.assertNotIn("refresh_token", content)
            self.assertEqual(json.loads(content)["installed"]["client_id"], "123.apps.googleusercontent.com")
            command = BUILD.pyinstaller_command(staging=root, output_dir=root / "dist",
                                                discovery_data=root / "drive.v3.json", client_data=result)
            self.assertIn(f"{result}:.", command)
            self.assertNotIn(str(source), command)

    def test_authorized_user_tokens_cannot_be_used_as_client_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "token.json"
            source.write_text(json.dumps({"type": "authorized_user", "refresh_token": "DO-NOT-SHIP"}))
            with self.assertRaisesRegex(ValueError, "Desktop app"):
                BUILD.stage_oauth_client(source, root)
            self.assertFalse((root / "oauth-client.json").exists())


if __name__ == "__main__":
    unittest.main()
