// AI-generated. See PROMPT.md for the prompts and model used.
@file:OptIn(UnstableApi::class)

package io.vertexcover.videocompressor

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodecList
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** What we know about the picked video. Width/height are as displayed (rotation applied). */
data class VideoInfo(
    val name: String,
    val sizeBytes: Long,
    val width: Int,
    val height: Int,
    val durationMs: Long,
    val bitrate: Int,
    val frameRate: Float,
    val hasAudio: Boolean,
)

enum class Resolution(val label: String, val shortSide: Int?) {
    ORIGINAL("Original", null),
    P1080("1080p", 1080),
    P720("720p", 720),
    P540("540p", 540),
    P480("480p", 480),
    P360("360p", 360),
}

/** Bits per pixel per frame for H.264; HEVC gets a discount on top. */
enum class Quality(val label: String, val bitsPerPixel: Double) {
    HIGH("High quality", 0.10),
    BALANCED("Balanced", 0.07),
    SMALL("Small file", 0.045),
    TINY("Smallest file", 0.03),
}

enum class Codec(val label: String, val mimeType: String, val bitrateFactor: Double) {
    H264("H.264 (plays everywhere)", MimeTypes.VIDEO_H264, 1.0),
    HEVC("H.265 / HEVC (smaller files)", MimeTypes.VIDEO_H265, 0.7),
}

enum class FrameRate(val label: String, val fps: Int?) {
    ORIGINAL("Original", null),
    FPS30("30 fps", 30),
    FPS24("24 fps", 24),
    FPS15("15 fps", 15),
}

data class CompressOptions(
    val resolution: Resolution,
    val quality: Quality,
    val codec: Codec,
    val frameRate: FrameRate,
    val removeAudio: Boolean,
)

/** The concrete numbers a set of options resolves to for a given video. */
data class CompressPlan(
    val width: Int,
    val height: Int,
    val frameRate: Float,
    val videoBitrate: Int,
    val audioBitrate: Int,
    val estimatedBytes: Long,
)

private const val AUDIO_BITRATE = 128_000
private const val MIN_VIDEO_BITRATE = 150_000
private const val FALLBACK_FPS = 30f

fun probeVideo(context: Context, uri: Uri): VideoInfo {
    var name = "video"
    var size = -1L
    context.contentResolver.query(uri, null, null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
            if (nameIdx >= 0 && !c.isNull(nameIdx)) name = c.getString(nameIdx)
            if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
        }
    }

    val r = MediaMetadataRetriever()
    try {
        r.setDataSource(context, uri)
        fun int(key: Int) = r.extractMetadata(key)?.toIntOrNull() ?: 0
        fun long(key: Int) = r.extractMetadata(key)?.toLongOrNull() ?: 0L

        var w = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
        var h = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
        val rotation = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        if (rotation == 90 || rotation == 270) w = h.also { h = w }
        val durationMs = long(MediaMetadataRetriever.METADATA_KEY_DURATION)
        val frameCount = long(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)
        val fps = if (frameCount > 0 && durationMs > 0) frameCount * 1000f / durationMs else 0f
        var bitrate = int(MediaMetadataRetriever.METADATA_KEY_BITRATE)
        if (bitrate <= 0 && size > 0 && durationMs > 0) bitrate = (size * 8000 / durationMs).toInt()
        val hasAudio = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
        if (w <= 0 || h <= 0) throw IllegalArgumentException("This file doesn't look like a video.")
        return VideoInfo(name, size, w, h, durationMs, bitrate, fps, hasAudio)
    } finally {
        r.release()
    }
}

fun planCompression(info: VideoInfo, opts: CompressOptions): CompressPlan {
    val sourceShort = min(info.width, info.height)
    val targetShort = opts.resolution.shortSide?.coerceAtMost(sourceShort) ?: sourceShort
    val scale = targetShort.toDouble() / sourceShort
    val width = even(info.width * scale)
    val height = even(info.height * scale)

    val sourceFps = if (info.frameRate > 1f) info.frameRate else FALLBACK_FPS
    val fps = opts.frameRate.fps?.toFloat()?.coerceAtMost(sourceFps) ?: sourceFps

    var videoBitrate = width.toDouble() * height * fps * opts.quality.bitsPerPixel * opts.codec.bitrateFactor
    // Never ask for more than the source already uses, or "compressing" would grow the file.
    if (info.bitrate > 0) videoBitrate = min(videoBitrate, info.bitrate * 0.85)
    val vb = max(videoBitrate.roundToInt(), MIN_VIDEO_BITRATE)

    val ab = if (opts.removeAudio || !info.hasAudio) 0 else AUDIO_BITRATE
    val estimated = ((vb + ab).toDouble() * info.durationMs / 8000.0).roundToLong()
    return CompressPlan(width, height, fps, vb, ab, estimated)
}

