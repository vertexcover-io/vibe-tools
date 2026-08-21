#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pick a Claude Code session with fzf and zip it as a readable transcript."""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

JsonDict = dict[str, Any]

PROJECTS = Path.home() / ".claude" / "projects"
HEAD_BYTES = 128 * 1024
TAIL_BYTES = 256 * 1024
PREVIEW_LIMIT = 120
TOOL_LINE_MAX = 110
SHORT_ID = 8

DIM, CYAN, GREEN, BOLD, RESET = "\033[2m", "\033[36m", "\033[32m", "\033[1m", "\033[0m"


@dataclass(frozen=True)
class Session:
    path: Path
    session_id: str
    project: str
    cwd: str
    title: str
    updated: datetime
    size: int
    git_branch: str


@dataclass(frozen=True)
class Message:
    role: str
    text: str
    ts: str


# ---------------------------------------------------------------- index


def iter_session_files() -> Iterator[Path]:
    if not PROJECTS.is_dir():
        return
    yield from sorted(PROJECTS.glob("*/*.jsonl"))


def read_edges(path: Path, size: int) -> tuple[bytes, bytes]:
    with path.open("rb") as handle:
        head = handle.read(min(HEAD_BYTES, size))
        if size <= HEAD_BYTES:
            return head, head
        if size > HEAD_BYTES + TAIL_BYTES:
            handle.seek(-TAIL_BYTES, os.SEEK_END)
            return head, handle.read()
        return head, head + handle.read()


def loads(line: bytes) -> JsonDict:
    try:
        value = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def find_last(blob: bytes, marker: bytes) -> JsonDict:
    index = blob.rfind(marker)
    if index == -1:
        return {}
    start = blob.rfind(b"\n", 0, index) + 1
    end = blob.find(b"\n", index)
    return loads(blob[start:] if end == -1 else blob[start:end])


def find_first(blob: bytes, marker: bytes) -> JsonDict:
    for line in blob.split(b"\n"):
        if marker in line:
            entry = loads(line)
            if entry:
                return entry
    return {}


def extract_title(head: bytes, tail: bytes) -> str:
    for blob in (tail, head):
        entry = find_last(blob, b'"ai-title"')
        title = entry.get("aiTitle")
        if title:
            return str(title).strip()
    return ""


def first_prompt(head: bytes) -> str:
    for line in head.split(b"\n"):
        if b'"type":"user"' not in line and b'"type": "user"' not in line:
            continue
        entry = loads(line)
        if entry.get("isMeta"):
            continue
        content = entry.get("message", {}).get("content")
        if not isinstance(content, str):
            continue
        text = strip_noise(content)
        if text:
            return " ".join(text.split())
    return ""


def load_session(path: Path) -> Session | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    if stat.st_size == 0:
        return None
    head, tail = read_edges(path, stat.st_size)
    context = find_first(head, b'"cwd"')
    cwd = str(context.get("cwd") or decode_project_dir(path.parent.name))
    title = extract_title(head, tail) or first_prompt(head) or "(untitled)"
    return Session(
        path=path,
        session_id=path.stem,
        project=Path(cwd).name or path.parent.name,
        cwd=cwd,
        title=title[:120],
        updated=datetime.fromtimestamp(stat.st_mtime).astimezone(),
        size=stat.st_size,
        git_branch=str(context.get("gitBranch") or ""),
    )


def decode_project_dir(name: str) -> str:
    return "/" + name.lstrip("-").replace("-", "/")


def build_index() -> list[Session]:
    sessions = (load_session(path) for path in iter_session_files())
    found = [session for session in sessions if session is not None]
    return sorted(found, key=lambda session: session.updated, reverse=True)


def under(session: Session, root: Path) -> bool:
    return session.cwd == str(root) or session.cwd.startswith(f"{root}/")


def matches(session: Session, needle: str) -> bool:
    haystack = f"{session.session_id} {session.project} {session.cwd} {session.title}".lower()
    return all(word in haystack for word in needle.lower().split())


# ---------------------------------------------------------------- messages


