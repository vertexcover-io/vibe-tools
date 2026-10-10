# browser-flows

Record a browser task once, replay it later with new values.

A Chrome extension records what you click and type plus what you say out loud. Claude turns that into `flows/NAME.json`: steps with selectors and `{{inputs}}`. In run mode Claude in Chrome replays the steps in one fast JS call per page, and only starts thinking when a step breaks. The fix is saved back into the flow.

## Setup

1. `chrome://extensions`, Developer mode on, Load unpacked, pick `browser-flows/extension`.
2. Symlink the folder into `~/.claude/skills/browser-flows` so the skill loads.
3. `uv run browser-flows.py probe` should print `extension: installed`.

## Use

In Claude Code: "record a flow for creating a Jira ticket at URL" or "run the gh-create-issue flow for repo acme/app".

By hand:

```
uv run browser-flows.py list
uv run browser-flows.py show NAME
uv run browser-flows.py record --url URL --out .recordings/NAME
uv run browser-flows.py render NAME --input k=v --dry-run
uv run browser-flows.py fix NAME STEP_ID --selector "css:#thing"
```

Flows live in `flows/`, the lookup table is `flows/index.json` (rebuild with `index`). Recordings land in `.recordings/`, ignored by git.
