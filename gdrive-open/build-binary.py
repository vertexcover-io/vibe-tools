#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyinstaller>=6.11,<7", "google-api-python-client>=2,<3", "google-auth-oauthlib>=1.2,<2", "keyring>=25,<26", "rich>=13,<15"]
# ///
"""Build a standalone gdrive-open executable for the current OS and architecture."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "gdrive-open.py"


def stage_oauth_client(client_config: Path, staging: Path) -> Path:
    """Bundle only validated public Desktop client settings, never user tokens."""
    spec = importlib.util.spec_from_file_location("gdrive_open_build_target", SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load gdrive-open's client validator")
    app = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = app
    spec.loader.exec_module(app)
    client = app.load_oauth_client(client_config, staging)
    destination = staging / "oauth-client.json"
    destination.write_text(json.dumps(client.google_config()), encoding="utf-8")
    return destination


def pyinstaller_command(
    *, staging: Path, output_dir: Path, discovery_data: Path, client_data: Path | None,
) -> list[str]:
    command = [
        sys.executable, "-m", "PyInstaller", "--onefile", "--name", "gdrive-open",
        "--clean", "--noconfirm", "--distpath", str(output_dir),
        "--workpath", str(staging / "work"), "--specpath", str(staging),
        "--add-data", f"{discovery_data}:googleapiclient/discovery_cache/documents",
    ]
    for package in ("google-api-python-client", "google-auth", "google-auth-oauthlib", "keyring", "rich"):
        command.extend(("--copy-metadata", package))
    if client_data is not None:
        command.extend(("--add-data", f"{client_data}:."))
    return [*command, str(SOURCE)]


def package_binary(executable: Path, target: str) -> Path:
    with executable.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    checksum_path = executable.parent / "SHA256SUMS"
    checksum_path.write_text(f"{checksum}  {executable.name}\n", encoding="utf-8")
    archive = executable.parent / f"gdrive-open-{target}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for path in (executable, checksum_path, ROOT / "README.md"):
            package.write(path, arcname=path.name)
    return archive


def build_binary(client_config: Path | None) -> Path:
    import googleapiclient.discovery_cache

    target = f"{platform.system().lower()}-{platform.machine().lower()}"
    output_dir = ROOT / "dist" / target
    output_dir.mkdir(parents=True, exist_ok=True)
    discovery_data = Path(googleapiclient.discovery_cache.__file__).parent / "documents" / "drive.v3.json"
    if not discovery_data.is_file():
        raise RuntimeError("The installed Google client library is missing its Drive discovery document")
    with tempfile.TemporaryDirectory(prefix="gdrive-open-build-") as directory:
        staging = Path(directory)
        client_data = stage_oauth_client(client_config, staging) if client_config else None
        command = pyinstaller_command(staging=staging, output_dir=output_dir,
                                      discovery_data=discovery_data, client_data=client_data)
        subprocess.run(command, check=True, env=os.environ | {"PYINSTALLER_CONFIG_DIR": str(staging / "cache")})
    executable = output_dir / ("gdrive-open.exe" if sys.platform == "win32" else "gdrive-open")
    subprocess.run([str(executable), "--help"], check=True, capture_output=True, text=True)
    archive = package_binary(executable, target)
    print(f"Executable: {executable}\nDistribution: {archive}")
    if client_config is None:
        print("No OAuth client bundled. Use --credentials PATH when running this build.")
    return executable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-config", type=Path, help="Desktop OAuth client JSON to bundle (never a token.json)")
    args = parser.parse_args()
    bundled = ROOT / "oauth-client.json"
    client_config = args.client_config or (bundled if bundled.is_file() else None)
    try:
        build_binary(client_config.expanduser() if client_config else None)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
