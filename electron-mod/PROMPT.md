# Prompts

Built with **Claude Code (Opus 4.8, 1M context)**.

## Goal

A **reusable Claude command/agent** that mods *any* installed Electron app on macOS. Given an app
path and a natural-language description of a desired mod, the tool should: understand the app's
current code (asar extract, inspect main/renderer bundles, fuses, signing), use **plan mode** to
plan the mod while asking clarifying questions, build the mod, then repackage + re-sign (asar
integrity + stable identity for cookie/Keychain persistence) and disable auto-update.

## Design decisions (confirmed with the user)

- **Command + Python library split.** A slash command (`electron-mod.md`) owns orchestration,
  plan mode, and clarifying questions; a reusable `electron-mod.py` owns the deterministic
  pipeline (inspect / extract / inject / repack / integrity / sign). Mirrors the user's
  `spawn-claude` pattern (repo folder + symlink into `~/.claude/commands/`).
- **Claude authors per-app mods.** The command inspects the unpacked app, reads the bundles,
  plans in plan mode, and writes the `renderer.js` / `patch.py` for *that* app.

## Everything app-specific is discovered, not hardcoded

- asar location (Resources/app.asar, or any `*.asar`), executable name (from `CFBundleExecutable`).
- fuses, signing authority, integrity block, auto-update yml — surfaced by an `inspect` subcommand
  that emits structured JSON for the agent to read.
- preloads and native modules (via `--deep` asar extract); renderer injection target chosen by the
  agent (or auto-selected when there's an obvious single content preload).
- signing identity and integrity plist key derived from the app name.

## Learnings (verified empirically during the build)

- asar integrity hash = `SHA256(asar.getRawHeader(file).headerString)` — reproduced a live app's
  plist hash, and confirmed the recomputed hash for a *modded* asar matches what's written back.
- native `*.node` modules must stay unpacked (`--unpack *.node`) or main-process native loading
  silently aborts IPC.
- renderer mods are **inlined** into a sandboxed preload (no `fs`/`require` at runtime).
- a **stable** self-signed identity (not ad-hoc) keeps the Safe Storage Keychain entry stable, so
  logins/cookies persist across rebuilds.
- self-test over CDP (`--remote-debugging-port`) to confirm the mod actually took.

## Pipeline

inspect (JSON) → [plan mode + clarifying questions] → author mod files → copy bundle → asar
extract → inject mods → asar pack (`--unpack *.node`) → recompute integrity hash → rewrite
Info.plist → neuter auto-update → stable re-sign → verify → (fallback: flip integrity fuse off +
re-sign) → launch → CDP self-test.

## Verification during build

Ran `inspect` against Notion 7.22 and Slack 4.x (different bundle layouts, both proven to discover
correctly), and full builds confirming: correct auto-selected renderer, integrity-hash match
between plist and modded asar, native modules left unpacked, and the injected loader present in
the repacked asar.
