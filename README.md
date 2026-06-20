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
## 4 tools

### [electron-mod](https://github.com/vertexcover-io/vibe-tools/tree/master/electron-mod#readme) (2026-06-19 19:04)

*No description available — auto-summary unavailable.*

### [spawn-claude](https://github.com/vertexcover-io/vibe-tools/tree/master/spawn-claude#readme) (2026-06-19 17:59)

*No description available — auto-summary unavailable.*

### [aibash](https://github.com/vertexcover-io/vibe-tools/tree/master/aibash#readme) (2026-05-02 12:10)

Translates an English description into a concrete bash command using the Claude CLI, with the current directory's file listing passed as context so requests like "delete the largest file" resolve to real filenames. Optionally copies the result to the clipboard or executes it after a confirmation prompt.

### [pin](https://github.com/vertexcover-io/vibe-tools/tree/master/pin#readme) (2026-05-02 12:10)

A SQLite-backed CLI bookmark manager with nested folders, tags, and Claude-powered natural-language add/search — describe a bookmark in English and Claude fetches the page, infers metadata, and files it; search by intent ("that ml paper about attention") and the matched URL goes straight to the clipboard.

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