private fun even(v: Double): Int = max(2, (v / 2).roundToInt() * 2)

fun isEncoderAvailable(mimeType: String): Boolean =
    MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
        info.isEncoder && info.supportedTypes.any { it.equals(mimeType, ignoreCase = true) }
    }

/** Wraps a single Media3 Transformer export. Must be used from the main thread. */
class CompressionJob(
    context: Context,
    private val uri: Uri,
    private val info: VideoInfo,
    private val opts: CompressOptions,
    private val plan: CompressPlan,
    private val onDone: (Result<File>) -> Unit,
) {
    private val appContext = context.applicationContext
    private val progressHolder = ProgressHolder()
    private var transformer: Transformer? = null
    private lateinit var output: File

    fun start(output: File) {
        this.output = output
        output.delete()

        val effects = mutableListOf<Effect>()
        if (plan.frameRate < info.frameRate - 0.5f) {
            effects += FrameDropEffect.createDefaultFrameDropEffect(plan.frameRate)
        }
        if (plan.width != info.width || plan.height != info.height) {
            effects += Presentation.createForWidthAndHeight(
                plan.width, plan.height, Presentation.LAYOUT_SCALE_TO_FIT
            )
        }

        val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
            .setRemoveAudio(opts.removeAudio)
            .setEffects(Effects(emptyList(), effects))
            .build()

        val encoderFactory = DefaultEncoderFactory.Builder(appContext)
            .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder().setBitrate(plan.videoBitrate).build()
            )
            .setEnableFallback(true)
            .build()

        transformer = Transformer.Builder(appContext)
            .setVideoMimeType(opts.codec.mimeType)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoderFactory)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    transformer = null
                    onDone(Result.success(output))
                }

                override fun onError(
                    composition: Composition,
                    exportResult: ExportResult,
                    exportException: ExportException,
                ) {
                    transformer = null
                    output.delete()
                    val msg = "${exportException.errorCodeName}: ${exportException.message ?: "unknown error"}"
                    onDone(Result.failure(RuntimeException(msg, exportException)))
                }
            })
            .build()
            .also { it.start(item, output.absolutePath) }
    }

    /** 0–100, or null while Transformer can't tell yet. */
    fun progress(): Int? {
        val t = transformer ?: return null
        return if (t.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
            progressHolder.progress
        } else {
            null
        }
    }

    fun cancel() {
        transformer?.cancel()
        transformer = null
        if (::output.isInitialized) output.delete()
    }
}

/** Copies the finished file into Movies/VideoCompressor so it shows up in the gallery. */
fun saveToGallery(context: Context, file: File, displayName: String): Uri {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
        put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/VideoCompressor")
        put(MediaStore.Video.Media.IS_PENDING, 1)
    }
    val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val uri = resolver.insert(collection, values) ?: error("Couldn't create a gallery entry")
    try {
        resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
            ?: error("Couldn't open the gallery entry for writing")
        values.clear()
        values.put(MediaStore.Video.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
    } catch (e: Exception) {
        resolver.delete(uri, null, null)
        throw e
    }
    return uri
}

fun formatBytes(bytes: Long): String {
    if (bytes < 0) return "?"
    val units = arrayOf("B", "KB", "MB", "GB")
    var v = bytes.toDouble()
    var i = 0
    while (v >= 1024 && i < units.lastIndex) {
        v /= 1024
        i++
    }
    return if (i == 0) "$bytes B" else String.format(Locale.US, "%.1f %s", v, units[i])
}

fun formatBitrate(bps: Int): String =
    if (bps >= 1_000_000) String.format(Locale.US, "%.1f Mbps", bps / 1_000_000.0)
    else "${bps / 1000} kbps"

fun formatDuration(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) String.format(Locale.US, "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60)
    else String.format(Locale.US, "%d:%02d", s / 60, s % 60)
}
