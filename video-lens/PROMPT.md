# Prompt log

Model/agent: Claude Code (Opus 4.8, 1M context).

## Origin

User asked to install [kar2phi/video-lens](https://github.com/kar2phi/video-lens),
using `uv` for Python deps. That upstream project is a **report-first** Claude Code
skill (URL → sanitized HTML report + a gallery browser, ~1700 lines across 7
scripts). Through clarification the actual use case turned out to be
**transcript-first**:

> "the entire use of this skill is to be able to fetch video, then read transcript,
> search area in video that talks about a particular thing, get transcript from a
> particular section etc. Report is not the most critical; mostly it's summary, and
> summary should be more like I can decide the level of it."

## Design decisions

- **Vendor into this repo as one tool**, not install upstream into dotfiles.
- **Single script** (`video-lens.py`) with subcommands, replacing 7 upstream scripts.
- **Dropped**: upstream's 640-line sanitizing renderer and 1976-line template
  (most of which existed to support an embedded YouTube player + local web
  server), the local web server (`serve_report.sh`), the whole
  `video-lens-gallery` skill (report-library browser), and the Whisper local
  fallback (`transcribe_local.py`, needs mlx-whisper + ffmpeg).

## Follow-up: report + dedup re-added

The user later asked to add back an HTML report, dedup detection via a local
cache, and a template — but explicitly **no local web server**. Built fresh
rather than vendoring upstream's heavy pipeline:

- **Compact `template.html`** (~110 lines): clean magazine layout, thumbnail +
  "Watch on YouTube" link instead of an embedded player, opens directly via
  `file://` with no server and no `file://`-nag overlays. `{{PLACEHOLDER}}`
  substitution. The agent supplies `SUMMARY`/`KEY_POINTS`/`TAKEAWAY`/`OUTLINE`
  as HTML fragments (trusted content — light escaping only on title/meta).
- **`report` subcommand** renders to `~/.cache/video-lens/reports/`.
- **Dedup** via `~/.cache/video-lens/reports.json` (video_id → path/title/date).
  `report` refuses to overwrite an existing report unless `--force`; `check`
  reports DUPLICATE/NEW. Chosen over upstream's folder-globbing.
- **Kept & merged** from upstream: URL→id extraction and language mapping (from
  `preflight.py`), and the transcript fetch with its robust youtube-transcript-api
  error mapping + HTML metadata scrape (from `fetch_transcript.py`).
- **PEP 723 + `uv run`** so deps are self-contained and nothing touches the
  system / conda base. `uv tool install` was rejected because the scripts need the
  libs *importable*, not as CLIs; `--system` was rejected to avoid polluting the
  base env.
- **Search & summarize are the agent's job**, not the script's. The script fetches
  and caches the timestamped transcript; the LLM reads it to search, answer, and
  summarize. Summary depth is conversational ("tldr" → "full report"), not a code
  path.
- **Caching** to `~/.cache/video-lens/<id>.json` so `segment` after `transcript`
  and repeat questions are instant/offline.

## Verification

Smoke-tested against a real video: `transcript` (cold fetch via uv), `segment`
(cache hit, window filtering), `meta` (youtu.be short link), and error paths
(`SHORTS_NOT_SUPPORTED`, `INVALID_INPUT`).
