# Conventions for ai-experiments

This repo is a flat collection of small utilities — Python scripts, Bash scripts, HTML/JS pages — built entirely via prompts, skills, and coding agents. Every line of code and text was written by an LLM.

Inspired by [simonw/tools](https://github.com/simonw/tools) and [vertexcover-io/research](https://github.com/vertexcover-io/research).

## Folder layout

- One folder per tool, at the repo root (no language-based subdirectories).
- Folder name: kebab-case, descriptive of what the tool does (e.g. `csv-to-json`, `color-picker`).
- The main script inside the folder shares the same name as the folder, with the language extension (e.g. `csv-to-json/csv-to-json.py`).
- Do not name scripts `main.py` or `index.html` — the script name should reflect the tool itself.

## Required files per tool

Each tool folder must contain:

- `README.md` — what the tool does and how to run it. Keep it short.
- `PROMPT.md` — the prompt(s) used to generate the tool, plus the model/agent used. Capture iterations if the tool went through multiple prompt revisions.
- The script itself.

## Python tools

- Standalone scripts using [`uv run`](https://docs.astral.sh/uv/guides/scripts/) with [PEP 723 inline metadata](https://peps.python.org/pep-0723/) — no `requirements.txt`, no venv.
- Use type hints on all functions.

Example header:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "rich"]
# ///
```

## HTML tools

- Single-file `.html` with inline CSS and JS — runnable by opening directly in a browser.
- Vanilla JS only — no frameworks, no build steps, no bundlers. CDN imports are fine for single libraries when truly needed.

## Bash tools

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.

## Top-level README

The top-level `README.md` is auto-generated and lists every tool with a short summary. Do not edit the generated section by hand — edit the tool's own `README.md` instead.

## Commit conventions

- One commit per tool addition.
- The commit MUST include the tool's `PROMPT.md` alongside the script and `README.md`. The prompt is part of the artifact.
- Commit message format: `add <tool-name>: <one-line description>`.
