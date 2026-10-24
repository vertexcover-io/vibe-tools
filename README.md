# vibe-tools

A collection of small utilities — Python scripts, Bash scripts, HTML/JS pages — built entirely via prompts, skills, and coding agents. Every line of text and code was written by an LLM.

Inspired by [simonw/tools](https://github.com/simonw/tools) and [vertexcover-io/research](https://github.com/vertexcover-io/research).

Each tool lives in its own folder with a `README.md` (what it does, how to run it) and a `PROMPT.md` (the prompt used to generate it). See [AGENTS.md](AGENTS.md) for conventions.

*Times shown are in UTC.*

<!--[[[cog
import os
import subprocess
import pathlib
from datetime import datetime, timezone

MODEL = "github/gpt-4.1"

root = pathlib.Path.cwd()
tools_with_dates = []

for d in root.iterdir():
    if not d.is_dir() or d.name.startswith('.'):
        continue
    if not (d / "README.md").exists():
        continue
    try:
        result = subprocess.run(
            ['git', 'log', '-1', '--format=%aI', '--', d.name],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            commit_date = datetime.fromisoformat(result.stdout.strip().replace('Z', '+00:00'))
            tools_with_dates.append((d.name, commit_date))
        else:
            tools_with_dates.append((d.name, datetime.fromtimestamp(d.stat().st_mtime, tz=timezone.utc)))
    except Exception:
        tools_with_dates.append((d.name, datetime.fromtimestamp(d.stat().st_mtime, tz=timezone.utc)))

print(f"## {len(tools_with_dates)} tools\n")

tools_with_dates.sort(key=lambda x: x[1], reverse=True)

github_url = None
try:
    result = subprocess.run(
        ['git', 'remote', 'get-url', 'origin'],
        capture_output=True, text=True, timeout=2
    )
    if result.returncode == 0 and result.stdout.strip():
        origin = result.stdout.strip()
        if origin.startswith('git@github.com:'):
            origin = origin.replace('git@github.com:', 'https://github.com/')
        if origin.endswith('.git'):
            origin = origin[:-4]
        github_url = origin
except Exception:
    pass

for dirname, commit_date in tools_with_dates:
    folder_path = root / dirname
    readme_path = folder_path / "README.md"
    summary_path = folder_path / "_summary.md"

    date_formatted = commit_date.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M')

    title = dirname
    if readme_path.exists():
        with open(readme_path, 'r') as f:
            for line in f:
                if line.startswith('# '):
                    title = line[2:].strip()
                    break

    if github_url:
        print(f"### [{title}]({github_url}/tree/master/{dirname}#readme) ({date_formatted})\n")
    else:
        print(f"### {title} ({date_formatted})\n")

    if summary_path.exists():
        with open(summary_path, 'r') as f:
            description = f.read().strip()
            print(description if description else "*No description available.*")
    elif readme_path.exists():
        prompt = "Summarize what this tool does in 1-2 sentences maximum. Be concrete about what it does, not how it was built. No emoji, no marketing language, no opening like 'This tool'."
        try:
            result = subprocess.run(
                ['llm', '-m', MODEL, '-s', prompt],
                stdin=open(readme_path),
                capture_output=True, text=True, timeout=60
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            import sys
            print(f"*No description available — llm invocation failed ({e}).*")
            sys.stderr.write(f"warning: llm unavailable for {dirname}: {e}\n")
            print()
            continue

        if result.returncode != 0 or not result.stdout.strip():
            import sys
            stderr_excerpt = (result.stderr or '').strip().splitlines()[-1] if result.stderr else ''
            sys.stderr.write(
                f"warning: llm summary generation failed for {dirname} "
                f"(rc={result.returncode}): {stderr_excerpt}\n"
            )
            print("*No description available — auto-summary unavailable.*")
        else:
            description = result.stdout.strip()
            print(description)
            with open(summary_path, 'w') as f:
                f.write(description + '\n')
    else:
        print("*No description available.*")

    print()

]]]-->
## 12 tools

### [gdrive-open](https://github.com/vertexcover-io/vibe-tools/tree/master/gdrive-open#readme) (2026-10-24 12:28)

*No description available — auto-summary unavailable.*

### [ccpack](https://github.com/vertexcover-io/vibe-tools/tree/master/ccpack#readme) (2026-10-10 04:35)

Picks a Claude Code session from an fzf list with a readable conversation preview and zips it, or serves the same picker and transcripts as a local web UI with a download button.

### [linkedin-to-notion](https://github.com/vertexcover-io/vibe-tools/tree/master/linkedin-to-notion#readme) (2026-10-10 04:35)

Chrome extension that clips LinkedIn profiles into a Notion database, from the profile page or by right-clicking a name in any list, capturing name, URL, headline, company, title and location while blocking duplicates by normalized profile URL.

### [electron-mod](https://github.com/vertexcover-io/vibe-tools/tree/master/electron-mod#readme) (2026-10-10 04:35)

Inspects, patches, repacks and re-signs any installed Electron app on macOS, handling asar integrity and fuse checks, stable self-signed identities so logins persist, and auto-update neutering; a companion slash command plans and self-tests the mod with Claude.

### [hn-hiring-classifier](https://github.com/vertexcover-io/vibe-tools/tree/master/hn-hiring-classifier#readme) (2026-10-10 04:35)

Classifies an "Ask HN: Who is hiring?" post, job page, or pasted text into 16 structured fields (work mode, region, salary bucket, company stage, job functions, and more) in a single call to TypeSafe's Jev model.

### [video-lens](https://github.com/vertexcover-io/vibe-tools/tree/master/video-lens#readme) (2026-10-10 04:35)

Fetches a YouTube video's timestamped transcript and caches it locally so it can be read, searched, sliced by time range, or summarized; also ships as a Claude Code skill that answers questions from the transcript.

### [browser-flows](https://github.com/vertexcover-io/vibe-tools/tree/master/browser-flows#readme) (2026-10-10 04:35)

Records a browser task once through a Chrome extension that captures clicks, typing and spoken narration, converts it into a JSON flow with named inputs, and replays it later through Claude in Chrome with fast deterministic steps and model-driven recovery only when a step breaks.

### [granola-cli](https://github.com/vertexcover-io/vibe-tools/tree/master/granola-cli#readme) (2026-10-10 04:35)

Command-line access to Granola meeting notes and transcripts through its private API: filter meetings by name, attendee, date or folder, then print the transcript or AI notes, authenticating from the local desktop app's session file.

### [hiring-triage](https://github.com/vertexcover-io/vibe-tools/tree/master/hiring-triage#readme) (2026-10-10 04:35)

Keyboard-driven local web app for triaging job applicants stored in a Notion database: it lists candidates for a position by status, shows score, notes, links and resume side by side, and accepts, parks or rejects each with one key, sending a rejection email through Gmail.

### [spawn-claude](https://github.com/vertexcover-io/vibe-tools/tree/master/spawn-claude#readme) (2026-10-10 04:35)

Launches another Claude Code session from the command line with pluggable surface (tmux, cmux, Ghostty, Terminal.app or headless), mode (interactive or headless), and starting context (fresh, parent-session summary, or forked transcript).

### [pin](https://github.com/vertexcover-io/vibe-tools/tree/master/pin#readme) (2026-05-02 12:10)

A SQLite-backed CLI bookmark manager with nested folders, tags, and Claude-powered natural-language add/search — describe a bookmark in English and Claude fetches the page, infers metadata, and files it; search by intent ("that ml paper about attention") and the matched URL goes straight to the clipboard.

### [aibash](https://github.com/vertexcover-io/vibe-tools/tree/master/aibash#readme) (2026-05-02 12:10)

Translates an English description into a concrete bash command using the Claude CLI, with the current directory's file listing passed as context so requests like "delete the largest file" resolve to real filenames. Optionally copies the result to the clipboard or executes it after a confirmation prompt.

<!--[[[end]]]-->

---

## Updating this README

This README uses [cogapp](https://nedbatchelder.com/code/cog/) to auto-generate the tool list and short summaries.

A GitHub Action runs `cog -r -P README.md` on every push to `master` and commits any updates.

To regenerate locally:

```bash
pip install -r requirements.txt
cog -r -P README.md
```

To regenerate a specific tool's summary, delete its `_summary.md` file and re-run cog.
