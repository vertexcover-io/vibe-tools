# video-lens

A transcript-first toolkit for YouTube videos. Fetch a video's timestamped
transcript once, then read it, search it, pull a time-range, answer questions, or
summarize at any depth — all in conversation. No HTML report, no local server, no
saved-report gallery: the transcript is the product.

Vendored and simplified from [kar2phi/video-lens](https://github.com/kar2phi/video-lens)
(MIT), which is report-first; this strips it down to the transcript core.

## Run

The script is self-contained via [PEP 723](https://peps.python.org/pep-0723/) — `uv`
resolves `youtube-transcript-api` into an ephemeral cached env, nothing is installed
system-wide. Needs [`uv`](https://docs.astral.sh/uv/).

```bash
uv run video-lens.py transcript "https://www.youtube.com/watch?v=VIDEO_ID"
uv run video-lens.py segment VIDEO_ID --start 8:00 --end 12:00
uv run video-lens.py meta youtu.be/VIDEO_ID
```

- `transcript <url-or-id> [--lang en] [--refresh]` — full timestamped transcript + metadata.
- `segment <url-or-id> --start MM:SS [--end MM:SS] [--lang en]` — just that time window.
- `meta <url-or-id>` — metadata only (title, channel, views, duration).
- `report <url-or-id> --payload-file P.json [--force]` — render a self-contained
  HTML report (opens via `file://`, no web server). The payload supplies
  `SUMMARY`, `KEY_POINTS`, `TAKEAWAY`, `OUTLINE` as HTML fragments.
- `check <url-or-id>` — has a report already been generated for this video?

Accepts watch URLs, `youtu.be` short links, or a bare 11-char id. Transcripts are
cached at `~/.cache/video-lens/<id>.json`; repeat calls are instant. `--refresh`
bypasses the cache. Reports are written to `~/.cache/video-lens/reports/` and
indexed in `reports.json`, so re-running `report` for the same video is detected
as a duplicate (pass `--force` to re-render).

## As a Claude Code (or other agent) skill

`SKILL.md` drives the agent to fetch the transcript and then search / answer /
summarize from it. Install separately by copying this folder into a skills dir,
e.g. `~/.claude/skills/video-lens/`.

## Notes

- Searching and summarizing are done by the agent reading the transcript — the
  script only fetches and renders. Summary depth is conversational ("tldr" → "full report").
- The optional HTML report is a single `file://`-openable page (compact template,
  thumbnail + watch link, no embedded player, no local web server).
- No Whisper fallback: videos without fetchable captions report `NO_TRANSCRIPT`.
- YouTube Shorts are not supported.
