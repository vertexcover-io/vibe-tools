# Prompt log

Model/agent: Claude Code (Claude Opus 5.5), running in a cloud sandbox.

## Prompt

> help me build an Android app that lets me select a video and give me options to compress it and the compress it

## Design decisions (made by the agent)

- **Native Kotlin + Media3 Transformer** instead of FFmpeg. It uses the hardware encoders, so it's fast and keeps the APK small, and it needs no native libraries.
- **Plain framework views (XML layout + Spinners)** instead of Compose or Material, to keep dependencies to `activity-ktx` + Media3.
- **minSdk 29**, so that saving through MediaStore `RELATIVE_PATH` needs no storage permission.
- **Options**: resolution (short side), quality (bits-per-pixel → bitrate, capped below the source bitrate), H.264/HEVC (HEVC only if the device has an encoder), frame rate (via `FrameDropEffect`), and remove audio. Shows an estimated output size before compressing.
- Input from the photo picker, `ACTION_OPEN_DOCUMENT`, or a share intent (`ACTION_SEND video/*`).
- The activity handles config changes itself, so rotating the phone doesn't kill a running export. The screen stays on while it compresses.
- The sandbox couldn't reach Google's Maven repo or download the Android SDK, so the app was compile-checked in GitHub Actions instead. The workflow `.github/workflows/video-compressor-apk.yml` builds the debug APK and uploads it as an artifact.
