#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Translate a natural-language request into a bash command using Claude Code CLI."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


SYSTEM_PROMPT = """You translate a user's natural-language request into a single bash command.

Rules:
- Output ONLY a JSON object matching the requested schema. No prose, no markdown, no code fences.
- The "command" must be a single line of bash that accomplishes the request.
- Prefer standard POSIX-ish tools available on macOS and Linux (cp, mv, rm, find, grep, awk, sed, tar, zip).
- If the user references a file vaguely ("the latest CSV", "that python script"), resolve it using the FILE LISTING provided. Pick the best match and hardcode the resolved filename in the command.
- If a file was pre-selected via --pick, treat it as the authoritative source file unless the user clearly says otherwise.
- Quote paths that contain spaces or special characters.
- If the request is ambiguous and you cannot make a reasonable choice, set "command" to "" — the caller will surface that as an error.
- Never include destructive recursive deletes (rm -rf) on broad targets unless the user explicitly asks for them."""


SCHEMA = {
    "type": "object",
    "properties": {
        "command": {"type": "string"},
    },
    "required": ["command"],
    "additionalProperties": False,
}


@dataclass
class FileEntry:
    name: str
    size: int
    created: datetime
    modified: datetime
    is_dir: bool


def list_directory(path: Path, limit: int = 200) -> list[FileEntry]:
    entries: list[FileEntry] = []
    for child in path.iterdir():
        try:
            st = child.stat()
        except OSError:
            continue
        # On macOS st_birthtime is creation; on Linux fall back to ctime.
        birth = getattr(st, "st_birthtime", st.st_ctime)
        entries.append(
            FileEntry(
                name=child.name,
                size=st.st_size,
                created=datetime.fromtimestamp(birth, tz=timezone.utc),
                modified=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                is_dir=child.is_dir(),
            )
        )
    entries.sort(key=lambda e: e.created, reverse=True)
    return entries[:limit]


def format_listing(entries: list[FileEntry]) -> str:
    if not entries:
        return "(empty directory)"
    lines = ["NAME\tTYPE\tSIZE\tCREATED\tMODIFIED"]
    for e in entries:
        kind = "dir" if e.is_dir else "file"
        lines.append(
            f"{e.name}\t{kind}\t{e.size}\t"
            f"{e.created.strftime('%Y-%m-%d %H:%M')}\t"
            f"{e.modified.strftime('%Y-%m-%d %H:%M')}"
        )
    return "\n".join(lines)


