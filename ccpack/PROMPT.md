# Prompts

**Model / agent:** Claude Opus 5 (1M context) via Claude Code.

## 1. Initial request

> I want to be able to easily create a zip of claude session where the input is
> potentially a filter or a sessionId. In both cases need a fzf kind of interface to show
> filtered session with date, name and maybe a preview of the session -> not jsonl files
> but user message and claude messages

## 2. Check for prior art

> In a subagent can you see if there is an existing solution for this on github.

A subagent searched GitHub and the web. Findings: the ecosystem splits into *pickers*
(`sorafujitani/ccsession` — fzf + preview, no export) and *exporters*
(`daaain/claude-code-log`, `simonw/claude-code-transcripts` — readable output, no fzf
picker). Nothing bridged the two. The subagent recommended either a glue script over
`ccsession` + `claude-code-log`, or a standalone single-file script.

## 3. Plan first

> continue the main loop -> give a high level potential solution before building it

## 4. Decision

> what is ccsession -> link to it

> Lets implement our own solution

Standalone was chosen over the glue script: it keeps the tool a single dependency-free
file in line with this repo's conventions, instead of requiring a Go binary plus a Python
package.

## Notes discovered while building

- Sessions live at `~/.claude/projects/ENCODED_CWD/SESSION_ID.jsonl`; subagent transcripts
  live at `SESSION_ID/subagents/agent-*.jsonl` beside them and are worth including.
- An `ai-title` entry carries a human-readable title. It can appear anywhere in the file,
  so the index reads both the head and tail of each file rather than parsing it whole.
- Readable transcript = `user` entries with string/text content, plus `assistant` `text`
  blocks. Dropped: `tool_result` payloads, `thinking` blocks, and `isMeta` entries.
- `<system-reminder>` and `<local-command-stdout>` blocks are stripped from user text;
  `<command-name>` wrappers are rendered back as `/slash-command`.
- fzf's `--preview` placeholders read the *original* line, not the `--with-nth` transformed
  one, so the file path can be hidden in field 1 and still reach the preview command.

## 5. Refinements

> Instead of --here allow any folder? Also for sessionId also better to show the preview
> before zipping. Also recommend better name for the zip

> Also better name for the project

Changes made:

- `--here` became `-d [PATH]`, which matches a folder *or anything below it*, so a repo with
  worktrees is covered by one flag. Bare `-d` still means "here".
- A session id now routes through the picker with that single session selected, so the
  preview is always seen before a zip is written. `-y`, `--print`, and non-interactive
  output skip it.
- Zip names went from `project-date-id.zip` to `date-project-title-slug-id.zip`, so a folder
  of exports sorts chronologically and each name says what the session was about.
- The tool was renamed `claude-session-zip` → `ccpack`.

Bug caught while testing the above: with no controlling terminal, `fzf` blocked forever
instead of failing. `pick()` now checks for a tty first and exits with a message.

## 6. Simpler zip name

> No bad name for zip -> ccpack-sessionId.zip

The date/project/title-slug name was too noisy. Zips are now `ccpack-SESSION_ID.zip` — the
first 8 characters of the session id round-trip straight back into `ccpack`
or `claude --resume`. Everything descriptive already lives in `meta.json` and
`transcript.md` inside the archive.

## 7. Web UI

> If i were to build this as html/js also -> how would it work -> how can it access local folder?

A pure HTML/JS build would need the File System Access API (`showDirectoryPicker`), which is
Chrome-only, needs a secure context, hides dotfolders like `.claude` behind a keyboard
shortcut in the OS dialog, and forgets the folder between visits. The answer was to keep the
Python — it already has filesystem access — and let it serve a page.

> Yes build Also and then commit and merge to master

`--serve [PORT]` runs a `ThreadingHTTPServer` on `127.0.0.1` with four routes: the page,
`/api/sessions`, `/api/session/SESSION_ID`, and `/api/zip/SESSION_ID`. `export()` was split
so `build_archive()` can produce zip bytes in memory for the download route.

`ccpack.html` is a sibling file — vanilla JS, inline CSS, theme-aware.

Hardening: localhost bind, no CORS headers, and a `Host` header check so a page you visit
cannot reach the API by DNS rebinding.

Bug caught while testing: a busy port raised a raw `OSError` traceback. It now exits with a
readable message.
