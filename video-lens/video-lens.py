#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["youtube-transcript-api>=0.6.3"]
# ///
"""video-lens: a transcript-first toolkit for YouTube videos.

The script's only job is to fetch a video's timestamped transcript (and light
metadata) and serve it — optionally just a time-window of it. Searching the
transcript, answering questions from it, and summarizing it at whatever depth
you want are done by the calling agent reading this output, not by code here.

Subcommands:
    transcript <url-or-id> [--lang en]   full timestamped transcript + metadata
    segment    <url-or-id> --start MM:SS --end MM:SS   just that time window
    meta       <url-or-id>               metadata only (no transcript)
    report     <url-or-id> --payload-file P.json   render a self-contained HTML report
    check      <url-or-id>               is there already a report for this video?

A fetched transcript is cached under ~/.cache/video-lens/<id>.json so repeat
calls (segment after transcript, re-asking later) are instant and offline.
Rendered reports are written to ~/.cache/video-lens/reports/ and indexed in
reports.json so a second `report` for the same video is detected (dedup).
"""
import argparse
import datetime
import html as html_lib
import json
import pathlib
import re
import sys
import urllib.request
from urllib.parse import parse_qs, urlparse

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CACHE_DIR = pathlib.Path.home() / ".cache" / "video-lens"
REPORTS_DIR = CACHE_DIR / "reports"
REPORTS_INDEX = CACHE_DIR / "reports.json"
TEMPLATE = pathlib.Path(__file__).resolve().parent / "template.html"

REPORT_KEYS = ("SUMMARY", "KEY_POINTS", "TAKEAWAY", "OUTLINE")

LANGUAGE_MAP = {
    "english": "en", "spanish": "es", "french": "fr", "german": "de",
    "japanese": "ja", "portuguese": "pt", "italian": "it",
    "chinese": "zh", "korean": "ko", "russian": "ru",
}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
YOUTUBE_SHORT_HOSTS = {"youtu.be", "www.youtu.be"}


def extract_video_id(raw: str) -> tuple[str, str | None]:
    """Return (video_id, error_code). error_code is None on success."""
    raw = raw.strip()
    if VIDEO_ID_RE.fullmatch(raw):
        return raw, None

    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw.lstrip("/")

    parsed = urlparse(raw)
    host = parsed.netloc.lower()
    if "/shorts/" in parsed.path:
        return "", "SHORTS_NOT_SUPPORTED"

    if host in YOUTUBE_SHORT_HOSTS:
        candidate = parsed.path.strip("/").split("/", 1)[0]
    elif host in YOUTUBE_HOSTS:
        if parsed.path == "/watch":
            candidate = (parse_qs(parsed.query).get("v") or [""])[0]
        elif parsed.path.startswith("/embed/") or parsed.path.startswith("/live/"):
            parts = parsed.path.strip("/").split("/", 2)
            candidate = parts[1] if len(parts) >= 2 else ""
        else:
            return "", "INVALID_INPUT"
    else:
        return "", "INVALID_INPUT"

    if VIDEO_ID_RE.fullmatch(candidate):
        return candidate, None
    return "", "INVALID_INPUT"


def map_language(raw: str) -> str:
    raw = raw.strip().lower()
    return LANGUAGE_MAP.get(raw, raw) if raw else ""


def parse_timestamp(raw: str) -> int:
    """Parse 'M:SS', 'MM:SS', 'H:MM:SS', or a bare seconds int into seconds."""
    raw = raw.strip()
    if raw.isdigit():
        return int(raw)
    parts = raw.split(":")
    if not all(p.isdigit() for p in parts) or not 2 <= len(parts) <= 3:
        raise ValueError(f"bad timestamp: {raw!r} (use M:SS, MM:SS, or H:MM:SS)")
    nums = [int(p) for p in parts]
    while len(nums) < 3:
        nums.insert(0, 0)
    h, m, s = nums
    return h * 3600 + m * 60 + s


