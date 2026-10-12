// AI-generated. See PROMPT.md for the prompts and model used.
package io.vertexcover.videocompressor

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Size
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import kotlin.concurrent.thread

class VideoCompressorActivity : ComponentActivity() {

    private lateinit var videoPanel: LinearLayout
    private lateinit var thumbnail: ImageView
    private lateinit var videoName: TextView
    private lateinit var videoInfoText: TextView
    private lateinit var optionsPanel: LinearLayout
    private lateinit var spinnerResolution: Spinner
    private lateinit var spinnerQuality: Spinner
    private lateinit var spinnerCodec: Spinner
    private lateinit var spinnerFrameRate: Spinner
    private lateinit var switchRemoveAudio: Switch
    private lateinit var estimate: TextView
    private lateinit var btnCompress: Button
    private lateinit var btnPickGallery: Button
    private lateinit var btnPickFiles: Button
    private lateinit var progressPanel: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var resultPanel: LinearLayout
    private lateinit var resultText: TextView
    private lateinit var resultActions: LinearLayout

    private val codecs = Codec.entries.filter { isEncoderAvailable(it.mimeType) }.ifEmpty { listOf(Codec.H264) }

    private var sourceUri: Uri? = null
    private var info: VideoInfo? = null
    private var job: CompressionJob? = null
    private var resultUri: Uri? = null
    private var startedAt = 0L

    private val handler = Handler(Looper.getMainLooper())
    private val progressTicker = object : Runnable {
        override fun run() {
            val j = job ?: return
            val p = j.progress()
            val elapsed = (System.currentTimeMillis() - startedAt) / 1000
            if (p != null) {
                progressBar.isIndeterminate = false
                progressBar.progress = p
                val eta = if (p in 1..99) " · ~${elapsed * (100 - p) / p}s left" else ""
                progressText.text = "Compressing… $p%$eta"
            } else {
                progressBar.isIndeterminate = true
                progressText.text = "Compressing… ${elapsed}s"
            }
            handler.postDelayed(this, 300)
        }
    }