def strip_noise(text: str) -> str:
    command = re.search(r"<command-name>(.*?)</command-name>", text, re.DOTALL)
    if command:
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.DOTALL)
        tail = args.group(1).strip() if args else ""
        return f"/{command.group(1).strip().lstrip('/')} {tail}".strip()
    for tag in ("system-reminder", "local-command-stdout", "local-command-stderr"):
        text = re.sub(rf"<{tag}>.*?</{tag}>", "", text, flags=re.DOTALL)
    return text.strip()


def text_blocks(content: object) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ]


def tool_summary(block: JsonDict) -> str:
    name = block.get("name", "tool")
    payload = block.get("input") or {}
    hint = ""
    if isinstance(payload, dict):
        for key in ("command", "file_path", "pattern", "path", "query", "prompt", "url"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                hint = " ".join(value.split())
                break
    line = f"{name}: {hint}" if hint else str(name)
    return line[:TOOL_LINE_MAX] + ("…" if len(line) > TOOL_LINE_MAX else "")


def user_message(entry: JsonDict) -> Message | None:
    if entry.get("isMeta"):
        return None
    joined = "\n".join(text_blocks(entry.get("message", {}).get("content")))
    text = strip_noise(joined)
    return Message("you", text, entry.get("timestamp", "")) if text else None


def assistant_messages(entry: JsonDict) -> Iterator[Message]:
    ts = entry.get("timestamp", "")
    content = entry.get("message", {}).get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and block.get("text", "").strip():
            yield Message("claude", block["text"].strip(), ts)
        elif block.get("type") == "tool_use":
            yield Message("tool", tool_summary(block), ts)


def iter_messages(path: Path) -> Iterator[Message]:
    with path.open("r", errors="replace") as handle:
        for line in handle:
            entry = loads(line.encode("utf-8", "replace"))
            kind = entry.get("type")
            if kind == "user":
                message = user_message(entry)
                if message:
                    yield message
            elif kind == "assistant":
                yield from assistant_messages(entry)


def clock(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return ""


# ---------------------------------------------------------------- render


def render_markdown(session: Session) -> str:
    lines = [
        f"# {session.title}",
        "",
        f"- **Session** `{session.session_id}`",
        f"- **Project** `{session.cwd}`",
        f"- **Branch** `{session.git_branch or 'n/a'}`",
        f"- **Updated** {session.updated:%Y-%m-%d %H:%M %Z}",
        "",
        "---",
        "",
    ]
    for message in iter_messages(session.path):
        stamp = clock(message.ts)
        if message.role == "tool":
            lines += [f"> `→ {message.text}`", ""]
            continue
        who = "You" if message.role == "you" else "Claude"
        lines += [f"## {who}{f' · {stamp}' if stamp else ''}", "", message.text, ""]
    return "\n".join(lines) + "\n"


def render_preview(session: Session) -> str:
    lines = [
        f"{BOLD}{session.title}{RESET}",
        f"{DIM}{session.cwd}  ·  {session.session_id}{RESET}",
        f"{DIM}{'─' * 60}{RESET}",
        "",
    ]
    shown = 0
    for message in iter_messages(session.path):
        if message.role == "tool":
            lines.append(f"{DIM}  → {message.text}{RESET}")
            continue
        if shown >= PREVIEW_LIMIT:
            lines.append(f"{DIM}… truncated, full transcript goes in the zip{RESET}")
            break
        shown += 1
        colour, who = (GREEN, "You") if message.role == "you" else (CYAN, "Claude")
        stamp = clock(message.ts)
        lines += [f"{colour}{BOLD}{who}{RESET} {DIM}{stamp}{RESET}", message.text, ""]
    return "\n".join(lines)


# ---------------------------------------------------------------- picker


def row(session: Session, width: int) -> str:
    project = session.project[:width].ljust(width)
    date = session.updated.strftime("%Y-%m-%d %H:%M")
    return (
        f"{session.path}\t{DIM}{date}{RESET}  {CYAN}{project}{RESET}  "
        f"{session.title}  {DIM}{session.session_id[:8]}{RESET}"
    )


def interactive() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def pick(sessions: list[Session], query: str) -> list[Session]:
    if not interactive():
        sys.exit("No terminal for the picker. Pass a session id, or narrow with -d/query.")
    if not shutil.which("fzf"):
        sys.exit("fzf not found. Install it: brew install fzf")
    width = min(24, max((len(s.project) for s in sessions), default=8))
    by_path = {str(s.path): s for s in sessions}
    command = [
        "fzf",
        "--ansi",
        "--multi",
        "--delimiter=\t",
        "--with-nth=2..",
        "--layout=reverse",
        "--border",
        "--prompt=session> ",
        "--header=enter to zip · esc to cancel · tab to multi-select · ctrl-/ toggles preview",
        f"--preview={shell_quote(sys.executable)} {shell_quote(__file__)} --render {{1}}",
        "--preview-window=right:60%:wrap",
        "--bind=ctrl-/:toggle-preview",
    ]
    if query:
        command.append(f"--query={query}")
    payload = "\n".join(row(session, width) for session in sessions)
    result = subprocess.run(
        command, input=payload, capture_output=True, text=True, check=False
    )
    if result.returncode != 0 or not result.stdout.strip():
        return []
    picked = (line.split("\t", 1)[0] for line in result.stdout.strip().split("\n"))
    return [by_path[path] for path in picked if path in by_path]


def shell_quote(value: str) -> str:
    return "'" + str(Path(value).resolve()).replace("'", "'\\''") + "'"


# ---------------------------------------------------------------- export


def subagent_files(session: Session) -> list[Path]:
    folder = session.path.parent / session.session_id / "subagents"
    return sorted(folder.glob("*.jsonl")) if folder.is_dir() else []


def build_meta(session: Session, subagents: list[Path]) -> JsonDict:
    roles: dict[str, int] = {}
    for message in iter_messages(session.path):
        roles[message.role] = roles.get(message.role, 0) + 1
    return {
        "session_id": session.session_id,
        "title": session.title,
        "project": session.project,
        "cwd": session.cwd,
        "git_branch": session.git_branch,
        "updated_at": session.updated.isoformat(),
        "source_path": str(session.path),
        "bytes": session.size,
        "messages": roles,
        "subagents": [path.name for path in subagents],
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def zip_name(session: Session) -> str:
    return f"ccpack-{session.session_id[:SHORT_ID]}.zip"


def build_archive(session: Session, include_subagents: bool) -> bytes:
    subagents = subagent_files(session) if include_subagents else []
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("transcript.md", render_markdown(session))
        archive.writestr("meta.json", json.dumps(build_meta(session, subagents), indent=2))
        archive.write(session.path, "session.jsonl")
        for path in subagents:
            archive.write(path, f"subagents/{path.name}")
    return buffer.getvalue()


def export(session: Session, outdir: Path, include_subagents: bool) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    target = outdir / zip_name(session)
    target.write_bytes(build_archive(session, include_subagents))
    return target


# ---------------------------------------------------------------- server

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def session_json(session: Session) -> JsonDict:
    return {
        "id": session.session_id,
        "title": session.title,
        "project": session.project,
        "cwd": session.cwd,
        "branch": session.git_branch,
        "updated": session.updated.isoformat(),
        "bytes": session.size,
    }


def transcript_json(session: Session) -> JsonDict:
    messages = [
        {"role": message.role, "text": message.text, "at": clock(message.ts)}
        for message in iter_messages(session.path)
    ]
    return {**session_json(session), "messages": messages}


class Handler(BaseHTTPRequestHandler):
    server_version = "ccpack"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def local_only(self) -> bool:
        host = self.headers.get("Host", "")
        return host.rsplit(":", 1)[0].strip("[]") in LOCAL_HOSTS

    def send(self, status: int, body: bytes, ctype: str, extra: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            self.send_header("Content-Disposition", extra)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: Any, status: int = 200) -> None:
        self.send(status, json.dumps(payload).encode(), "application/json")

    def find(self, session_id: str) -> Session | None:
        wanted = unquote(session_id)
        return next((s for s in build_index() if s.session_id == wanted), None)

    def do_GET(self) -> None:
        if not self.local_only():
            self.send(403, b"forbidden", "text/plain")
            return
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            page = Path(__file__).with_suffix(".html")
            self.send(200, page.read_bytes(), "text/html; charset=utf-8")
            return
        if path == "/api/sessions":
            self.send_json([session_json(s) for s in build_index()])
            return
        if path.startswith("/api/session/"):
            session = self.find(path[len("/api/session/") :])
            if session is None:
                self.send_json({"error": "not found"}, 404)
                return
            self.send_json(transcript_json(session))
            return
        if path.startswith("/api/zip/"):
            session = self.find(path[len("/api/zip/") :])
            if session is None:
                self.send_json({"error": "not found"}, 404)
                return
            blob = build_archive(session, include_subagents=True)
            disposition = f'attachment; filename="{zip_name(session)}"'
            self.send(200, blob, "application/zip", disposition)
            return
        self.send(404, b"not found", "text/plain")


def serve(port: int) -> int:
    if not Path(__file__).with_suffix(".html").exists():
        sys.exit("ccpack.html is missing next to ccpack.py.")
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as error:
        sys.exit(f"Cannot serve on port {port}: {error.strerror or error}. Try --serve PORT.")
    url = f"http://127.0.0.1:{httpd.server_port}"
    print(f"ccpack is serving {len(build_index())} sessions at {url}", flush=True)
    print("Only this machine can reach it. Ctrl-C to stop.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
    return 0


# ---------------------------------------------------------------- cli


def resolve_direct(sessions: list[Session], query: str) -> Session | None:
    if not query:
        return None
    exact = [s for s in sessions if s.session_id == query]
    if exact:
        return exact[0]
    if not re.fullmatch(r"[0-9a-f]{8,}", query.lower()):
        return None
    prefixed = [s for s in sessions if s.session_id.startswith(query.lower())]
    return prefixed[0] if len(prefixed) == 1 else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pick a Claude Code session with fzf and pack it into a zip."
    )
    parser.add_argument("query", nargs="?", default="", help="filter text or a session id")
    parser.add_argument("-o", "--out", default=".", help="output directory (default: .)")
    parser.add_argument(
        "-d",
        "--dir",
        nargs="?",
        const=".",
        default=None,
        metavar="PATH",
        help="only sessions started in PATH or below it (bare -d means here)",
    )
    parser.add_argument("--print", dest="to_stdout", action="store_true", help="print transcript instead of zipping")
    parser.add_argument("--no-subagents", action="store_true", help="skip subagent transcripts")
    parser.add_argument("-y", "--yes", action="store_true", help="skip the confirm preview for a session id")
    parser.add_argument(
        "--serve",
        nargs="?",
        const=8765,
        type=int,
        default=None,
        metavar="PORT",
        help="browse sessions in a local web UI (default port 8765)",
    )
    parser.add_argument("--render", help=argparse.SUPPRESS)
    return parser.parse_args()


def render_mode(path_text: str) -> int:
    session = load_session(Path(path_text))
    if session is None:
        print("(unreadable session)")
        return 0
    print(render_preview(session))
    return 0


def select(args: argparse.Namespace, sessions: list[Session]) -> list[Session]:
    direct = resolve_direct(sessions, args.query)
    if direct:
        if args.yes or args.to_stdout or not interactive():
            return [direct]
        return pick([direct], "")
    if args.query:
        sessions = [s for s in sessions if matches(s, args.query)]
    if not sessions:
        sys.exit(f"No sessions match {args.query!r}.")
    return pick(sessions, "")


def main() -> int:
    args = parse_args()
    if args.render:
        return render_mode(args.render)
    if args.serve is not None:
        return serve(args.serve)

    sessions = build_index()
    if not sessions:
        sys.exit(f"No sessions found under {PROJECTS}.")
    if args.dir is not None:
        root = Path(args.dir).expanduser().resolve()
        sessions = [session for session in sessions if under(session, root)]
        if not sessions:
            sys.exit(f"No sessions started under {root}.")

    chosen = select(args, sessions)
    if not chosen:
        return 1

    for session in chosen:
        if args.to_stdout:
            print(render_markdown(session))
            continue
        target = export(session, Path(args.out).expanduser(), not args.no_subagents)
        size = target.stat().st_size / 1024
        print(f"{GREEN}✓{RESET} {target}  {DIM}({size:,.0f} KB · {session.title}){RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
