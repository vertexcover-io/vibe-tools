---
description: Mod any installed Electron app — inspect, plan in plan mode, build, re-sign, self-test
argument-hint: <app path or name> — what you want to change
allowed-tools: Bash(uv run /Users/vertexcover/Projects/vibe-tools/electron-mod/electron-mod.py:*), Bash(python3 /Users/vertexcover/Projects/vibe-tools/electron-mod/electron-mod.py:*), Read, Write, Edit, Glob, Grep, AskUserQuestion, EnterPlanMode, ExitPlanMode
---

Mod an installed Electron app on macOS. The user wants: `$ARGUMENTS`

You drive an interactive pipeline. The deterministic mechanics (asar extract/pack, integrity-hash fix, native-module unpacking, stable re-signing, auto-update neutering, fuse fallback) live in `/Users/vertexcover/Projects/vibe-tools/electron-mod/electron-mod.py`. **You** own understanding the target app, planning the mod in plan mode, authoring the per-app mod files, and self-testing the result. Never hand-roll asar/codesign commands — always go through the script.

The mod authoring patterns below are the reference for renderer mods and main-process `patch.py` mods.

## Stage 1 — Locate & inspect

1. Resolve the app path. If the user gave a name, find it: `ls -d /Applications/*<name>*.app`. Confirm it's the right one if ambiguous.
2. Run inspection and **read the JSON**:
   ```
   uv run /Users/vertexcover/Projects/vibe-tools/electron-mod/electron-mod.py inspect "<app>" --deep
   ```
   `--deep` extracts the asar so you get `package_main`, `preloads`, and `native_modules`. Note especially:
   - `asar_integrity_enabled` / `only_load_app_from_asar` — the protections you must satisfy.
   - `signing` — Developer-ID vs ad-hoc; you'll replace it with a stable self-signed identity.
   - `preloads` — candidate injection targets for renderer mods.
   - `package_main` — the main-process entry (where `patch.py` mods edit).
3. Extract the asar somewhere you can read it, so you can study the actual bundles before planning:
   ```
   uv run .../electron-mod.py inspect "<app>" --deep   # already lists what's inside
   ```
   To read source: extract once to a temp dir with `npx @electron/asar extract "<asar>" /tmp/<app>-src`, then `Read`/`Grep` the main bundle (`package_main`) and the relevant preload. Identify the renderer that renders the **content the user wants to change**, and the main-process chokepoints (window/view layout, menu, IPC) if the mod is structural.

## Stage 2 — Plan (PLAN MODE)

Enter plan mode (`EnterPlanMode`) before writing anything. In plan mode:

- Decide the mod **shape** for this specific app:
  - **renderer.css** — pure styling of the page DOM.
  - **renderer.js** — DOM behavior, injected (inlined) into a content preload. Pick the preload from `preloads`; prefer the one that renders the user's target content. Avoid injecting into chrome/helper preloads (settings, sqlite, activity-monitor) — under contextIsolation that can stall page load.
  - **patch.py** — main-process source edits (`package_main` bundle): windows, `WebContentsView` layout, menus, `globalShortcut`, `ipcMain`. Use this for structural features (own layout directly, re-assert on an interval, reuse the authenticated `session`/partition).
- Map the change to concrete anchors: which file, which string literal / selector / function you'll hook. Minified bundles change across versions — anchor on stable literals, not line numbers.
- Call out risks: memoized selectors that ignore runtime flags, sandboxed preloads (no `fs`/`require` at runtime — everything must be inlined), session/partition for auth, native modules.
- **Ask clarifying questions with AskUserQuestion** for anything that changes the design: exact behavior, hotkey, scope, whether to target the live install or a copy, dest path. Don't guess on user-facing behavior.

Then `ExitPlanMode` with the plan for approval.

## Stage 3 — Author the mod

Create a mods directory (default: `/Users/vertexcover/Projects/vibe-tools/electron-mod/mods/<app-slug>/<mod-name>/`) containing the files the plan calls for:

- `renderer.css` and/or `renderer.js` — inlined into the chosen preload by the pipeline. The loader is wrapped in try/catch and waits for the DOM, so write straightforward DOM code; it has no `fs`/`require` at runtime.
- `patch.py` — receives the extracted app dir as `sys.argv[1]`; edits source files in place (e.g. the `package_main` bundle). Make edits idempotent (check a sentinel before appending) so rebuilds are clean.
- `README.md` — what it does and which app/version it targets.

Every script starts with the AI-generated attribution header (see repo AGENTS.md).

## Stage 4 — Build, sign, verify

```
uv run /Users/vertexcover/Projects/vibe-tools/electron-mod/electron-mod.py build "<app>" \
  --mods /Users/vertexcover/Projects/vibe-tools/electron-mod/mods/<app-slug> \
  --renderer "<chosen/preload/relative/path.js>"
```

- `--renderer` selects the injection target. The tool auto-selects when there's an obvious single content preload; pass it explicitly otherwise (you decided which in the plan). Repeat `--renderer` to inject into several.
- Output goes to `<name>-Modded.app` beside the original (override with `--dest`). The original is never touched.
- Signing uses a **stable** self-signed identity derived from the app name (override `--identity`). This is deliberate: a stable identity keeps the app's Safe Storage Keychain entry stable, so cookies/logins survive rebuilds — ad-hoc signing would force re-login every build.
- If integrity validation still fails launch verification, the tool flips `EnableEmbeddedAsarIntegrityValidation` off and re-signs as a fallback. Pass `--no-fuse-fallback` to forbid that.

Report the integrity-hash result and the codesign verify status from the output.

## Stage 5 — Self-test (CDP)

Confirm the mod actually works before declaring done. Launch the modded app with remote debugging and drive it over the Chrome DevTools Protocol:

```
open "<dest>.app" --args --remote-debugging-port=9222
```

Then inspect via CDP (`curl http://127.0.0.1:9222/json` to list targets; evaluate JS against the page target) to confirm your injected CSS/JS/marker is present and behaving. For a renderer mod, check the injected `<style data-electron-mod>` or your DOM changes exist. For a main-process mod, trigger the feature (e.g. send the shortcut) and observe the result. If it didn't take, re-plan — don't keep rebuilding blindly.

When it works, summarize: what changed, where the mod files live, the exact rebuild command (the user re-runs Stage 4 after every app update), and any version-fragility caveats.