    private val pickFromGallery =
        registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let(::loadVideo) }
    private val pickFromFiles =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(::loadVideo) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_video_compressor)
        bindViews()
        applySystemBarInsets()
        setUpOptions()

        btnPickGallery.setOnClickListener {
            pickFromGallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
        }
        btnPickFiles.setOnClickListener { pickFromFiles.launch(arrayOf("video/*")) }
        btnCompress.setOnClickListener { startCompression() }
        findViewById<Button>(R.id.btnCancel).setOnClickListener { cancelCompression() }
        findViewById<Button>(R.id.btnPlay).setOnClickListener { resultUri?.let(::play) }
        findViewById<Button>(R.id.btnShare).setOnClickListener { resultUri?.let(::share) }

        if (savedInstanceState == null) handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (job == null) handleIncomingIntent(intent)
    }

    override fun onDestroy() {
        handler.removeCallbacks(progressTicker)
        if (isFinishing) job?.cancel()
        super.onDestroy()
    }

    private fun bindViews() {
        videoPanel = findViewById(R.id.videoPanel)
        thumbnail = findViewById(R.id.thumbnail)
        videoName = findViewById(R.id.videoName)
        videoInfoText = findViewById(R.id.videoInfo)
        optionsPanel = findViewById(R.id.optionsPanel)
        spinnerResolution = findViewById(R.id.spinnerResolution)
        spinnerQuality = findViewById(R.id.spinnerQuality)
        spinnerCodec = findViewById(R.id.spinnerCodec)
        spinnerFrameRate = findViewById(R.id.spinnerFrameRate)
        switchRemoveAudio = findViewById(R.id.switchRemoveAudio)
        estimate = findViewById(R.id.estimate)
        btnCompress = findViewById(R.id.btnCompress)
        btnPickGallery = findViewById(R.id.btnPickGallery)
        btnPickFiles = findViewById(R.id.btnPickFiles)
        progressPanel = findViewById(R.id.progressPanel)
        progressBar = findViewById(R.id.progressBar)
        progressText = findViewById(R.id.progressText)
        resultPanel = findViewById(R.id.resultPanel)
        resultText = findViewById(R.id.resultText)
        resultActions = findViewById(R.id.resultActions)
    }

    /** targetSdk 35+ draws edge-to-edge, so pad the content away from the status/nav bars. */
    private fun applySystemBarInsets() {
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(
                    insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom,
                )
            }
            insets
        }
    }

    private fun setUpOptions() {
        fun <T> Spinner.setup(items: List<T>, label: (T) -> String, default: Int) {
            adapter = ArrayAdapter(
                this@VideoCompressorActivity,
                android.R.layout.simple_spinner_item,
                items.map(label),
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            setSelection(default)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, pos: Int, id: Long) = updateEstimate()
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
        spinnerResolution.setup(Resolution.entries, { it.label }, Resolution.P720.ordinal)
        spinnerQuality.setup(Quality.entries, { it.label }, Quality.BALANCED.ordinal)
        spinnerCodec.setup(codecs, { it.label }, 0)
        spinnerFrameRate.setup(FrameRate.entries, { it.label }, FrameRate.ORIGINAL.ordinal)
        switchRemoveAudio.setOnCheckedChangeListener { _, _ -> updateEstimate() }
    }

    private fun currentOptions() = CompressOptions(
        resolution = Resolution.entries[spinnerResolution.selectedItemPosition],
        quality = Quality.entries[spinnerQuality.selectedItemPosition],
        codec = codecs[spinnerCodec.selectedItemPosition],
        frameRate = FrameRate.entries[spinnerFrameRate.selectedItemPosition],
        removeAudio = switchRemoveAudio.isChecked,
    )

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        uri?.let(::loadVideo)
    }

    private fun loadVideo(uri: Uri) {
        sourceUri = uri
        info = null
        resultPanel.visibility = View.GONE
        optionsPanel.visibility = View.GONE
        videoPanel.visibility = View.VISIBLE
        videoName.text = "Reading video…"
        videoInfoText.text = ""
        thumbnail.setImageDrawable(null)

        thread {
            val probed = runCatching { probeVideo(this, uri) }
            val thumb = runCatching { loadThumbnail(uri) }.getOrNull()
            runOnUiThread {
                if (sourceUri != uri || isDestroyed) return@runOnUiThread
                thumb?.let(thumbnail::setImageBitmap)
                probed.onSuccess { showVideo(it) }.onFailure {
                    videoName.text = "Couldn't read this video"
                    videoInfoText.text = it.message ?: it.javaClass.simpleName
                }
            }
        }
    }

    private fun loadThumbnail(uri: Uri): Bitmap? =
        runCatching { contentResolver.loadThumbnail(uri, Size(640, 360), null) }.getOrNull()
            ?: MediaMetadataRetriever().run {
                try {
                    setDataSource(this@VideoCompressorActivity, uri)
                    getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 640, 360)
                } finally {
                    release()
                }
            }

    private fun showVideo(v: VideoInfo) {
        info = v
        videoName.text = v.name
        val parts = mutableListOf(
            formatBytes(v.sizeBytes),
            "${v.width}×${v.height}",
            formatDuration(v.durationMs),
        )
        if (v.frameRate > 0) parts += "${v.frameRate.toInt()} fps"
        if (v.bitrate > 0) parts += formatBitrate(v.bitrate)
        if (!v.hasAudio) parts += "no audio"
        videoInfoText.text = parts.joinToString(" · ")
        switchRemoveAudio.isEnabled = v.hasAudio
        optionsPanel.visibility = View.VISIBLE
        updateEstimate()
    }

    private fun updateEstimate() {
        val v = info ?: return
        val plan = planCompression(v, currentOptions())
        val pct = if (v.sizeBytes > 0) 100 - plan.estimatedBytes * 100 / v.sizeBytes else null
        val saving = when {
            pct == null -> ""
            pct > 0 -> " (about $pct% smaller)"
            else -> " (won't get smaller — pick a lower setting)"
        }
        estimate.text = buildString {
            append("Output: ${plan.width}×${plan.height} @ ${plan.frameRate.toInt()} fps, ")
            append(formatBitrate(plan.videoBitrate))
            append("\nEstimated size: ~${formatBytes(plan.estimatedBytes)}$saving")
        }
    }

    private fun startCompression() {
        val uri = sourceUri ?: return
        val v = info ?: return
        val opts = currentOptions()
        val plan = planCompression(v, opts)

        cacheDir.listFiles { f -> f.name.startsWith("compress-") }?.forEach { it.delete() }
        val out = File(cacheDir, "compress-${System.currentTimeMillis()}.mp4")
        val outName = v.name.substringBeforeLast('.') + "_compressed.mp4"

        setBusy(true)
        resultPanel.visibility = View.GONE
        progressBar.progress = 0
        startedAt = System.currentTimeMillis()

        job = CompressionJob(this, uri, v, opts, plan) { result ->
            job = null
            handler.removeCallbacks(progressTicker)
            result.onSuccess { file -> saveResult(file, outName, v) }
                .onFailure { e ->
                    setBusy(false)
                    showResult("Compression failed.\n${e.message}", success = false)
                }
        }.also {
            try {
                it.start(out)
            } catch (e: Exception) {
                job = null
                setBusy(false)
                showResult("Couldn't start compression.\n${e.message}", success = false)
                return
            }
        }
        handler.post(progressTicker)
    }

    private fun saveResult(file: File, outName: String, source: VideoInfo) {
        progressBar.isIndeterminate = true
        progressText.text = "Saving to gallery…"
        val seconds = (System.currentTimeMillis() - startedAt) / 1000
        thread {
            val saved = runCatching { saveToGallery(this, file, outName) }
            val size = file.length()
            file.delete()
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                setBusy(false)
                saved.onSuccess { uri ->
                    resultUri = uri
                    val msg = StringBuilder("Done in ${seconds}s. Saved to Movies/VideoCompressor/$outName\n")
                    msg.append("${formatBytes(source.sizeBytes)} → ${formatBytes(size)}")
                    if (source.sizeBytes > 0) {
                        val pct = 100 - size * 100 / source.sizeBytes
                        msg.append(if (pct > 0) " ($pct% smaller)" else " (larger than the original — try lower settings)")
                    }
                    showResult(msg.toString(), success = true)
                }.onFailure { showResult("Compressed, but saving failed: ${it.message}", success = false) }
            }
        }
    }

    private fun cancelCompression() {
        job?.cancel()
        job = null
        handler.removeCallbacks(progressTicker)
        setBusy(false)
        Toast.makeText(this, "Cancelled", Toast.LENGTH_SHORT).show()
    }

    private fun setBusy(busy: Boolean) {
        progressPanel.visibility = if (busy) View.VISIBLE else View.GONE
        progressBar.isIndeterminate = false
        progressText.text = if (busy) "Starting…" else ""
        listOf<View>(
            btnCompress, btnPickGallery, btnPickFiles,
            spinnerResolution, spinnerQuality, spinnerCodec, spinnerFrameRate,
        ).forEach { it.isEnabled = !busy }
        switchRemoveAudio.isEnabled = !busy && info?.hasAudio == true
        if (busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun showResult(message: String, success: Boolean) {
        resultPanel.visibility = View.VISIBLE
        resultText.text = message
        resultActions.visibility = if (success) View.VISIBLE else View.GONE
    }

    private fun play(uri: Uri) {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "video/mp4")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(intent) }
            .onFailure { Toast.makeText(this, "No video player found", Toast.LENGTH_SHORT).show() }
    }

    private fun share(uri: Uri) {
        val intent = Intent(Intent.ACTION_SEND)
            .setType("video/mp4")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(intent, "Share compressed video"))
    }
}
