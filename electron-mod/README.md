# electron-mod

Inspect, mod, repack and re-sign **any installed Electron app** on macOS. Ships as:

- **`electron-mod.py`** — the deterministic pipeline (inspect / build / repack / stable re-sign).
- **`electron-mod.md`** — a Claude Code slash command that drives the whole flow: inspect the
  app, **plan the mod in plan mode** (asking clarifying questions), author the per-app mod
  files, build + re-sign, then self-test over CDP.

It handles the modern Electron protections that broke older patchers, on **any** app:
- **asar-integrity fuse** — recomputes `SHA256(getRawHeader().headerString)` and rewrites `Info.plist`.
- **OnlyLoadAppFromAsar fuse** — repacks a valid `app.asar` (native `*.node` modules kept unpacked).
- **code signature** — re-signs with a **stable** self-signed identity so cookies/logins persist
  across rebuilds (ad-hoc signing rotates identity and forces re-login).
- **auto-update** — neuters `app-update.yml` so updates don't silently revert your build.
- **fallback** — if the integrity-corrected copy still won't launch, flips the integrity fuse off
  and re-signs.

All app-specific paths (asar location, main entry, preloads, executable name, signing identity,
integrity plist key) are **discovered**, not hardcoded.

## Requirements

- macOS
- `node` + `npx` (pulls `@electron/asar` and `@electron/fuses` on demand)
- `codesign`, `openssl`, `security` (Xcode command line tools)

## Use via Claude (recommended)

```
/electron-mod /Applications/Slack.app — add a jump-to-latest button
/electron-mod Notion — add a vertical split-screen with Cmd+/
```

Claude inspects the app, plans the mod with you in plan mode, writes the mod files, builds the
re-signed copy, and self-tests it.

## Use the pipeline directly

Inspect any Electron app (JSON: asar, fuses, signing, preloads, native modules):

```sh
./electron-mod.py inspect /Applications/Notion.app --deep
```

Build a modded, re-signed copy from a mods directory:

```sh
./electron-mod.py build /Applications/Notion.app \
  --mods ./mods/notion \
  --renderer .webpack/renderer/tab_browser_view/preload.js
```

Output: `Notion-Modded.app` beside the original (override with `--dest`). **Re-run after every
app update** to rebuild against the new version.

## Writing a mod

Each mod is a folder under the `--mods` directory. Drop in any of:

| File           | Effect                                                                 |
|----------------|------------------------------------------------------------------------|
| `renderer.css` | Injected as a `<style data-electron-mod>` into the page at startup     |
| `renderer.js`  | Inlined into the chosen content preload, runs once the DOM is ready    |
| `patch.py`     | Run as `python patch.py <extracted_app_dir>` for main-process edits    |

Renderer mods are **inlined** into a sandboxed preload (no `fs`/`require` at runtime), so they
can't throw out of the preload under contextIsolation. Pick the injection preload with
`--renderer` (auto-selected when there's an obvious single content preload).

## Caveats

- Personal, local use only — repackaging a proprietary app to distribute would violate its ToS
  and require Apple notarization.
- Renderer mods target minified DOM; class-based selectors can break across versions. Anchor on
  stable structure.
- Tested against Notion 7.x and Slack 4.x (arm64), both shipping asar-integrity +
  OnlyLoadAppFromAsar enabled.
