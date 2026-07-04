# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "rich"]
# ///
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import httpx
from rich.console import Console
from rich.table import Table

SUPABASE_PATH = Path.home() / "Library/Application Support/Granola/supabase.json"
API = "https://api.granola.ai"
REFRESH_URL = f"{API}/v1/refresh-access-token"
console = Console()
err = Console(stderr=True)


def die(msg: str, code: int = 1) -> None:
    err.print(f"[red]ERROR:[/red] {msg}")
    sys.exit(code)


def load_refresh_token() -> str:
    if not SUPABASE_PATH.exists():
        die(f"supabase.json not found at {SUPABASE_PATH} — is Granola installed and signed in?")
    raw = json.loads(SUPABASE_PATH.read_text())
    wt = raw.get("workos_tokens")
    if not wt:
        die("no workos_tokens in supabase.json")
    tokens = json.loads(wt) if isinstance(wt, str) else wt
    rt = tokens.get("refresh_token")
    if not rt:
        die("no refresh_token in supabase.json")
    return rt


def mint_access_token(client: httpx.Client) -> str:
    resp = client.post(REFRESH_URL, json={"refresh_token": load_refresh_token()})
    if resp.status_code != 200:
        die(f"refresh failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()["access_token"]


@dataclass
class Granola:
    client: httpx.Client
    token: str

    @classmethod
    def connect(cls) -> "Granola":
        client = httpx.Client(timeout=40.0)
        return cls(client=client, token=mint_access_token(client))

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        resp = self.client.post(
            f"{API}/{path}",
            json=body,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        if resp.status_code != 200:
            die(f"{path} failed ({resp.status_code}): {resp.text[:200]}")
        return resp.json()

    def documents(self, limit: int = 500, list_id: str | None = None) -> list[dict[str, Any]]:
        body: dict[str, Any] = {"limit": limit}
        if list_id:
            body["list_id"] = list_id
        return self._post("v2/get-documents", body).get("docs", [])

    def transcript(self, document_id: str) -> list[dict[str, Any]]:
        return self._post("v1/get-document-transcript", {"document_id": document_id})

    def panels(self, document_id: str) -> list[dict[str, Any]]:
        return self._post("v1/get-document-panels", {"document_id": document_id})

    def folders(self) -> dict[str, dict[str, Any]]:
        return self._post("v1/get-document-lists-metadata", {}).get("lists", {})


# ---------- document helpers ----------

def doc_when(doc: dict[str, Any]) -> datetime | None:
    gcal = doc.get("google_calendar_event") or {}
    start = (gcal.get("start") or {}).get("dateTime")
    stamp = start or doc.get("created_at")
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None


def doc_attendees(doc: dict[str, Any]) -> list[dict[str, str]]:
    people = doc.get("people") or {}
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(name: str | None, email: str | None) -> None:
        key = (email or name or "").lower()
        if not key or key in seen:
            return
        seen.add(key)
        out.append({"name": name or "", "email": email or ""})

    creator = people.get("creator") or {}
    add(creator.get("name"), creator.get("email"))
    for a in people.get("attendees") or []:
        add(a.get("name"), a.get("email"))
    gcal = doc.get("google_calendar_event") or {}
    for a in gcal.get("attendees") or []:
        add(a.get("displayName"), a.get("email"))
    return out


def matches_person(doc: dict[str, Any], needle: str) -> bool:
    n = needle.lower()
    return any(n in (a["name"] + " " + a["email"]).lower() for a in doc_attendees(doc))


def matches_name(doc: dict[str, Any], needle: str) -> bool:
    return needle.lower() in (doc.get("title") or "").lower()


# ---------- date parsing ----------

def parse_day(s: str) -> tuple[date, date]:
    """Return (start, end) inclusive day bounds for a natural date token."""
    today = datetime.now().date()
    s = s.strip().lower()
    presets = {
        "today": today,
        "yesterday": today - timedelta(days=1),
        "tomorrow": today + timedelta(days=1),
    }
    if s in presets:
        d = presets[s]
        return d, d
    if s in ("this week", "week"):
        start = today - timedelta(days=today.weekday())
        return start, start + timedelta(days=6)
    if s == "last week":
        start = today - timedelta(days=today.weekday() + 7)
        return start, start + timedelta(days=6)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            d = datetime.strptime(s, fmt).date()
            return d, d
        except ValueError:
            continue
    die(f"could not parse date: {s!r} (use today/yesterday/YYYY-MM-DD/'last week')")
    raise AssertionError


def in_day_range(doc: dict[str, Any], bounds: tuple[date, date]) -> bool:
    when = doc_when(doc)
    if not when:
        return False
    d = when.astimezone().date()
    return bounds[0] <= d <= bounds[1]


def resolve_folder(g: Granola, name: str) -> tuple[str, str]:
    folders = g.folders()
    matches = [(fid, f) for fid, f in folders.items() if name.lower() in (f.get("title") or "").lower()]
    if not matches:
        avail = ", ".join(sorted(f.get("title", "") for f in folders.values()))
        die(f"no folder matching {name!r}. Available: {avail}")
    matches.sort(key=lambda m: len(m[1].get("title", "")))
    return matches[0][0], matches[0][1].get("title", "")


# ---------- output ----------

def fmt_when(doc: dict[str, Any]) -> str:
    when = doc_when(doc)
    return when.astimezone().strftime("%Y-%m-%d %H:%M") if when else "?"


def print_docs(docs: list[dict[str, Any]], show_ids: bool = True) -> None:
    if not docs:
        console.print("[yellow]No matching meetings.[/yellow]")
        return
    table = Table(show_lines=False)
    table.add_column("When", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold")
    table.add_column("Attendees", style="dim")
    if show_ids:
        table.add_column("ID", style="dim")
    for doc in docs:
        names = ", ".join(a["name"] or a["email"] for a in doc_attendees(doc)[:4])
        row = [fmt_when(doc), doc.get("title") or "(untitled)", names]
        if show_ids:
            row.append(doc.get("id", ""))
        table.add_row(*row)
    console.print(table)


def sort_docs(docs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(docs, key=lambda d: doc_when(d) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)


def find_doc(g: Granola, doc_id_or_query: str) -> dict[str, Any]:
    docs = g.documents()
    for d in docs:
        if d.get("id") == doc_id_or_query:
            return d
    hits = [d for d in docs if matches_name(d, doc_id_or_query)]
    if not hits:
        die(f"no meeting matching {doc_id_or_query!r}")
    return sort_docs(hits)[0]


# ---------- transcript rendering ----------

def render_transcript(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    last_speaker = None
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        speaker = seg.get("detected_speaker_name") or seg.get("source") or "Speaker"
        ts = seg.get("start_timestamp")
        stamp = ""
        if isinstance(ts, (int, float)):
            stamp = f"[{int(ts // 60)}:{int(ts % 60):02d}] "
        if speaker != last_speaker:
            lines.append(f"\n{speaker}:")
            last_speaker = speaker
        lines.append(f"  {stamp}{text}")
    return "\n".join(lines).strip()


def render_notes(doc: dict[str, Any], panels: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    md = doc.get("notes_markdown")
    if md:
        parts.append("# Notes\n\n" + md.strip())
    for panel in panels:
        content = panel.get("content")
        title = panel.get("title") or "Panel"
        if isinstance(content, str) and content.strip():
            parts.append(f"# {title}\n\n{content.strip()}")
        elif isinstance(content, dict):
            text = _prosemirror_text(content)
            if text.strip():
                parts.append(f"# {title}\n\n{text.strip()}")
    return "\n\n".join(parts).strip() or "(no notes available)"


def _prosemirror_text(node: Any) -> str:
    if isinstance(node, dict):
        if node.get("type") == "text":
            return node.get("text", "")
        return "".join(_prosemirror_text(c) for c in node.get("content", []))
    if isinstance(node, list):
        return "".join(_prosemirror_text(c) for c in node)
    return ""


# ---------- commands ----------

def cmd_list(g: Granola, args: dict[str, Any]) -> None:
    docs = g.documents(list_id=args.get("folder_id"))
    if args.get("name"):
        docs = [d for d in docs if matches_name(d, args["name"])]
    if args.get("person"):
        docs = [d for d in docs if matches_person(d, args["person"])]
    if args.get("day"):
        docs = [d for d in docs if in_day_range(d, args["day"])]
    docs = sort_docs(docs)
    if args.get("limit"):
        docs = docs[: args["limit"]]
    if args.get("json"):
        console.print_json(data=[_doc_summary(d) for d in docs])
    else:
        print_docs(docs)


def _doc_summary(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": doc.get("id"),
        "title": doc.get("title"),
        "when": fmt_when(doc),
        "attendees": doc_attendees(doc),
    }


def cmd_folders(g: Granola, args: dict[str, Any]) -> None:
    folders = g.folders()
    if args.get("json"):
        console.print_json(data=[{"id": fid, "title": f.get("title")} for fid, f in folders.items()])
        return
    table = Table()
    table.add_column("Folder", style="bold")
    table.add_column("ID", style="dim")
    for fid, f in sorted(folders.items(), key=lambda kv: kv[1].get("title", "")):
        table.add_row(f.get("title") or "(untitled)", fid)
    console.print(table)


def cmd_transcript(g: Granola, args: dict[str, Any]) -> None:
    doc = find_doc(g, args["target"])
    segments = g.transcript(doc["id"])
    header = f"# {doc.get('title')}  ({fmt_when(doc)})\n"
    if args.get("json"):
        console.print_json(data=segments)
    else:
        console.print(header)
        console.print(render_transcript(segments))


def cmd_notes(g: Granola, args: dict[str, Any]) -> None:
    doc = find_doc(g, args["target"])
    panels = g.panels(doc["id"])
    console.print(f"# {doc.get('title')}  ({fmt_when(doc)})\n")
    console.print(render_notes(doc, panels))


def cmd_get(g: Granola, args: dict[str, Any]) -> None:
    """Resolve a natural query to one meeting, print its metadata + how to load it."""
    docs = g.documents(list_id=args.get("folder_id"))
    if args.get("name"):
        docs = [d for d in docs if matches_name(d, args["name"])]
    if args.get("person"):
        docs = [d for d in docs if matches_person(d, args["person"])]
    if args.get("day"):
        docs = [d for d in docs if in_day_range(d, args["day"])]
    docs = sort_docs(docs)
    if not docs:
        die("no meeting matched those filters")
    if args.get("json"):
        console.print_json(data=[_doc_summary(d) for d in docs])
        return
    if len(docs) > 1:
        console.print(f"[yellow]{len(docs)} meetings matched — showing best (most recent) first:[/yellow]")
    print_docs(docs[:10])
    top = docs[0]
    console.print(
        f"\n[green]Best match:[/green] {top.get('title')} ({fmt_when(top)})\n"
        f"Load it:  transcript {top['id']}  |  notes {top['id']}"
    )


# ---------- arg parsing ----------

def parse_args(argv: list[str]) -> tuple[str, dict[str, Any]]:
    if not argv:
        die("usage: granola-cli <list|get|transcript|notes|folders> [options]")
    cmd = argv[0]
    rest = argv[1:]
    args: dict[str, Any] = {}
    positional: list[str] = []
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in ("--name", "-n"):
            args["name"] = rest[i + 1]
            i += 2
        elif tok in ("--person", "--with", "-p"):
            args["person"] = rest[i + 1]
            i += 2
        elif tok in ("--day", "--date", "-d"):
            args["day"] = parse_day(rest[i + 1])
            i += 2
        elif tok in ("--folder", "--project", "-f"):
            args["_folder_name"] = rest[i + 1]
            i += 2
        elif tok in ("--limit", "-l"):
            args["limit"] = int(rest[i + 1])
            i += 2
        elif tok == "--json":
            args["json"] = True
            i += 1
        else:
            positional.append(tok)
            i += 1
    if positional:
        args["target"] = " ".join(positional)
    return cmd, args


def main() -> None:
    cmd, args = parse_args(sys.argv[1:])
    g = Granola.connect()
    if "_folder_name" in args:
        fid, title = resolve_folder(g, args["_folder_name"])
        args["folder_id"] = fid
        if not args.get("json"):
            err.print(f"[dim]folder: {title}[/dim]")
    handlers = {
        "list": cmd_list,
        "ls": cmd_list,
        "get": cmd_get,
        "find": cmd_get,
        "transcript": cmd_transcript,
        "notes": cmd_notes,
        "folders": cmd_folders,
    }
    handler = handlers.get(cmd)
    if not handler:
        die(f"unknown command {cmd!r}. Use: list, get, transcript, notes, folders")
    handler(g, args)


if __name__ == "__main__":
    main()
