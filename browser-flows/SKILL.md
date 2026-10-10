---
name: browser-flows
description: Record a browser flow once (clicks, typing and the person's spoken narration, via a Chrome extension), turn it into a replayable JSON flow with named inputs, and replay it later with new values through Claude in Chrome -- fast deterministic steps first, model-driven recovery only when a step breaks, and the flow file fixed afterwards. Use whenever someone says "record this flow", "watch me do this and make it repeatable", "run the X flow", "do X again for Y", "which flows do I have", or wants a repeatable browser task that has no API.
---

# Browser flows: record once, replay with new inputs

Everything lives in this folder. `browser-flows.py` is the CLI, `extension/` records, `player.js` replays, `flows/NAME.json` is one flow, `flows/index.json` is the lookup table. Run the CLI with `uv run SKILL_DIR/browser-flows.py ...` (no dependencies; `python3` works too).

Two modes. Pick by the ask: a flow the person wants to teach is **Record**; a flow they want done is **Run**.

## Mode 0: which flow? (always first)

1. `browser-flows.py list`. Match the ask against names and descriptions.
2. Exact or clear match: go to **Run**.
3. No match: say so in one line and offer to **Record** it. Do not guess a flow for an unrelated task.

## Record mode

### Pre-step: is the machine ready?

`browser-flows.py probe`. It opens a page and waits for the extension to call home. If it says not installed, tell the person: open `chrome://extensions`, turn on Developer mode, Load unpacked, pick `SKILL_DIR/extension`. Only they can do this.

### Step 1: what are we recording?

You need a **start URL** and the **task in the person's words**. Ask once for whatever is missing, in one AskUserQuestion. Pick a kebab-case name (`gh-create-issue`) and say it back.

### Step 2: record

Run in the background so it survives while the person works:

```
browser-flows.py record --url START_URL --out SKILL_DIR/.recordings/NAME
```

Tell the person, briefly: the page opens with a green "Flow recorder ready" panel; press Start; say what they are doing *and which values would change next time* ("now I type the customer name, that changes every time"; "this popup only shows sometimes, I close it"); never say passwords aloud; press Stop and save when done. Anything they do in that Chrome is real.

Wait for the process to exit. Read `.recordings/NAME/timeline.md` (speech and actions merged) and `recording.json` when you need the element's `html` or the full `selectors` list.

### Step 3: turn it into a flow

Write `flows/NAME.json`. Shape:

```json
{
  "name": "gh-create-issue",
  "description": "Open a new issue on a GitHub repo.",
  "start_url": "https://github.com/{{repo}}/issues/new",
  "inputs": {
    "repo":  {"description": "owner/name", "example": "acme/app", "required": true},
    "body":  {"description": "issue body", "example": "...", "default": ""},
    "token": {"description": "API token", "secret": true, "required": true}
  },
  "steps": [
    {"id": 1, "type": "navigate", "url": "https://github.com/{{repo}}/issues/new"},
    {"id": 2, "type": "fill",  "desc": "Title field", "selectors": ["css:#issue_title", "label:Title"], "value": "{{title}}"},
    {"id": 3, "type": "click", "desc": "Cookie banner", "selectors": ["text:Accept"], "optional": true, "timeout": 1500},
    {"id": 4, "type": "click", "desc": "Submit", "selectors": ["text:Submit new issue", "css:button[type=\"submit\"]"], "navigates": true}
  ]
}
```

Rules, each with its reason:

- **Step types**: `navigate` (url), `click`, `fill` (value), `change` (select / checkbox / radio value), `press` (key), `wait_for` (element appears), `wait` (ms). Nothing else; `player.js` only knows these.
- **Selectors** are an ordered list the player tries in turn, with these prefixes: `css:`, `xpath:`, `text:` (exact visible text of a control), `text~:` (contains), `label:` (aria-label, placeholder, name or `<label>` text of a field). Keep two or three per step, stable first: testid or id, then label/text, then xpath last because it breaks first. The recorder's `selectors` field already gives this order; trim, do not invent.
- **Inputs** are every value that the narration says changes, plus every value that obviously would (names, dates, emails, ids). Reference them as `{{name}}` in `value` and `url`. Fixed choices become `default`. Anything the recorder masked as `***` is an input with `secret: true`.
- **optional: true** for popups, banners and dialogs the narration says "sometimes" about, or that were closed on the way. Give them a short `timeout` (1000 to 2000 ms) so a missing one costs little.
- **navigates: true** on a click that was followed by a `navigate` event in the timeline. It ends a chunk; the player's page dies there.
- **Drop** stray clicks, scrolls and things the narration said to ignore. Keep every confirmation dialog.
- **Say what you dropped and why** in the `description` only if it matters to a future run.

Then `browser-flows.py index` and `browser-flows.py show NAME`. Paste the `show` output to the person and ask one AskUserQuestion: are the inputs right, anything optional that should be required or the reverse. Fix, re-index. Offer a first run with `--dry-run`.

## Run mode

### Step 1: inputs

`browser-flows.py show NAME` for the input list. Take values from the ask. Then:

```
browser-flows.py render NAME --input k=v --input k2=v2 --chunks
```

Exit code 3 means missing inputs; the JSON names them with descriptions and examples. Ask for all of them in **one** AskUserQuestion, never one at a time. Secrets: ask the person to type them into the terminal prompt, do not echo them back.

If the person asked for a dry run, or the flow is new, run `--dry-run` instead of `--chunks` and show the step list. Stop there for a dry run.

### Step 2: replay, fast

Load the Claude in Chrome tools in one ToolSearch call (`tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `javascript_tool`, `read_page`, `find`, `computer`, `form_input`). Create one new tab and use it for the whole run.

For each chunk, in order:

1. `browser-flows.py render NAME --input ... --chunk N`. The first line is `// navigate to: URL` when the chunk starts on a new page: call `navigate` with that URL first, then the JS. A chunk with no URL line runs on whatever page the previous chunk left.
2. Paste the whole output into `javascript_tool`. It returns `{ok: true, done}` or `{ok: false, failed: STEP_ID, reason, url, title}`.
3. `ok: true`: next chunk. Do not read the page, do not screenshot. Speed is the point. A chunk ending in a `navigates` step returns `navigating: true` just before the page changes; if the tool instead errors with "Inspected target navigated", that step still ran: carry on with the next chunk.

### Step 3: recover, only when a step fails

Now think. In this order, because the first causes are the common ones:

1. Look: `read_page` (interactive only) or a screenshot. Is the element there under a different label or a changed layout? Is a popup in the way? Did the page need more time?
2. Do the one failed step yourself with `find` + `computer` or `form_input`, using the input values. If a popup blocked it, close it, then do the step.
3. Record the fix in the flow so next time is fast:
   - new selector that works: `browser-flows.py fix NAME STEP --selector "css:..."` (it goes to the front of the list)
   - a popup that blocked: add a new optional click step before it, by editing the JSON (new id, re-index)
   - the step turned out to navigate: `browser-flows.py fix NAME STEP --navigates`
   - the step is sometimes absent: `--optional`
4. Resume: `render` the same chunk again, but strip the steps already done from `STEPS` before pasting (steps up to and including the one you did by hand). Then continue with the next chunks.

If the same step fails twice after a fix, stop and tell the person what the page shows and what you tried. Do not loop.

### Step 4: report

One short message: what ran, which inputs, the final URL and title from the last chunk, and any flow fixes you saved. If a step was done by hand, say which and that the flow now has the fix.

## Reference

- Recorder output: `timeline.md` (speech and actions merged with timestamps), `recording.json` (events with `selectors`, `xpath`, `testid`, `id`, `role`, `label`, `placeholder`, `text`, `html`, `value`, `url`; plus `transcript`), `audio.webm` (backup).
- Event types recorded: `navigate`, `click`, `fill` (final value, secrets as `***`), `change`, `press` (Enter, Escape, Tab).
- The player fills via the native value setter and dispatches input/change, so React, Vue and Angular controls update. Enter on a field submits its form if the page did not cancel the key.
- Port 9335 is fixed in `browser-flows.py`, `extension/background.js`, `offscreen.js`, `start.js`. After editing anything in `extension/`, reload it on `chrome://extensions`.
- `flows/index.json` is derived; never hand-edit it, run `index`.
