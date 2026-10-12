# video-compressor

An Android app that compresses videos on-device. Pick a video (from the gallery, the file browser, or by sharing it to the app), choose the options, and tap **Compress**. The result is saved to `Movies/VideoCompressor/` and can be played or shared from the app.

Options:

- **Resolution**: Original, 1080p, 720p, 540p, 480p, 360p (applied to the short side, so portrait videos work, and never upscaled)
- **Quality**: High / Balanced / Small / Smallest. Picks a target bitrate from the output resolution and frame rate, and never goes above the source bitrate.
- **Codec**: H.264 (plays everywhere) or H.265/HEVC (about 30% smaller, shown only if the phone has an HEVC encoder)
- **Frame rate**: Original, 30, 24, or 15 fps
- **Remove audio**

The app shows an estimated output size before you start, then a progress bar with an ETA, then the actual before/after sizes.

Compression uses [Media3 Transformer](https://developer.android.com/media/media3/transformer), which runs on the phone's hardware encoders. There is no FFmpeg and no network access. Requires Android 10 (API 29) or newer, and needs no storage permissions.

## Get the APK

Every push that touches this folder runs `.github/workflows/video-compressor-apk.yml`, which builds a debug APK. To install it, open the latest run in the repo's **Actions** tab, download the `video-compressor-apk` artifact, unzip it, and open `app-debug.apk` on your phone. You need to allow "install unknown apps" first.

CI signs each build with a fresh debug key, so if an update won't install, uninstall the old version first.

## Build locally

Open this folder in Android Studio, or run:

```bash
./gradlew assembleDebug        # needs JDK 17+ and the Android SDK (ANDROID_HOME)
adb install app/build/outputs/apk/debug/app-debug.apk
```

## Layout

- `app/src/main/java/.../VideoCompressorActivity.kt`: the UI (picking, options, progress, result)
- `app/src/main/java/.../Compressor.kt`: probing the video, choosing bitrate and size, running the Transformer export, and saving to MediaStore
