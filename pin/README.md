# pin

A CLI bookmark manager with **Claude-powered natural-language add and search**.

Bookmark URLs with names, descriptions, tags, and nested folders. Find them with plain English (`pin find "that ml paper about attention"`) and the matched URL goes straight to your clipboard.

## Requirements

- `claude` CLI installed and authenticated (powers NLP add/search — no API key needed beyond your Claude Code login).
- `uv` for running the script.
- Optional: `fzf` for picker mode, `pbcopy` (macOS) / `xclip` / `wl-copy` for clipboard.

## Storage

Default DB lives at `~/.local/share/pin/pin.db` (XDG-compliant). Override with `$PIN_DB` or `--db <path>`.

## Quick start

```bash
# Make a folder
./pin.py mkdir dev/python --desc "python stuff"

# Add a bookmark with manual fields
./pin.py add "https://docs.python.org/3/library/asyncio.html" \
    --name "asyncio docs" --tags "python,async" --folder dev/python

# Add with --auto: Claude fetches the page, generates name/desc/tags, and picks/proposes a folder
./pin.py add "https://docs.python.org/3/library/itertools.html" --auto

# Add with natural language: a freeform second arg that Claude parses
./pin.py add "https://arxiv.org/abs/1706.03762" "the original transformers paper, save under reading"

# Or just one freeform string with the URL embedded
./pin.py add "save https://github.com/astral-sh/uv as a python tooling reference"

# List everything as a tree
./pin.py ls

# Find by NLP — single match goes straight to clipboard
./pin.py find "that ml paper about attention"

# Plain substring search instead
./pin.py find --plain "asyncio"

# Pick from all bookmarks with fzf
./pin.py find --fzf
```

## Commands

### `add <url> [natural-language]`

Add a bookmark.

- **First arg is a URL** + manual flags → simple insert.
- **First arg is a URL** + second freeform arg → Claude parses the description for name/desc/tags/folder.
- **First arg is freeform text** containing a URL → Claude extracts everything.
- **`--auto`** with a URL only → Claude fetches the page and generates metadata.

Flags:
| Flag | Purpose |
| --- | --- |
| `--name` | Bookmark name |
| `--desc` | Description |
| `--tags` | Comma-separated tags |
| `--folder` | Folder path; created if missing (e.g. `dev/python/async`) |
| `--auto` | Fetch the URL and let Claude generate name/desc/tags/folder |

Folders referenced via `--folder` or inferred by Claude that don't exist yet are created automatically. When using NLP, Claude is shown the existing folder tree and prefers an existing folder if one fits.

### `mkdir <path>`

Create a folder. Nested paths work (`dev/python/async`). `--desc` adds a folder description that Claude sees during NLP add.

### `ls [path]`

Tree view of folders and bookmarks. Optional `path` to limit to a subtree.

### `find [query]`

Search bookmarks. Default is **NLP via Claude** (matches on intent, not just substrings).

| Flag | Purpose |
| --- | --- |
| `--plain` | Literal substring match on name/desc/tags/url |
| `--fzf` | Force the fzf picker even on a single match (or use alone with no query to browse all) |
| `--print` | Print URL instead of copying to clipboard |
| `--open` | Open in the default browser |
| `--list` | Print every match (no copy/open) |

Behavior:
- **One match** → URL goes straight to your clipboard.
- **Multiple matches** → fzf picker; pick one, URL goes to clipboard.
- `--print` / `--open` / `--list` change the action on the chosen bookmark.

### `rm <id|path>`

Delete a bookmark by ID or a folder by path. Folders containing bookmarks/subfolders prompt for confirmation; `-y` skips.

### `mv <id> <folder-path>`

Move a bookmark to another folder (created if missing).

### `edit <id>`

Update fields: `--name`, `--desc`, `--tags`, `--url`.

### `export` / `import`

```bash
./pin.py export --out backup.json
./pin.py import --file backup.json
```

JSON dump/load of the entire bookmark database. Handy for backup or syncing across machines.

## Global flags

| Flag | Purpose |
| --- | --- |
| `--db <path>` | Use a non-default DB file (also via `$PIN_DB`) |
| `--model <id>` | Override the Claude model (default: `sonnet`) |

## How NLP works

Both NLP add and NLP search shell out to `claude -p` with:

- A system prompt constraining the model to JSON-only output.
- A `--json-schema` for structured output.
- All built-in Claude tools (`Bash`, `Read`, `WebFetch`, etc.) disabled — the model answers from the context we provide (page metadata, existing folder list, bookmark list).
- `--setting-sources ""` so user hooks don't interfere.

For **add**, Claude sees: the URL, scraped page title/description, your freeform text (if any), and the full existing folder tree.
For **find**, Claude sees: the user query and a JSON dump of every bookmark (id, name, desc, tags, folder, URL), then returns ranked IDs.
