# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Record a browser flow with narration, store it as a replayable JSON flow, and render it for replay.

    browser-flows.py probe                         is the Chrome extension installed and talking?
    browser-flows.py record --url URL --out DIR    collect clicks, typing and speech until Stop
    browser-flows.py list                          every stored flow with its inputs (reads flows/index.json)
    browser-flows.py show NAME                     one flow, inputs and steps, human readable
    browser-flows.py index                         rebuild flows/index.json from flows/*.json
    browser-flows.py render NAME --input k=v ...   JS for one chunk (--chunk N), or --dry-run, or --chunks
    browser-flows.py fix NAME STEP --selector S    prepend a working selector (and/or --optional) after a recovery

The recorder runs inside the person's own Chrome through ``extension/``; this process is only the
sink on 127.0.0.1:9335. Replay is a chunk of ``player.js`` pasted into Claude in Chrome.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

JsonDict = Dict[str, Any]

PORT = 9335  # also in extension/background.js, offscreen.js, start.js
DEFAULT_LANG = "en-US"
HERE = Path(__file__).resolve().parent
FLOWS = HERE / "flows"
INDEX = FLOWS / "index.json"
PLAYER = HERE / "player.js"
STEP_TYPES = ("navigate", "click", "fill", "change", "press", "wait_for", "wait")

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Google", "Chrome", "Application", "chrome.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
)
CHROME_COMMANDS = ("google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser")


# ---------------------------------------------------------------- recording


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


class Session:
    def __init__(self, *, audio_path: Path, start_url: str, lang: str) -> None:
        self.start_url = start_url
        self.lang = lang
        self.events: List[JsonDict] = []
        self.transcript: List[Segment] = []
        self.stopped = False
        self.pinged = False
        self._audio = audio_path.open("wb")

    def on_event(self, payload: JsonDict) -> None:
        self.events.append(payload if payload.get("type") == "navigate" else dict(payload, selectors=candidate_selectors(payload)))

    def on_speech(self, payload: JsonDict) -> None:
        self.transcript.append(Segment(float(payload["start"]), float(payload["end"]), text(payload, "text")))

    def on_audio(self, chunk: bytes) -> None:
        self._audio.write(chunk)

    def on_stop(self, *_args: object) -> None:
        self.stopped = True

    def status(self) -> JsonDict:
        return {"events": len(self.events), "start_url": self.start_url, "lang": self.lang}

    def close(self) -> None:
        self._audio.close()


class Handler(BaseHTTPRequestHandler):
    session: Session

    def do_GET(self) -> None:
        self.session.pinged = True
        self.reply(self.session.status())

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        routes = {"/audio": lambda: self.session.on_audio(body), "/event": lambda: self.session.on_event(json.loads(body)),
                  "/speech": lambda: self.session.on_speech(json.loads(body)), "/stop": self.session.on_stop}
        handler = routes.get(self.path)
        if handler:
            handler()
        self.reply({"ok": True})

    def reply(self, body: JsonDict) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def text(payload: JsonDict, key: str) -> str:
    value = payload.get(key)
    return value.strip() if isinstance(value, str) else ""


def candidate_selectors(ev: JsonDict) -> List[str]:
    """Ordered selectors player.js understands, most stable first. Claude trims this list per step."""
    testid, ident, name, role, label = (text(ev, k) for k in ("testid", "id", "name", "role", "label"))
    placeholder, body, xpath, tag = (text(ev, k) for k in ("placeholder", "text", "xpath", "tag"))
    out: List[str] = []
    if testid:
        out.append(f'css:[data-testid="{testid}"],[data-qa="{testid}"],[data-test="{testid}"],[data-cy="{testid}"]')
    if ident and not ident[0].isdigit() and not any(c.isdigit() for c in ident[-3:]):
        out.append(f"css:#{ident}")
    if name and tag in ("input", "select", "textarea"):
        out.append(f'css:{tag}[name="{name}"]')
    is_field = tag in ("input", "select", "textarea")
    if is_field and (placeholder or label):
        out.append(f"label:{placeholder or label}")
    if not is_field and 'aria-label="' in text(ev, "html") and label:
        out.append(f'css:{tag}[aria-label="{label}"]')
    if not is_field and (body or label) and len(body or label) < 60:
        out.append(f"text:{body or label}")
    if xpath:
        out.append(f"xpath:{xpath}")
    return list(dict.fromkeys(out))


def event_line(ev: JsonDict) -> str:
    kind = text(ev, "type")
    if kind == "navigate":
        return f"navigate {text(ev, 'url')}"
    sels = " | ".join(ev.get("selectors", []))
    where = f"<{text(ev, 'tag')}> {text(ev, 'label') or text(ev, 'text')!r}  selectors: {sels}"
    if kind == "click":
        return f"click {where}"
    if kind == "press":
        return f"press {text(ev, 'key')} on {where}"
    return f"{kind} {text(ev, 'value')!r} into {where}"


def clock(seconds: float) -> str:
    return f"[{int(seconds) // 60:02d}:{int(seconds) % 60:02d}]"


def timeline(start_url: str, started_at: float, events: Sequence[JsonDict], transcript: Sequence[Segment]) -> str:
    speech = [(s.start, f'said: "{s.text}"') for s in transcript]
    actions = [(float(ev.get("t", 0)) / 1000, event_line(ev)) for ev in events]
    lines = [f"{clock(t - started_at)} {line}" for t, line in sorted(speech + actions, key=lambda x: x[0])]
    return f"# Recording of {start_url}\n\n" + "\n".join(lines) + "\n"


def find_chrome(explicit: Optional[str]) -> Optional[str]:
    found = [c for c in (explicit, *(shutil.which(cmd) for cmd in CHROME_COMMANDS), *CHROME_CANDIDATES) if c and Path(c).exists()]
    return found[0] if found else None


def open_site(chrome: Optional[str], url: str) -> None:
    if chrome is None:
        print(f"Chrome not found; open {url} yourself and press Start in the Flow recorder panel.", file=sys.stderr)
        return
    subprocess.Popen([chrome, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def serve_until_stopped(session: Session) -> None:
    signal.signal(signal.SIGINT, session.on_stop)
    Handler.session = session
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    server.timeout = 0.5
    while not session.stopped:
        server.handle_request()
    server.server_close()


def probe(chrome: Optional[str], timeout_s: float = 20) -> bool:
    session = Session(audio_path=Path(os.devnull), start_url="", lang=DEFAULT_LANG)
    Handler.session = session
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    server.timeout = 0.5
    open_site(chrome, "https://example.com/")
    deadline = time.time() + timeout_s
    while not session.pinged and time.time() < deadline:
        server.handle_request()
    server.server_close()
    session.close()
    return session.pinged


def cmd_record(args: argparse.Namespace) -> int:
    out = args.out or HERE / ".recordings" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    session = Session(audio_path=out / "audio.webm", start_url=args.url, lang=args.lang)
    started_at = time.time()
    if not args.no_open:
        open_site(find_chrome(args.chrome), args.url)
    print("Press Start in the Flow recorder panel on the page. Stop there when done, or Ctrl+C here.", file=sys.stderr)
    serve_until_stopped(session)
    session.close()
    (out / "recording.json").write_text(json.dumps({"start_url": args.url, "started_at": started_at, "events": session.events,
                                                    "transcript": [s.__dict__ for s in session.transcript]}, indent=2))
    (out / "timeline.md").write_text(timeline(args.url, started_at, session.events, session.transcript))
    print(out / "timeline.md")
    return 0


# ---------------------------------------------------------------- flows


def flow_path(name: str) -> Path:
    return FLOWS / f"{name}.json"


def load_flow(name: str) -> JsonDict:
    path = flow_path(name)
    if not path.exists():
        sys.exit(f"no flow named {name!r}; run `browser-flows.py list`")
    return json.loads(path.read_text())


def save_flow(flow: JsonDict) -> None:
    flow_path(flow["name"]).write_text(json.dumps(flow, indent=2, ensure_ascii=False) + "\n")


def validate(flow: JsonDict) -> List[str]:
    problems = [f"missing {k}" for k in ("name", "description", "start_url", "inputs", "steps") if k not in flow]
    ids = [s.get("id") for s in flow.get("steps", [])]
    if len(ids) != len(set(ids)):
        problems.append("duplicate step ids")
    for s in flow.get("steps", []):
        if s.get("type") not in STEP_TYPES:
            problems.append(f"step {s.get('id')}: bad type {s.get('type')!r}")
        if s.get("type") not in ("navigate", "wait") and not s.get("selectors"):
            problems.append(f"step {s.get('id')}: no selectors")
    return problems


def index_entry(flow: JsonDict) -> JsonDict:
    return {"name": flow["name"], "description": flow["description"], "start_url": flow["start_url"],
            "inputs": {k: v.get("description", "") for k, v in flow["inputs"].items()},
            "steps": len(flow["steps"]), "updated": flow.get("updated", "")}


def cmd_index(_args: argparse.Namespace) -> int:
    entries = []
    for path in sorted(FLOWS.glob("*.json")):
        if path.name == "index.json":
            continue
        flow = json.loads(path.read_text())
        problems = validate(flow)
        if problems:
            print(f"{path.name}: " + "; ".join(problems), file=sys.stderr)
            continue
        entries.append(index_entry(flow))
    INDEX.write_text(json.dumps({"flows": entries}, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(entries)} flows indexed -> {INDEX}")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    entries = json.loads(INDEX.read_text())["flows"] if INDEX.exists() else []
    if not entries:
        print("no flows yet")
        return 0
    for e in entries:
        inputs = ", ".join(e["inputs"]) or "none"
        print(f"{e['name']}: {e['description']}\n    url: {e['start_url']}\n    inputs: {inputs}")
    return 0


def resolve(value: str, inputs: Dict[str, str]) -> str:
    for k, v in inputs.items():
        value = value.replace("{{" + k + "}}", v)
    return value


def missing_inputs(flow: JsonDict, given: Dict[str, str]) -> List[str]:
    return [k for k, spec in flow["inputs"].items() if k not in given and spec.get("required", True) and "default" not in spec]


def filled_inputs(flow: JsonDict, given: Dict[str, str]) -> Dict[str, str]:
    defaults = {k: str(spec["default"]) for k, spec in flow["inputs"].items() if "default" in spec}
    return {**defaults, **given}


def resolved_steps(flow: JsonDict, inputs: Dict[str, str]) -> List[JsonDict]:
    out = []
    for s in flow["steps"]:
        step = dict(s)
        for key in ("value", "url"):
            if isinstance(step.get(key), str):
                step[key] = resolve(step[key], inputs)
        out.append(step)
    return out


def chunks(steps: Sequence[JsonDict]) -> Iterator[Tuple[Optional[str], List[JsonDict]]]:
    """Split at every page change: a navigate step opens a chunk, a step marked navigates ends one."""
    url: Optional[str] = None
    current: List[JsonDict] = []
    for s in steps:
        if s["type"] == "navigate":
            if current or url:
                yield url, current
            url, current = s["url"], []
            continue
        current.append(s)
        if s.get("navigates"):
            yield url, current
            url, current = None, []
    if current or url:
        yield url, current


def step_line(s: JsonDict) -> str:
    kind = s["type"]
    flag = " (optional)" if s.get("optional") else ""
    if kind == "navigate":
        return f"{s['id']:>3}. open {s['url']}"
    if kind == "wait":
        return f"{s['id']:>3}. wait {s.get('ms', 1000)}ms"
    what = s.get("desc") or (s.get("selectors") or [""])[0]
    if kind == "click":
        return f"{s['id']:>3}. click {what}{flag}"
    if kind == "press":
        return f"{s['id']:>3}. press {s['key']} on {what}{flag}"
    if kind == "wait_for":
        return f"{s['id']:>3}. wait for {what}{flag}"
    return f"{s['id']:>3}. {kind} {s.get('value')!r} into {what}{flag}"


def cmd_show(args: argparse.Namespace) -> int:
    flow = load_flow(args.name)
    print(f"{flow['name']}: {flow['description']}\nstart: {flow['start_url']}\n\ninputs:")
    for k, spec in flow["inputs"].items():
        req = "required" if spec.get("required", True) and "default" not in spec else f"default={spec.get('default')!r}"
        print(f"  {k}: {spec.get('description', '')} ({req}; e.g. {spec.get('example', '')!r})")
    print("\nsteps:")
    for s in flow["steps"]:
        print(step_line(s))
    return 0


def parse_inputs(pairs: Sequence[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for p in pairs:
        if "=" not in p:
            sys.exit(f"--input wants k=v, got {p!r}")
        k, v = p.split("=", 1)
        out[k] = v
    return out


def cmd_render(args: argparse.Namespace) -> int:
    flow = load_flow(args.name)
    given = parse_inputs(args.input)
    missing = missing_inputs(flow, given)
    if missing:
        print(json.dumps({"missing_inputs": {k: flow["inputs"][k] for k in missing}}, indent=2))
        return 3
    steps = resolved_steps(flow, filled_inputs(flow, given))
    parts = list(chunks(steps))
    if args.chunks:
        print(json.dumps([{"chunk": i, "url": u, "steps": [s["id"] for s in ss]} for i, (u, ss) in enumerate(parts)], indent=2))
        return 0
    if args.dry_run:
        for i, (url, ss) in enumerate(parts):
            print(f"-- chunk {i}" + (f": open {url}" if url else ": same page"))
            for s in ss:
                print(step_line(s))
        return 0
    if args.chunk is None or not 0 <= args.chunk < len(parts):
        sys.exit(f"--chunk must be 0..{len(parts) - 1} (or use --chunks / --dry-run)")
    url, ss = parts[args.chunk]
    if url:
        print(f"// navigate to: {url}")
    print(f"const STEPS = {json.dumps(ss, ensure_ascii=False)};")
    print(PLAYER.read_text().split("\n", 1)[1])
    return 0


def cmd_fix(args: argparse.Namespace) -> int:
    flow = load_flow(args.name)
    step = next((s for s in flow["steps"] if s["id"] == args.step), None)
    if step is None:
        sys.exit(f"no step {args.step} in {args.name}")
    if args.selector:
        step["selectors"] = [args.selector] + [s for s in step.get("selectors", []) if s != args.selector]
    if args.optional:
        step["optional"] = True
    if args.navigates:
        step["navigates"] = True
    flow["updated"] = time.strftime("%Y-%m-%d")
    save_flow(flow)
    cmd_index(args)
    print(step_line(step))
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    installed = probe(find_chrome(args.chrome))
    print("extension: installed" if installed else "extension: NOT installed (or Chrome did not open the probe page)")
    return 0 if installed else 1


def parse(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--chrome")
    p.set_defaults(fn=cmd_probe)
    p = sub.add_parser("record")
    p.add_argument("--url", required=True)
    p.add_argument("--out", type=Path)
    p.add_argument("--lang", default=DEFAULT_LANG)
    p.add_argument("--chrome")
    p.add_argument("--no-open", action="store_true")
    p.set_defaults(fn=cmd_record)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    sub.add_parser("index").set_defaults(fn=cmd_index)
    p = sub.add_parser("show")
    p.add_argument("name")
    p.set_defaults(fn=cmd_show)
    p = sub.add_parser("render")
    p.add_argument("name")
    p.add_argument("--input", action="append", default=[], metavar="K=V")
    p.add_argument("--chunk", type=int)
    p.add_argument("--chunks", action="store_true", help="list chunks and their step ids")
    p.add_argument("--dry-run", action="store_true", help="print resolved steps, touch nothing")
    p.set_defaults(fn=cmd_render)
    p = sub.add_parser("fix")
    p.add_argument("name")
    p.add_argument("step", type=int)
    p.add_argument("--selector")
    p.add_argument("--optional", action="store_true")
    p.add_argument("--navigates", action="store_true")
    p.set_defaults(fn=cmd_fix)
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
