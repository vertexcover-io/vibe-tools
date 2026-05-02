# Prompt history for pin

**Model/Agent:** Claude Code (Opus 4.7, 1M context) in interactive auto mode.

## Original request

> Help me create a cli based bookmarking tool with claude code cli based nlp search. The tool easily allows me to create bookmark folders with short description (allow nesting), bookmark links (with / without folders) with manual name, description/tags or auto created using claude, ability to see all bookmarks nested by folder, search bookmarks by tags/description/name, copy particular bookmark to clipboard directly and any other feature I missed

## Iterative refinements

1. **Naming.** Initial proposal was `bookmark`. User asked for something "more fun" without `ai` in the name. Brainstormed: `marky`, `stash`, `pocket`, `dogear`, `anchor`, `pin`, `hoard`, `recall`, `sigil`, `trove`. Chose **`pin`** — short, memorable, easy to type for a frequently-used CLI.
2. **Search consolidation.** User: "Don't need search/find, find can have a flag for non ai. Also find can have support for fzf." → merged into a single `find` command with `--plain` (substring) and `--fzf` (force picker) flags. NLP is the default.
3. **NLP add.** User: "add support for nlp creation from string with name, desc, folder auto discovered." → `add` takes an optional second positional arg (freeform text). Claude is shown the existing folder tree and either picks an existing folder or proposes a new one. Folders are auto-created on add.
4. **Copy is part of find.** User: "Also copy should be part of find. If only one found directly copies it, if multiple let select one to copy url." → exactly that: 1 match → clipboard, multiple → fzf, then clipboard. `--print`/`--open`/`--list` switch the action.
5. **Auto-create folders.** User: "If pin gives a --folder or in nlp that doesn't exist -> should be created. Let claude get list of all the folders to decide the folder when using nlp to create." → `ensure_folder()` walks the path and creates missing segments. Claude sees the full folder tree (with descriptions) when generating metadata via `--auto` or NL add.
6. **DB location.** User asked for the right place. → settled on `~/.local/share/pin/pin.db` (XDG Base Directory spec, works on both Linux and macOS). Overridable via `$PIN_DB` or `--db`.

## Technical notes encountered during the build

- **Shared schema bug.** First version reused `AUTO_SCHEMA` for the NL-add Claude call, which didn't include a `url` field. Claude obediently returned no URL, so adding bookmarks via pure freeform text failed with "no URL provided or detected". Fixed by giving NL-add its own schema with `url` as a required field.
- **`--setting-sources ""`** (rather than `--bare`) is the right way to skip user/project hook injection while preserving OAuth auth — same pattern as `aibash`.
- **Disable all tools** (`Bash Read Edit Write Glob Grep WebFetch WebSearch Agent`) on every Claude call. Otherwise Claude will try to verify URLs/files via its own tools, which adds turns and cost. With tools off, it answers from the structured context we provide.
- **Folder uniqueness** is enforced as `UNIQUE(parent_id, name)` so the same name can exist under different parents but `ensure_folder` is idempotent.
- **`folder_path_str`** walks parent_id chain to reconstruct the path string for display — keeps the tree storage simple (just `parent_id` pointers, no materialized paths).
- **Cascade delete** on `folders.parent_id` and `SET NULL` on `bookmarks.folder_id` so removing a folder cleans up subfolders but leaves orphaned bookmarks (which then show up at the top level in `ls`).
- **fzf picker** uses tab-delimited columns with `--with-nth=2,3,4,5` to display name/folder/tags/url while the bookmark `id` is hidden in column 1 and parsed back from the picked line.
- **httpx** is used for URL metadata fetching (title + meta description / og:description) so `--auto` can give Claude something concrete to summarize beyond the URL itself.