def pick_file(entries: list[FileEntry]) -> str | None:
    if not shutil.which("fzf"):
        sys.exit("error: --pick requires fzf to be installed (brew install fzf)")
    if not entries:
        sys.exit("error: no files in current directory to pick from")

    # Build fzf input: "name\tcreated\tsize" — display columns, return the name only.
    lines = [
        f"{e.name}\t{e.created.strftime('%Y-%m-%d %H:%M')}\t{e.size}B"
        for e in entries
    ]
    proc = subprocess.run(
        [
            "fzf",
            "--delimiter=\t",
            "--with-nth=1,2,3",
            "--height=40%",
            "--reverse",
            "--prompt=pick a file > ",
            "--header=name | created | size",
        ],
        input="\n".join(lines),
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return proc.stdout.split("\t", 1)[0].strip()


def call_claude(user_request: str, listing: str, picked: str | None, model: str) -> dict:
    if not shutil.which("claude"):
        sys.exit("error: 'claude' CLI not found in PATH")

    parts = [f"USER REQUEST:\n{user_request}", f"\nFILE LISTING (cwd={Path.cwd()}):\n{listing}"]
    if picked:
        parts.append(f"\nPRE-SELECTED FILE: {picked}")
    user_message = "\n".join(parts)

    cmd = [
        "claude",
        "-p",
        "--model", model,
        "--append-system-prompt", SYSTEM_PROMPT,
        "--json-schema", json.dumps(SCHEMA),
        "--output-format", "json",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--disallowedTools",
        "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Agent",
        "--",
    ]
    result = subprocess.run(
        cmd,
        input=user_message,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit(f"error: claude CLI failed:\n{result.stderr.strip() or result.stdout.strip()}")

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        sys.exit(f"error: could not parse claude output as JSON: {exc}\nraw: {result.stdout[:500]}")

    structured = envelope.get("structured_output")
    if isinstance(structured, dict):
        return structured

    inner = envelope.get("result", envelope)
    if isinstance(inner, str):
        inner = inner.strip()
        try:
            return json.loads(inner)
        except json.JSONDecodeError:
            pass
        extracted = _extract_first_json_object(inner)
        if extracted is None:
            sys.exit(f"error: claude returned non-JSON result:\n{inner[:500]}")
        return extracted
    return inner


def _extract_first_json_object(text: str) -> dict | None:
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = -1
    return None


def copy_to_clipboard(text: str) -> str | None:
    """Try platform-appropriate clipboard tools. Returns the tool name used, or None."""
    candidates: list[list[str]] = []
    if sys.platform == "darwin":
        candidates.append(["pbcopy"])
    else:
        if os.environ.get("WAYLAND_DISPLAY"):
            candidates.append(["wl-copy"])
        candidates.extend([["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]])

    for cmd in candidates:
        if not shutil.which(cmd[0]):
            continue
        try:
            subprocess.run(cmd, input=text, text=True, check=True)
            return cmd[0]
        except subprocess.CalledProcessError:
            continue
    return None


def confirm(prompt: str) -> bool:
    try:
        ans = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return ans in ("y", "yes")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Turn an English request into a bash command using Claude Code.",
    )
    parser.add_argument("request", nargs="+", help="What you want done, in plain English.")
    parser.add_argument(
        "--pick",
        action="store_true",
        help="Open fzf to pre-select a file from the current directory.",
    )
    parser.add_argument(
        "-r", "--run",
        action="store_true",
        help="Execute the generated command after confirming with [y/N].",
    )
    parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="Execute the command immediately without confirmation. Implies --run.",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=Path.cwd(),
        help="Directory to list files from (default: cwd).",
    )
    parser.add_argument(
        "--model",
        default="sonnet",
        help="Claude model alias or full ID (default: sonnet — the latest sonnet).",
    )
    parser.add_argument(
        "-c", "--copy",
        action="store_true",
        help="Copy the generated command to the system clipboard.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Print diagnostic info (picked file, clipboard tool, command being run).",
    )
    args = parser.parse_args()

    def vprint(msg: str) -> None:
        if args.verbose:
            print(msg, file=sys.stderr)

    target_dir = args.dir.resolve()
    if not target_dir.is_dir():
        sys.exit(f"error: {target_dir} is not a directory")

    entries = list_directory(target_dir)
    listing = format_listing(entries)

    picked = pick_file(entries) if args.pick else None
    if args.pick and picked:
        vprint(f"# picked: {picked}")

    request = " ".join(args.request)
    response = call_claude(request, listing, picked, args.model)
    command = response.get("command", "").strip()

    if not command:
        sys.exit("error: no command generated (request may be too ambiguous)")

    will_run = args.run or args.yes

    if not will_run:
        print(command)

    if args.copy:
        tool = copy_to_clipboard(command)
        if tool:
            vprint(f"# copied to clipboard via {tool}")
        else:
            print("error: no clipboard tool found (install pbcopy/xclip/wl-copy)", file=sys.stderr)

    if will_run:
        if not args.yes and not confirm(f"run: {command}\n[y/N] "):
            print("aborted.", file=sys.stderr)
            return
        vprint(f"# running: {command}")
        sys.stdout.flush()
        sys.stderr.flush()
        os.execvp("bash", ["bash", "-c", command])


if __name__ == "__main__":
    main()
