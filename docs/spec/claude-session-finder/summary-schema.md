# Summary schema (single `claude -p` call)

## JSON shape

```json
{
  "title": "string, ≤80 chars, scannable name",
  "summary": "4-6 sentences. Paragraph form. What was attempted, key decisions made, what shipped or didn't, current state.",
  "tags": ["lowercase-kebab-case", "3-8 labels", "free-form folksonomy"],
  "files_touched": ["paths/to/files/from/Edit/Write/Read tool calls"],
  "prs_referenced": ["https://github.com/.../pull/N", "..."],
  "tool_call_counts": { "Bash": 12, "Edit": 4, "Read": 9, "Write": 3 }
}
```

`tool_call_counts` is computed mechanically from events (not LLM-generated) and merged into the LLM result before storage. The LLM is shown the existing counts as context but the values come from the deterministic count.

## Field definitions

### `title`
Short scannable name (≤80 chars). Like a commit subject line. The thing the user would call this conversation if asked.

**Falls back to** `name` (user-set) when `name` is non-null in the UI: `display_name = session.name ?? summary.title ?? "Session " + session.id.slice(0, 8)`.

### `summary`
A real paragraph (4–6 sentences). Cover:
1. What the session set out to do
2. The approach taken (key technical/design decisions)
3. What was actually accomplished
4. Current state — committed/pushed/blocked/abandoned
5. Any non-obvious context that helps the reader recall the work

Example (the `pin` build session):

> Designed and shipped pin, a Python CLI bookmark manager that uses the Claude Code CLI for natural-language adds and intent-based search. Followed the conventions established by the existing aibash tool (PEP-723 inline metadata, single-file uv-run script, repo-local AGENTS.md attribution header). Storage is SQLite at `~/.local/share/pin/pin.db` with nested folders auto-created on add and a unified `find` command that copies single matches directly to the clipboard. Smoke-tested all flows including --auto, NL-add, NLP search, mv, edit, rm, export/import — caught and fixed a schema reuse bug where NL-add's Claude call inherited a schema lacking the `url` field. Committed as `90a53cf` with the conventional `add pin: ...` subject and pushed to master after a rebase over the auto-generated README update.

### `tags`
3–8 lowercase, kebab-case labels. Free-form folksonomy. Examples for the pin session: `cli-tooling`, `bookmark-manager`, `claude-cli`, `sqlite`, `python`, `nlp-search`, `shipped`. Rendered as chips in the UI; clickable to filter.

### `files_touched`
Every file path the session created, modified, or read with intent. Mined mechanically from `Edit`/`Write`/`Read`/`MultiEdit` tool calls, then optionally pruned by the LLM to drop noise (e.g., the user's `.zshrc` if read once incidentally).

### `prs_referenced`
PR URLs that were:
- Opened in the session (`gh pr create` tool result)
- Mentioned in user messages
- Implied by branch names (resolved later by the PR linker phase)

`prs_referenced` is the candidate set; the PR linker promotes the validated ones to `session.pr_urls`.

### `tool_call_counts`
Deterministic. Walks events, counts `tool_use` blocks by `tool` name. Goes alongside the LLM result in the same DB row for ease of querying.

## What we deliberately do NOT extract (yet)

- `topics` — overlaps with `tags`; collapsed into `tags`
- `action_items` — too unreliable to mine well; revisit when we have signal
- `errors` / stagnation moments — deferred to the future intervention-mining feature, separate model
- `interventions` — see above

## Prompt skeleton (for `claude -p`)

```
You are summarizing a Claude Code coding session for later retrieval and analysis.
Output ONLY a JSON object matching the schema. No prose, no markdown.

Fields:
- title: ≤80 char scannable name (commit-subject style)
- summary: 4-6 sentence paragraph covering goal, approach, outcome, current state
- tags: 3-8 lowercase-kebab-case labels (free-form)
- files_touched: paths from Edit/Write/Read tool calls; prune incidental reads
- prs_referenced: PR URLs that were opened, mentioned, or implied

The session transcript follows.
```

The summarizer also passes a `tool_call_counts` map computed deterministically — the LLM does NOT regenerate this; the post-processor merges it in.
