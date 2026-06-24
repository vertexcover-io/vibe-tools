---
name: video-lens
description: >
  Fetch a YouTube video's transcript and work with it in conversation — read it,
  search for where the video talks about a topic, pull the transcript for a
  specific time range, answer questions from it, or summarize at any depth the
  user asks for ("tldr", "bullets", "detailed", "full report"). Trigger on a
  YouTube URL plus any of: "transcript", "what does this video say about…",
  "summarize this video", "where do they talk about…", "what's said around 12:00".
license: MIT
allowed-tools: Bash Read
metadata:
  author: vibe-tools (vendored & simplified from kar2phi/video-lens)
  version: "1.0"
---

# video-lens

A transcript-first toolkit. The script fetches and caches a video's timestamped
transcript; **you** (the agent) do the reading, searching, Q&A, and summarizing.
There is no report-rendering, no local web server, no saved-report library — those
were dropped on purpose. The transcript in the conversation is the product.

## The script

`video-lens.py` lives beside this file. Run it with `uv run` (PEP 723 — deps are
self-contained, nothing is installed system-wide). Locate it:

```bash
SKILL_DIR=$(for d in ~/.agents ~/.claude ~/.copilot ~/.gemini ~/.cursor ~/.windsurf ~/.opencode ~/.codex; do
  [ -f "$d/skills/video-lens/video-lens.py" ] && echo "$d/skills/video-lens" && break
done)
[ -z "$SKILL_DIR" ] && echo "video-lens not installed into a skills dir" && exit 1
```

Subcommands:

- `uv run "$SKILL_DIR/video-lens.py" transcript <url-or-id> [--lang en] [--refresh]`
  — full timestamped transcript + metadata header.
- `uv run "$SKILL_DIR/video-lens.py" segment <url-or-id> --start MM:SS [--end MM:SS] [--lang en]`
  — only the transcript inside that time window.
- `uv run "$SKILL_DIR/video-lens.py" meta <url-or-id>` — metadata only (title,
  channel, views, duration), no transcript.
- `uv run "$SKILL_DIR/video-lens.py" report <url-or-id> --payload-file P.json [--force]`
  — render a self-contained HTML report (opens via `file://`, no server). The
  payload JSON you write supplies `SUMMARY`, `KEY_POINTS`, `TAKEAWAY`, `OUTLINE`
  as HTML fragments. Title/metadata/thumbnail come from the fetched data.
- `uv run "$SKILL_DIR/video-lens.py" check <url-or-id>` — is there already a
  report for this video? Prints `DUPLICATE: <path>` or `NEW`.

Accepts full watch URLs, `youtu.be/...` short links, or a bare 11-char video id.
The first `transcript`/`segment` for a video fetches and caches it under
`~/.cache/video-lens/<id>.json`; later calls are instant and offline. Use
`--refresh` to bypass the cache.

## How to handle requests

Always fetch the transcript once with `transcript`, then act on it in conversation:

- **"Get the transcript" / "read me the transcript"** — run `transcript`, present it.
- **"What does it say about X?" / "where do they discuss X?"** — run `transcript`,
  find the relevant lines yourself, and answer **citing the `[M:SS]` timestamps**
  so the user can jump there. Don't shell out for search — you read it directly.
- **"What's said around 12:00?" / a section** — use `segment --start 11:30 --end 13:00`
  to pull just that window.
- **"Summarize this"** — summarize at the depth the user implies. Default to a
  short summary + a handful of key points with timestamps. Honor explicit depth:
  - *tldr / one line* → a single sentence.
  - *bullets / key points* → 4–8 timestamped bullets.
  - *detailed / notes* → sectioned notes following the video's structure.
  - *full report* → a thorough write-up with outline and takeaways.
  When unsure of the depth, ask or give a short version and offer to go deeper.
- **"Make a report" / "generate an HTML report"** — first run `check <url>`; if it
  prints `DUPLICATE`, tell the user a report already exists at that path and ask
  whether to open it or re-render with `--force`. Otherwise write a payload JSON
  with `SUMMARY`, `KEY_POINTS`, `TAKEAWAY`, `OUTLINE` as HTML fragments (use
  `<a class="ts" href="…&t=NNNs">[M:SS]</a>` for timestamp links inside key points
  and outline), then run `report <url> --payload-file <path>`. Give the user the
  `OPEN: file://…` path. Reports go to `~/.cache/video-lens/reports/`.

## Errors

The script prints a single `ERROR:<CODE> ...` line and exits non-zero. Common codes:
`CAPTIONS_DISABLED`, `NO_TRANSCRIPT`, `AGE_RESTRICTED`, `VIDEO_UNAVAILABLE`,
`SHORTS_NOT_SUPPORTED`, `IP_BLOCKED`/`REQUEST_BLOCKED` (YouTube rate-limiting),
`INVALID_INPUT`. Relay the meaning plainly; for `NO_TRANSCRIPT`/`CAPTIONS_DISABLED`
tell the user this video has no fetchable captions.

## Faithfulness

When summarizing or answering, preserve the creator's stance and emphasis. Cite
timestamps. Do not invent content that isn't in the transcript.
