package com.andysagent.agentoc

import android.content.Context
import android.app.ActivityManager
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Optional multilingual, fully offline phone recognizer. The model is user-managed and stays private. */
internal class PhoneWhisperEngine(context: Context) {
    private val appContext = context.applicationContext
    private val activityManager = appContext.getSystemService(ActivityManager::class.java)
    private val spec: ModelSpec
        get() {
            val memory = ActivityManager.MemoryInfo().also(activityManager::getMemoryInfo)
            return if (shouldUseTinyPhoneWhisperModel(
                    isLowRamDevice = activityManager.isLowRamDevice,
                    totalRamBytes = memory.totalMem,
                    processorCount = Runtime.getRuntime().availableProcessors(),
                )
            ) TINY_MODEL else BASE_MODEL
        }
    private val modelFile: File
        get() = File(File(appContext.filesDir, "voice-models"), spec.fileName)

    val downloadSizeMb: Int get() = spec.downloadSizeMb
    val workingMemoryMb: Int get() = spec.workingMemoryMb

    val isSupported: Boolean
        get() = Build.SUPPORTED_ABIS.any { it in SUPPORTED_ABIS }

    val isInstalled: Boolean
        get() = isSupported && modelFile.isFile && modelFile.length() in 1..MAX_MODEL_BYTES

    suspend fun download(onProgress: (Int) -> Unit = {}) = withContext(Dispatchers.IO) {
        check(isSupported) { "This phone's processor is not supported by the multilingual offline model" }
        modelFile.parentFile?.mkdirs()
        val partial = File(modelFile.parentFile, "${spec.fileName}.partial")
        partial.delete()
        val request = Request.Builder().url(spec.url).header("User-Agent", "Ragent-Android-Voice").build()
        try {
            client.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "The multilingual model download failed (${response.code})" }
                val body = checkNotNull(response.body) { "The multilingual model download was empty" }
                val declaredLength = body.contentLength()
                check(declaredLength in 1..MAX_MODEL_BYTES || declaredLength == -1L) {
                    "The multilingual model download has an invalid size"
                }
                val digest = MessageDigest.getInstance("SHA-256")
                var written = 0L
                body.byteStream().use { input ->
                    partial.outputStream().buffered().use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            written += count
                            check(written <= MAX_MODEL_BYTES) { "The multilingual model download is too large" }
                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                            if (declaredLength > 0) onProgress(((written * 100) / declaredLength).toInt().coerceIn(0, 100))
                        }
                    }
                }
                check(written > 0 && digest.digest().joinToString("") { "%02x".format(it) } == spec.sha256) {
                    "The multilingual model failed its integrity check; no model was installed"
                }
            }
            check(partial.renameTo(modelFile)) { "The verified multilingual model could not be installed" }
            onProgress(100)
        } catch (error: Throwable) {
            partial.delete()
            throw error
        }
    }

    suspend fun transcribe(wav: ByteArray): String = withContext(Dispatchers.IO) {
        check(isInstalled) { "Download the multilingual offline model in Voice settings first" }
        val audio = File(appContext.cacheDir, "ragent-voice-${System.nanoTime()}.wav")
        audio.writeBytes(wav)
        try {
            NativeWhisper.transcribeFile(
                modelFile.absolutePath,
                audio.absolutePath,
                Runtime.getRuntime().availableProcessors().coerceIn(2, 6),
            ).trim()
        } finally {
            audio.delete()
        }
    }

    fun remove() {
        val directory = File(appContext.filesDir, "voice-models")
        listOf(TINY_MODEL, BASE_MODEL).forEach { model ->
            File(directory, model.fileName).delete()
            File(directory, "${model.fileName}.partial").delete()
        }
    }

    companion object {
        private const val MAX_MODEL_BYTES = 256L * 1024L * 1024L
        private val SUPPORTED_ABIS = setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
        private val TINY_MODEL = ModelSpec(
            fileName = "ggml-tiny-q5_1.bin",
            url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/fb5ed9369c26eaf08392504d8446da431e0fffb9/ggml-tiny-q5_1.bin?download=true",
            sha256 = "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
            downloadSizeMb = 31,
            workingMemoryMb = 300,
        )
        private val BASE_MODEL = ModelSpec(
            fileName = "ggml-base-q5_1.bin",
            url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base-q5_1.bin?download=true",
            sha256 = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
            downloadSizeMb = 57,
            workingMemoryMb = 400,
        )
        private val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.MINUTES)
            .callTimeout(5, TimeUnit.MINUTES)
            .build()
    }
}

internal fun shouldUseTinyPhoneWhisperModel(
    isLowRamDevice: Boolean,
    totalRamBytes: Long,
    processorCount: Int,
): Boolean = isLowRamDevice || totalRamBytes < 8L * 1024L * 1024L * 1024L || processorCount < 12

private data class ModelSpec(
    val fileName: String,
    val url: String,
    val sha256: String,
    val downloadSizeMb: Int,
    val workingMemoryMb: Int,
)
