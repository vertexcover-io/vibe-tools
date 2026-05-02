# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate a Docusaurus blog post (.mdx) for a vibe-tools tool folder.

Usage:
    uv run scripts/generate_blog_post.py --tool aibash --out ../vertexcover-io.github.com/tools

Reads <tool>/README.md and <tool>/_summary.md from the repo root, derives the
first-commit date from git, and writes <YYYY-MM-DD>-<tool>.mdx into --out.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_URL = "https://github.com/vertexcover-io/vibe-tools"
DEFAULT_AUTHOR = "ritesh"
DEFAULT_TAGS = ["tools"]


def git_first_commit_date(tool_dir: Path) -> datetime:
    """Return the date of the first commit that touched this tool's folder."""
    result = subprocess.run(
        ["git", "log", "--diff-filter=A", "--format=%aI", "--", tool_dir.name],
        capture_output=True,
        text=True,
        cwd=tool_dir.parent,
        check=True,
    )
    lines = [line for line in result.stdout.strip().splitlines() if line]
    if not lines:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(lines[-1].replace("Z", "+00:00"))


def read_summary(tool_dir: Path) -> str:
    summary = tool_dir / "_summary.md"
    return summary.read_text().strip() if summary.exists() else ""


def read_readme_body(tool_dir: Path) -> str:
    """Read README.md and strip the leading '# title' heading."""
    readme = tool_dir / "README.md"
    if not readme.exists():
        return ""
    text = readme.read_text()
    return re.sub(r"\A#\s+[^\n]+\n+", "", text, count=1).strip()


def infer_tags(tool: str, extra: list[str]) -> list[str]:
    tags = list(DEFAULT_TAGS)
    body = (Path(tool) / "README.md").read_text().lower() if (Path(tool) / "README.md").exists() else ""
    if "claude" in body or "anthropic" in body:
        tags.append("claude")
    if "bash" in tool.lower():
        tags.append("bash")
    if "cli" in body or "command-line" in body or "command line" in body:
        tags.append("cli")
    if "bookmark" in tool.lower() or "bookmark" in body:
        tags.append("bookmarks")
    for t in extra:
        if t and t not in tags:
            tags.append(t)
    return tags


def render_post(tool: str, summary: str, body: str, date: datetime, tags: list[str], author: str) -> str:
    date_iso = date.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    tldr_block = (
        "import TLDR from '@site/src/components/TLDR';\n\n"
        f"<TLDR>\n\n{summary}\n\n</TLDR>\n\n"
        if summary
        else ""
    )
    source = f"{REPO_URL}/tree/master/{tool}"
    footer = f"\n\n---\n\n*Source: [{source.replace('https://', '')}]({source})*\n"
    tags_yaml = ", ".join(tags)
    return (
        "---\n"
        f"slug: {tool}\n"
        f"title: {tool}\n"
        f"date: {date_iso}\n"
        f"authors: [{author}]\n"
        f"tags: [{tags_yaml}]\n"
        "draft: false\n"
        "---\n\n"
        f"{tldr_block}"
        f"{body}"
        f"{footer}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool", required=True, help="Tool folder name (e.g. 'aibash')")
    parser.add_argument("--out", required=True, type=Path, help="Output directory for the .mdx file")
    parser.add_argument("--author", default=DEFAULT_AUTHOR, help="Author key from authors.yml")
    parser.add_argument("--tag", action="append", default=[], help="Extra tag (repeatable)")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd(), help="vibe-tools repo root")
    args = parser.parse_args()

    tool_dir = args.repo_root / args.tool
    if not tool_dir.is_dir():
        print(f"error: {tool_dir} is not a directory", file=sys.stderr)
        return 1
    if not (tool_dir / "README.md").exists():
        print(f"error: {tool_dir}/README.md missing", file=sys.stderr)
        return 1

    summary = read_summary(tool_dir)
    body = read_readme_body(tool_dir)
    date = git_first_commit_date(tool_dir)
    tags = infer_tags(args.tool, args.tag)

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / f"{date.strftime('%Y-%m-%d')}-{args.tool}.mdx"
    out_path.write_text(render_post(args.tool, summary, body, date, tags, args.author))
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
