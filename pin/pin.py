#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""pin: a CLI bookmark manager with Claude-powered NLP add and search."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import httpx


DEFAULT_DB = Path(
    os.environ.get("PIN_DB")
    or Path.home() / ".local" / "share" / "pin" / "pin.db"
)


# ---------- DB ----------

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (parent_id, name)
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
"""


def get_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- Folder helpers ----------

def split_path(folder_path: str) -> list[str]:
    parts = [p for p in folder_path.strip("/").split("/") if p]
    return parts


def get_folder_by_path(conn: sqlite3.Connection, folder_path: str) -> sqlite3.Row | None:
    parts = split_path(folder_path)
    if not parts:
        return None
    parent_id: int | None = None
    row: sqlite3.Row | None = None
    for part in parts:
        cur = conn.execute(
            "SELECT * FROM folders WHERE name = ? AND "
            + ("parent_id IS NULL" if parent_id is None else "parent_id = ?"),
            (part,) if parent_id is None else (part, parent_id),
        )
        row = cur.fetchone()
        if row is None:
            return None
        parent_id = row["id"]
    return row


def ensure_folder(conn: sqlite3.Connection, folder_path: str, description: str | None = None) -> int:
    parts = split_path(folder_path)
    if not parts:
        raise ValueError("empty folder path")
    parent_id: int | None = None
    final_id: int = 0
    for i, part in enumerate(parts):
        cur = conn.execute(
            "SELECT id FROM folders WHERE name = ? AND "
            + ("parent_id IS NULL" if parent_id is None else "parent_id = ?"),
            (part,) if parent_id is None else (part, parent_id),
        )
        row = cur.fetchone()
        if row is None:
            desc = description if i == len(parts) - 1 else None
            cur = conn.execute(
                "INSERT INTO folders (parent_id, name, description, created_at) VALUES (?, ?, ?, ?)",
                (parent_id, part, desc, now_iso()),
            )
            final_id = cur.lastrowid or 0
        else:
            final_id = row["id"]
        parent_id = final_id
    return final_id


def folder_path_str(conn: sqlite3.Connection, folder_id: int | None) -> str:
    if folder_id is None:
        return ""
    parts: list[str] = []
    current_id: int | None = folder_id
    while current_id is not None:
        row = conn.execute("SELECT name, parent_id FROM folders WHERE id = ?", (current_id,)).fetchone()
        if row is None:
            break
        parts.append(row["name"])
        current_id = row["parent_id"]
    return "/".join(reversed(parts))


def all_folder_paths(conn: sqlite3.Connection) -> list[tuple[int, str, str | None]]:
    rows = conn.execute("SELECT id, description FROM folders").fetchall()
    out = [(r["id"], folder_path_str(conn, r["id"]), r["description"]) for r in rows]
    out.sort(key=lambda x: x[1])
    return out


# ---------- Claude ----------

def claude_call(system_prompt: str, user_message: str, schema: dict, model: str) -> dict:
    if not shutil.which("claude"):
        sys.exit("error: 'claude' CLI not found in PATH")
    cmd = [
        "claude",
        "-p",
        "--model", model,
        "--append-system-prompt", system_prompt,
        "--json-schema", json.dumps(schema),
        "--output-format", "json",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--disallowedTools",
        "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Agent",
        "--",
    ]
    result = subprocess.run(cmd, input=user_message, capture_output=True, text=True)
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
        try:
            return json.loads(inner.strip())
        except json.JSONDecodeError:
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


# ---------- URL fetching ----------

def fetch_url_metadata(url: str) -> dict:
    try:
        with httpx.Client(follow_redirects=True, timeout=10.0, headers={"User-Agent": "pin/1.0"}) as client:
            resp = client.get(url)
            resp.raise_for_status()
            html = resp.text[:200_000]
    except Exception as e:
        return {"title": "", "description": "", "error": str(e)}
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    desc_match = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\']',
        html, re.IGNORECASE,
    ) or re.search(
        r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']*)["\']',
        html, re.IGNORECASE,
    )
    og_title_match = re.search(
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)["\']',
        html, re.IGNORECASE,
    )
    title = (title_match.group(1).strip() if title_match else "") or (og_title_match.group(1).strip() if og_title_match else "")
    desc = desc_match.group(1).strip() if desc_match else ""
    return {"title": title, "description": desc}


# ---------- Auto metadata via Claude ----------

AUTO_SYSTEM = """You generate bookmark metadata from a URL and its page metadata.