def format_timestamp(total_s: int) -> str:
    h, rem = divmod(int(total_s), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h > 0 else f"{m}:{s:02d}"


def fetch_html_metadata(video_id: str) -> dict:
    try:
        req = urllib.request.Request(
            f"https://www.youtube.com/watch?v={video_id}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8", errors="ignore")
    except Exception:
        return {}

    def grp(pattern: str) -> str:
        m = re.search(pattern, html)
        return m.group(1) if m else ""

    title = grp(r"<title>([^<]+)</title>").replace(" - YouTube", "").strip()
    channel = grp(r'"channelName"\s*:\s*"([^"]+)"')

    published = ""
    pub = grp(r'"publishDate"\s*:\s*"([^"]+)"')
    if pub:
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        y, mo, d = pub[:10].split("-")
        published = f"{months[int(mo) - 1]} {int(d)} {y}"

    views = ""
    vc = grp(r'"viewCount"\s*:\s*"([0-9]+)"')
    if vc:
        v = int(vc)
        views = (f"{v / 1e6:.1f}M views" if v >= 1e6
                 else f"{v / 1e3:.0f}K views" if v >= 1e3
                 else f"{v} views")

    duration = ""
    dur = grp(r'"lengthSeconds"\s*:\s*"([0-9]+)"')
    if dur:
        h, rem = divmod(int(dur), 3600)
        m = rem // 60
        duration = f"{h}h {m}m" if h > 0 else f"{m} min"

    return {"title": title, "channel": channel, "published": published,
            "views": views, "duration": duration}


def fetch_transcript(video_id: str, lang_pref: str) -> dict:
    """Fetch transcript + metadata. Raises SystemExit with a mapped error code."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        sys.exit("ERROR:LIBRARY_MISSING youtube-transcript-api not installed")

    def opt(*names):
        import youtube_transcript_api as m
        return tuple(getattr(m, n, None) for n in names)

    (TranscriptsDisabled, VideoUnavailable, NoTranscriptFound, InvalidVideoId,
     AgeRestricted, IpBlocked, RequestBlocked, PoTokenRequired,
     YouTubeRequestFailed) = opt(
        "TranscriptsDisabled", "VideoUnavailable", "NoTranscriptFound",
        "InvalidVideoId", "AgeRestricted", "IpBlocked", "RequestBlocked",
        "PoTokenRequired", "YouTubeRequestFailed")

    try:
        try:
            tlist = YouTubeTranscriptApi().list(video_id)
        except (AttributeError, TypeError):
            tlist = YouTubeTranscriptApi.list_transcripts(video_id)
    except Exception as e:
        error_map = [
            (TranscriptsDisabled, "ERROR:CAPTIONS_DISABLED"),
            (AgeRestricted, "ERROR:AGE_RESTRICTED"),
            (VideoUnavailable, "ERROR:VIDEO_UNAVAILABLE"),
            (InvalidVideoId, "ERROR:INVALID_VIDEO_ID"),
            (IpBlocked, "ERROR:IP_BLOCKED"),
            (RequestBlocked, "ERROR:REQUEST_BLOCKED"),
            (PoTokenRequired, "ERROR:PO_TOKEN_REQUIRED"),
            (NoTranscriptFound, "ERROR:NO_TRANSCRIPT"),
            (YouTubeRequestFailed, "ERROR:NETWORK_ERROR"),
        ]
        code = "ERROR:TRANSCRIPT_FETCH_FAILED"
        for cls, mapped in error_map:
            if cls is not None and isinstance(e, cls):
                code = mapped
                break
        sys.exit(f"{code}: {e}")

    transcript_obj = _pick_transcript(tlist, lang_pref)
    lang_warn = ""
    if lang_pref and transcript_obj.language_code != lang_pref:
        lang_warn = f'Requested "{lang_pref}" unavailable; using {transcript_obj.language_code}'

    try:
        raw = transcript_obj.fetch()
    except Exception as e:
        sys.exit(f"ERROR:TRANSCRIPT_FETCH_FAILED {type(e).__name__}: {e}")

    use_dict = bool(raw) and isinstance(raw[0], dict)
    segments = [
        {"start": float(s["start"] if use_dict else s.start),
         "text": (s["text"] if use_dict else s.text).strip()}
        for s in raw
    ]

    meta = fetch_html_metadata(video_id)
    return {
        "video_id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "lang": transcript_obj.language_code,
        "lang_warn": lang_warn,
        "fetched": datetime.date.today().isoformat(),
        "meta": meta,
        "segments": segments,
    }


def _pick_transcript(tlist, lang_pref: str):
    def native(t):
        return not getattr(t, "is_translation", False)

    if lang_pref:
        for t in tlist:
            if t.language_code == lang_pref and native(t):
                return t
        for t in tlist:
            if t.language_code == lang_pref:
                return t
    for t in tlist:
        if native(t):
            return t
    return next(iter(tlist))


def load_or_fetch(video_id: str, lang_pref: str, refresh: bool) -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{video_id}.json"
    if cache_file.exists() and not refresh:
        try:
            data = json.loads(cache_file.read_text())
            if not lang_pref or data.get("lang") == lang_pref:
                return data
        except (json.JSONDecodeError, OSError):
            pass
    data = fetch_transcript(video_id, lang_pref)
    cache_file.write_text(json.dumps(data))
    return data


def render(data: dict, start: int | None = None, end: int | None = None) -> str:
    meta = data.get("meta") or {}
    header = [
        f"TITLE: {meta.get('title') or 'YouTube video ' + data['video_id']}",
        f"CHANNEL: {meta.get('channel', '')}",
        f"PUBLISHED: {meta.get('published', '')}",
        f"VIEWS: {meta.get('views', '')}",
        f"DURATION: {meta.get('duration', '')}",
        f"URL: {data['url']}",
        f"LANG: {data['lang']}",
    ]
    if data.get("lang_warn"):
        header.append(f"LANG_WARN: {data['lang_warn']}")

    body = []
    for s in data["segments"]:
        st = s["start"]
        if start is not None and st < start:
            continue
        if end is not None and st > end:
            break
        body.append(f"[{format_timestamp(st)}] {s['text']}")

    if start is not None or end is not None:
        span = f"{format_timestamp(start or 0)}–{format_timestamp(end) if end is not None else 'end'}"
        header.append(f"SEGMENT: {span} ({len(body)} lines)")
    return "\n".join(header + [""] + body)


def resolve(raw: str) -> str:
    video_id, err = extract_video_id(raw)
    if err == "SHORTS_NOT_SUPPORTED":
        sys.exit("ERROR:SHORTS_NOT_SUPPORTED YouTube Shorts are not supported")
    if err:
        sys.exit(f"ERROR:INVALID_INPUT could not extract video id from {raw!r}")
    return video_id


def load_index() -> dict:
    if REPORTS_INDEX.exists():
        try:
            return json.loads(REPORTS_INDEX.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def existing_report(video_id: str) -> dict | None:
    entry = load_index().get(video_id)
    if entry and pathlib.Path(entry["path"]).exists():
        return entry
    return None


def record_report(video_id: str, path: pathlib.Path, title: str) -> None:
    index = load_index()
    index[video_id] = {
        "path": str(path),
        "title": title,
        "generated": datetime.date.today().isoformat(),
    }
    REPORTS_INDEX.write_text(json.dumps(index, indent=2))


def render_report(data: dict, payload: dict) -> pathlib.Path:
    meta = data.get("meta") or {}
    title = meta.get("title") or payload.get("VIDEO_TITLE") or f"YouTube video {data['video_id']}"
    meta_bits = [b for b in (meta.get("channel"), meta.get("published"),
                             meta.get("views"), meta.get("duration")) if b]

    values = {
        "VIDEO_ID": data["video_id"],
        "VIDEO_URL": data["url"],
        "VIDEO_TITLE": html_lib.escape(title),
        "META_LINE": html_lib.escape(" · ".join(meta_bits)),
        "THUMB": f"https://img.youtube.com/vi/{data['video_id']}/hqdefault.jpg",
        "GENERATED": datetime.date.today().isoformat(),
        "SUMMARY": payload.get("SUMMARY", ""),
        "KEY_POINTS": payload.get("KEY_POINTS", ""),
        "TAKEAWAY": payload.get("TAKEAWAY", ""),
        "OUTLINE": payload.get("OUTLINE", ""),
    }

    template = TEMPLATE.read_text(encoding="utf-8")
    for key, val in values.items():
        template = template.replace("{{" + key + "}}", str(val))

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    safe_title = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or "report"
    out = REPORTS_DIR / f"{safe_title}-{data['video_id']}.html"
    out.write_text(template, encoding="utf-8")
    record_report(data["video_id"], out, title)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcript-first YouTube toolkit")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_t = sub.add_parser("transcript", help="full timestamped transcript + metadata")
    p_t.add_argument("url")
    p_t.add_argument("--lang", default="")
    p_t.add_argument("--refresh", action="store_true", help="ignore cache, re-fetch")

    p_s = sub.add_parser("segment", help="transcript for a time window only")
    p_s.add_argument("url")
    p_s.add_argument("--start", default="0")
    p_s.add_argument("--end", default="")
    p_s.add_argument("--lang", default="")
    p_s.add_argument("--refresh", action="store_true")

    p_m = sub.add_parser("meta", help="metadata only, no transcript")
    p_m.add_argument("url")

    p_r = sub.add_parser("report", help="render a self-contained HTML report")
    p_r.add_argument("url")
    p_r.add_argument("--payload-file", required=True,
                     help="JSON with SUMMARY, KEY_POINTS, TAKEAWAY, OUTLINE (HTML fragments)")
    p_r.add_argument("--force", action="store_true", help="re-render even if one exists")
    p_r.add_argument("--lang", default="")

    p_c = sub.add_parser("check", help="is there already a report for this video?")
    p_c.add_argument("url")

    args = parser.parse_args()
    video_id = resolve(args.url)

    if args.cmd == "meta":
        meta = fetch_html_metadata(video_id)
        print(json.dumps({"video_id": video_id, **meta}, indent=2))
        return

    if args.cmd == "check":
        entry = existing_report(video_id)
        if entry:
            print(f"DUPLICATE: {entry['path']}")
            print(f"TITLE: {entry['title']}")
            print(f"GENERATED: {entry['generated']}")
        else:
            print("NEW: no existing report for this video")
        return

    if args.cmd == "report":
        if not args.force:
            entry = existing_report(video_id)
            if entry:
                print(f"DUPLICATE: {entry['path']}")
                print("A report already exists; pass --force to re-render.")
                return
        try:
            payload = json.loads(pathlib.Path(args.payload_file).expanduser().read_text())
        except (json.JSONDecodeError, OSError) as e:
            sys.exit(f"ERROR:PAYLOAD_INVALID {e}")
        missing = [k for k in REPORT_KEYS if not str(payload.get(k, "")).strip()]
        if missing:
            sys.exit(f"ERROR:PAYLOAD_INCOMPLETE missing/empty: {', '.join(missing)}")
        data = load_or_fetch(video_id, map_language(args.lang), refresh=False)
        out = render_report(data, payload)
        print(f"REPORT: {out}")
        print(f"OPEN: file://{out}")
        return

    lang = map_language(args.lang)
    data = load_or_fetch(video_id, lang, args.refresh)

    if args.cmd == "transcript":
        print(render(data))
        return

    start = parse_timestamp(args.start)
    end = parse_timestamp(args.end) if args.end else None
    print(render(data, start=start, end=end))


if __name__ == "__main__":
    main()