Output ONLY a JSON object matching the schema. No prose, no markdown.
- "name": short human-readable title (≤80 chars).
- "description": 1-2 sentence summary of what the page is about.
- "tags": 3-6 lowercase, kebab-case topical tags (no #), as a JSON array of strings.
- "folder": suggested folder path (forward-slash separated). Pick from EXISTING FOLDERS if a strong fit; otherwise propose a sensible new path. Empty string if no folder makes sense.
"""

AUTO_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "folder": {"type": "string"},
    },
    "required": ["name", "description", "tags", "folder"],
    "additionalProperties": False,
}


NL_ADD_SYSTEM = """You parse a freeform user description of a bookmark into structured fields.

Output ONLY a JSON object matching the schema.
- "url": the URL from the user's text. If multiple, pick the most relevant.
- "name": short human-readable title (≤80 chars). Infer from the user's text and page metadata.
- "description": 1-2 sentence summary.
- "tags": 3-6 lowercase kebab-case tags.
- "folder": forward-slash path. Prefer an existing folder from EXISTING FOLDERS if it fits; otherwise propose a new sensible path. Empty string if user gave no folder hint and none obviously fits.
"""

NL_ADD_SCHEMA = {
    "type": "object",
    "properties": {
        "url": {"type": "string"},
        "name": {"type": "string"},
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "folder": {"type": "string"},
    },
    "required": ["url", "name", "description", "tags", "folder"],
    "additionalProperties": False,
}


SEARCH_SYSTEM = """You rank bookmarks by relevance to a user query.

Output ONLY a JSON object matching the schema.
- "matches": array of objects, each with "id" (integer) and "reason" (≤80 char justification).
- Order by relevance (best first). Include only bookmarks that are genuinely relevant — fewer is better.
- Use the bookmark's name, description, tags, folder, and URL to judge relevance.
- Match on intent and topic, not just literal substrings.
"""

SEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "reason": {"type": "string"},
                },
                "required": ["id", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["matches"],
    "additionalProperties": False,
}


def auto_metadata(url: str, conn: sqlite3.Connection, model: str) -> dict:
    meta = fetch_url_metadata(url)
    folders = all_folder_paths(conn)
    folder_listing = "\n".join(f"- {p}" + (f" ({d})" if d else "") for _, p, d in folders) or "(none)"
    user_msg = (
        f"URL: {url}\n"
        f"PAGE TITLE: {meta.get('title', '')}\n"
        f"PAGE DESCRIPTION: {meta.get('description', '')}\n\n"
        f"EXISTING FOLDERS:\n{folder_listing}"
    )
    return claude_call(AUTO_SYSTEM, user_msg, AUTO_SCHEMA, model)


def nl_add(url: str | None, text: str, conn: sqlite3.Connection, model: str) -> dict:
    page_meta = {}
    if url:
        page_meta = fetch_url_metadata(url)
    folders = all_folder_paths(conn)
    folder_listing = "\n".join(f"- {p}" + (f" ({d})" if d else "") for _, p, d in folders) or "(none)"
    parts = [f"USER DESCRIPTION:\n{text}"]
    if url:
        parts.append(f"\nURL: {url}")
        parts.append(f"PAGE TITLE: {page_meta.get('title', '')}")
        parts.append(f"PAGE DESCRIPTION: {page_meta.get('description', '')}")
    parts.append(f"\nEXISTING FOLDERS:\n{folder_listing}")
    return claude_call(NL_ADD_SYSTEM, "\n".join(parts), NL_ADD_SCHEMA, model)


# ---------- Bookmark ops ----------

@dataclass
class BookmarkRow:
    id: int
    url: str
    name: str
    description: str
    tags: str
    folder_path: str


def list_bookmarks(conn: sqlite3.Connection, folder_id: int | None = None, recursive: bool = True) -> list[BookmarkRow]:
    if folder_id is None and recursive:
        rows = conn.execute("SELECT * FROM bookmarks ORDER BY id").fetchall()
    elif recursive:
        # Collect this folder + all descendants
        ids = {folder_id}
        stack = [folder_id]
        while stack:
            cur_id = stack.pop()
            children = conn.execute("SELECT id FROM folders WHERE parent_id = ?", (cur_id,)).fetchall()
            for c in children:
                ids.add(c["id"])
                stack.append(c["id"])
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT * FROM bookmarks WHERE folder_id IN ({placeholders}) ORDER BY id",
            tuple(ids),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM bookmarks WHERE folder_id IS ? ORDER BY id" if folder_id is None
            else "SELECT * FROM bookmarks WHERE folder_id = ? ORDER BY id",
            (folder_id,) if folder_id is not None else (),
        ).fetchall()
    return [
        BookmarkRow(
            id=r["id"],
            url=r["url"],
            name=r["name"],
            description=r["description"] or "",
            tags=r["tags"] or "",
            folder_path=folder_path_str(conn, r["folder_id"]),
        )
        for r in rows
    ]


def add_bookmark(
    conn: sqlite3.Connection,
    url: str,
    name: str,
    description: str | None,
    tags: str | None,
    folder_path: str | None,
) -> int:
    folder_id: int | None = None
    if folder_path:
        folder_id = ensure_folder(conn, folder_path)
    cur = conn.execute(
        "INSERT INTO bookmarks (folder_id, url, name, description, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (folder_id, url, name, description, tags, now_iso()),
    )
    conn.commit()
    return cur.lastrowid or 0


# ---------- Clipboard / browser ----------

def copy_to_clipboard(text: str) -> str | None:
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


def open_url(url: str) -> None:
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    if not shutil.which(opener):
        sys.exit(f"error: {opener} not found")
    subprocess.run([opener, url], check=False)


# ---------- fzf picker ----------

def fzf_pick(bookmarks: list[BookmarkRow]) -> BookmarkRow | None:
    if not shutil.which("fzf"):
        sys.exit("error: fzf not found (brew install fzf)")
    if not bookmarks:
        return None
    if len(bookmarks) == 1:
        return bookmarks[0]
    lines = [
        f"{b.id}\t{b.name}\t{b.folder_path or '(no folder)'}\t{b.tags}\t{b.url}"
        for b in bookmarks
    ]
    proc = subprocess.run(
        [
            "fzf",
            "--delimiter=\t",
            "--with-nth=2,3,4,5",
            "--height=50%",
            "--reverse",
            "--prompt=pick a bookmark > ",
            "--header=name | folder | tags | url",
        ],
        input="\n".join(lines),
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    chosen_id = int(proc.stdout.split("\t", 1)[0].strip())
    for b in bookmarks:
        if b.id == chosen_id:
            return b
    return None


# ---------- Tree print ----------

def print_tree(conn: sqlite3.Connection, root_path: str | None = None) -> None:
    if root_path:
        root = get_folder_by_path(conn, root_path)
        if root is None:
            sys.exit(f"error: folder '{root_path}' not found")
        _print_folder(conn, root["id"], root["name"], 0)
    else:
        # Top-level folders
        rows = conn.execute("SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name").fetchall()
        for r in rows:
            _print_folder(conn, r["id"], r["name"], 0)
        # Top-level bookmarks (no folder)
        bms = conn.execute("SELECT * FROM bookmarks WHERE folder_id IS NULL ORDER BY id").fetchall()
        for b in bms:
            print(f"  [{b['id']}] {b['name']} — {b['url']}")


def _print_folder(conn: sqlite3.Connection, folder_id: int, name: str, depth: int) -> None:
    indent = "  " * depth
    row = conn.execute("SELECT description FROM folders WHERE id = ?", (folder_id,)).fetchone()
    desc = f"  ({row['description']})" if row and row["description"] else ""
    print(f"{indent}{name}/{desc}")
    children = conn.execute("SELECT * FROM folders WHERE parent_id = ? ORDER BY name", (folder_id,)).fetchall()
    for c in children:
        _print_folder(conn, c["id"], c["name"], depth + 1)
    bms = conn.execute("SELECT * FROM bookmarks WHERE folder_id = ? ORDER BY id", (folder_id,)).fetchall()
    for b in bms:
        tags = f" [{b['tags']}]" if b["tags"] else ""
        print(f"{indent}  [{b['id']}] {b['name']}{tags} — {b['url']}")


# ---------- Find ----------

def plain_find(conn: sqlite3.Connection, query: str) -> list[BookmarkRow]:
    q = f"%{query.lower()}%"
    rows = conn.execute(
        """
        SELECT * FROM bookmarks
        WHERE LOWER(name) LIKE ?
           OR LOWER(IFNULL(description, '')) LIKE ?
           OR LOWER(IFNULL(tags, '')) LIKE ?
           OR LOWER(url) LIKE ?
        ORDER BY id
        """,
        (q, q, q, q),
    ).fetchall()
    return [
        BookmarkRow(
            id=r["id"],
            url=r["url"],
            name=r["name"],
            description=r["description"] or "",
            tags=r["tags"] or "",
            folder_path=folder_path_str(conn, r["folder_id"]),
        )
        for r in rows
    ]


def nlp_find(conn: sqlite3.Connection, query: str, model: str) -> list[BookmarkRow]:
    all_bms = list_bookmarks(conn)
    if not all_bms:
        return []
    payload = [
        {
            "id": b.id,
            "name": b.name,
            "description": b.description,
            "tags": b.tags,
            "folder": b.folder_path,
            "url": b.url,
        }
        for b in all_bms
    ]
    user_msg = f"USER QUERY:\n{query}\n\nBOOKMARKS:\n{json.dumps(payload, ensure_ascii=False)}"
    response = claude_call(SEARCH_SYSTEM, user_msg, SEARCH_SCHEMA, model)
    matches = response.get("matches", [])
    by_id = {b.id: b for b in all_bms}
    return [by_id[m["id"]] for m in matches if m.get("id") in by_id]


# ---------- Commands ----------

def cmd_add(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    url: str | None = args.url
    nl_text: str | None = args.nl

    name = args.name
    description = args.desc
    tags = args.tags
    folder = args.folder

    looks_like_url = url and re.match(r"^https?://", url)

    # If first positional isn't a URL, treat the whole thing as NL.
    if url and not looks_like_url and not nl_text:
        nl_text = url
        url = None

    if nl_text:
        parsed = nl_add(url, nl_text, conn, args.model)
        url = url or parsed.get("url", "").strip()
        name = name or parsed.get("name", "").strip()
        description = description or parsed.get("description", "").strip()
        if not tags:
            tag_list = parsed.get("tags", [])
            tags = ",".join(t.strip() for t in tag_list if t.strip())
        if not folder:
            folder = parsed.get("folder", "").strip() or None
    elif args.auto and url:
        parsed = auto_metadata(url, conn, args.model)
        name = name or parsed.get("name", "").strip()
        description = description or parsed.get("description", "").strip()
        if not tags:
            tag_list = parsed.get("tags", [])
            tags = ",".join(t.strip() for t in tag_list if t.strip())
        if not folder:
            folder = parsed.get("folder", "").strip() or None

    if not url:
        sys.exit("error: no URL provided or detected")
    if not name:
        # fall back to URL host
        name = url

    bm_id = add_bookmark(conn, url, name, description, tags, folder)
    folder_str = folder or "(no folder)"
    print(f"added [{bm_id}] {name} → {folder_str}")
    if description:
        print(f"  desc: {description}")
    if tags:
        print(f"  tags: {tags}")


def cmd_mkdir(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    fid = ensure_folder(conn, args.path, args.desc)
    conn.commit()
    print(f"folder ready: {args.path} (id={fid})")


def cmd_ls(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    print_tree(conn, args.path)


def cmd_find(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    query = " ".join(args.query) if args.query else ""

    if args.fzf and not query:
        # Pure fzf over everything
        bms = list_bookmarks(conn)
    elif args.plain:
        if not query:
            sys.exit("error: --plain needs a query")
        bms = plain_find(conn, query)
    elif query:
        bms = nlp_find(conn, query, args.model)
    else:
        sys.exit("error: provide a query or use --fzf to pick from all")

    if not bms:
        print("(no matches)")
        return

    # --list: just print and exit, no copy/open
    if args.list:
        for b in bms:
            tags = f" [{b.tags}]" if b.tags else ""
            folder = f" @ {b.folder_path}" if b.folder_path else ""
            print(f"[{b.id}] {b.name}{tags}{folder}")
            print(f"  {b.url}")
            if b.description:
                print(f"  {b.description}")
        return

    # Single match → act directly. Multiple → fzf pick (unless --all).
    if len(bms) == 1:
        chosen = bms[0]
    elif args.fzf or len(bms) > 1:
        chosen = fzf_pick(bms)
    else:
        chosen = bms[0]

    if chosen is None:
        print("aborted.", file=sys.stderr)
        return

    if args.print:
        print(chosen.url)
    elif args.open:
        open_url(chosen.url)
        print(f"opened: {chosen.name} — {chosen.url}", file=sys.stderr)
    else:
        tool = copy_to_clipboard(chosen.url)
        if tool:
            print(f"copied: {chosen.name} — {chosen.url}", file=sys.stderr)
        else:
            print("error: no clipboard tool found", file=sys.stderr)
            print(chosen.url)


def cmd_rm(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    target = args.target
    if target.isdigit():
        bm_id = int(target)
        row = conn.execute("SELECT name FROM bookmarks WHERE id = ?", (bm_id,)).fetchone()
        if row is None:
            sys.exit(f"error: bookmark id {bm_id} not found")
        if not args.yes and not _confirm(f"delete bookmark [{bm_id}] {row['name']}? [y/N] "):
            return
        conn.execute("DELETE FROM bookmarks WHERE id = ?", (bm_id,))
        conn.commit()
        print(f"deleted bookmark {bm_id}")
    else:
        folder = get_folder_by_path(conn, target)
        if folder is None:
            sys.exit(f"error: folder '{target}' not found")
        # Count contents
        bm_count = conn.execute(
            "SELECT COUNT(*) FROM bookmarks WHERE folder_id = ?", (folder["id"],)
        ).fetchone()[0]
        sub_count = conn.execute(
            "SELECT COUNT(*) FROM folders WHERE parent_id = ?", (folder["id"],)
        ).fetchone()[0]
        if (bm_count or sub_count) and not args.yes:
            if not _confirm(
                f"folder '{target}' contains {bm_count} bookmark(s) and {sub_count} subfolder(s). delete? [y/N] "
            ):
                return
        conn.execute("DELETE FROM folders WHERE id = ?", (folder["id"],))
        conn.commit()
        print(f"deleted folder {target}")


def cmd_mv(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    bm_id = int(args.id)
    row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", (bm_id,)).fetchone()
    if row is None:
        sys.exit(f"error: bookmark id {bm_id} not found")
    folder_id = ensure_folder(conn, args.folder) if args.folder else None
    conn.execute("UPDATE bookmarks SET folder_id = ? WHERE id = ?", (folder_id, bm_id))
    conn.commit()
    print(f"moved [{bm_id}] {row['name']} → {args.folder or '(no folder)'}")


def cmd_edit(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    bm_id = int(args.id)
    row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", (bm_id,)).fetchone()
    if row is None:
        sys.exit(f"error: bookmark id {bm_id} not found")
    fields = []
    values: list = []
    if args.name is not None:
        fields.append("name = ?")
        values.append(args.name)
    if args.desc is not None:
        fields.append("description = ?")
        values.append(args.desc)
    if args.tags is not None:
        fields.append("tags = ?")
        values.append(args.tags)
    if args.url is not None:
        fields.append("url = ?")
        values.append(args.url)
    if not fields:
        sys.exit("error: nothing to update (use --name/--desc/--tags/--url)")
    values.append(bm_id)
    conn.execute(f"UPDATE bookmarks SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    print(f"updated [{bm_id}]")


def cmd_export(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    folders = [
        {
            "id": r["id"],
            "parent_id": r["parent_id"],
            "name": r["name"],
            "description": r["description"],
            "created_at": r["created_at"],
        }
        for r in conn.execute("SELECT * FROM folders ORDER BY id").fetchall()
    ]
    bookmarks = [
        {
            "id": r["id"],
            "folder_id": r["folder_id"],
            "url": r["url"],
            "name": r["name"],
            "description": r["description"],
            "tags": r["tags"],
            "created_at": r["created_at"],
        }
        for r in conn.execute("SELECT * FROM bookmarks ORDER BY id").fetchall()
    ]
    payload = {"folders": folders, "bookmarks": bookmarks}
    out = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(out)
        print(f"exported to {args.out}")
    else:
        print(out)


def cmd_import(args: argparse.Namespace, conn: sqlite3.Connection) -> None:
    raw = Path(args.file).read_text() if args.file else sys.stdin.read()
    payload = json.loads(raw)
    id_map: dict[int, int] = {}
    # Insert folders breadth-first so parents exist before children
    folders = payload.get("folders", [])
    remaining = list(folders)
    while remaining:
        progress = False
        next_round = []
        for f in remaining:
            parent = f.get("parent_id")
            if parent is None or parent in id_map:
                new_parent = id_map.get(parent) if parent is not None else None
                cur = conn.execute(
                    "INSERT INTO folders (parent_id, name, description, created_at) VALUES (?, ?, ?, ?)",
                    (new_parent, f["name"], f.get("description"), f.get("created_at") or now_iso()),
                )
                id_map[f["id"]] = cur.lastrowid or 0
                progress = True
            else:
                next_round.append(f)
        remaining = next_round
        if not progress:
            sys.exit("error: import has folder cycles or missing parents")
    for b in payload.get("bookmarks", []):
        new_folder = id_map.get(b.get("folder_id")) if b.get("folder_id") else None
        conn.execute(
            "INSERT INTO bookmarks (folder_id, url, name, description, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (new_folder, b["url"], b["name"], b.get("description"), b.get("tags"), b.get("created_at") or now_iso()),
        )
    conn.commit()
    print(f"imported {len(folders)} folders and {len(payload.get('bookmarks', []))} bookmarks")


# ---------- helpers ----------

def _confirm(prompt: str) -> bool:
    try:
        ans = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return ans in ("y", "yes")


# ---------- argparse ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pin",
        description="A CLI bookmark manager with Claude-powered NLP add and search.",
    )
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite DB path (default: {DEFAULT_DB} or $PIN_DB)")
    p.add_argument("--model", default="sonnet", help="Claude model (default: sonnet)")

    sub = p.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="add a bookmark")
    p_add.add_argument("url", help="URL, OR (if no URL) a natural-language description containing one")
    p_add.add_argument("nl", nargs="?", help="optional natural-language description (Claude infers name/desc/tags/folder)")
    p_add.add_argument("--name", help="bookmark name")
    p_add.add_argument("--desc", help="description")
    p_add.add_argument("--tags", help="comma-separated tags")
    p_add.add_argument("--folder", help="folder path (created if missing)")
    p_add.add_argument("--auto", action="store_true", help="fetch URL and let Claude generate name/desc/tags/folder")
    p_add.set_defaults(func=cmd_add)

    p_mkdir = sub.add_parser("mkdir", help="create a folder (nested paths ok)")
    p_mkdir.add_argument("path", help="folder path, e.g. dev/python")
    p_mkdir.add_argument("--desc", help="folder description")
    p_mkdir.set_defaults(func=cmd_mkdir)

    p_ls = sub.add_parser("ls", help="list folders and bookmarks as a tree")
    p_ls.add_argument("path", nargs="?", help="optional folder path to limit the tree")
    p_ls.set_defaults(func=cmd_ls)

    p_find = sub.add_parser("find", help="find bookmarks (NLP by default; copies single match to clipboard)")
    p_find.add_argument("query", nargs="*", help="search query (omit with --fzf to pick from all)")
    p_find.add_argument("--plain", action="store_true", help="literal substring match instead of NLP")
    p_find.add_argument("--fzf", action="store_true", help="force fzf picker even on a single match")
    p_find.add_argument("--print", action="store_true", help="print URL instead of copying to clipboard")
    p_find.add_argument("--open", action="store_true", help="open in browser instead of copying")
    p_find.add_argument("--list", action="store_true", help="show all matches and exit (no copy/open)")
    p_find.set_defaults(func=cmd_find)

    p_rm = sub.add_parser("rm", help="delete a bookmark (by id) or folder (by path)")
    p_rm.add_argument("target", help="bookmark id or folder path")
    p_rm.add_argument("-y", "--yes", action="store_true", help="skip confirmation")
    p_rm.set_defaults(func=cmd_rm)

    p_mv = sub.add_parser("mv", help="move a bookmark to another folder")
    p_mv.add_argument("id", help="bookmark id")
    p_mv.add_argument("folder", help="destination folder path (created if missing); use '' to clear folder")
    p_mv.set_defaults(func=cmd_mv)

    p_edit = sub.add_parser("edit", help="edit bookmark fields")
    p_edit.add_argument("id", help="bookmark id")
    p_edit.add_argument("--name")
    p_edit.add_argument("--desc")
    p_edit.add_argument("--tags")
    p_edit.add_argument("--url")
    p_edit.set_defaults(func=cmd_edit)

    p_export = sub.add_parser("export", help="export everything to JSON")
    p_export.add_argument("--out", help="write to file instead of stdout")
    p_export.set_defaults(func=cmd_export)

    p_import = sub.add_parser("import", help="import JSON (from --file or stdin)")
    p_import.add_argument("--file", help="JSON file path (default: stdin)")
    p_import.set_defaults(func=cmd_import)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    conn = get_db(args.db)
    try:
        args.func(args, conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
