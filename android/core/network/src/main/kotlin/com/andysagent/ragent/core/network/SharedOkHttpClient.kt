package com.andysagent.ragent.core.network

import okhttp3.Cache
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Process-wide shared OkHttpClient pool so HTTP/2 connections, TLS sessions, and disk responses are reused across modules. */
object SharedOkHttpClient {
    private const val DISK_CACHE_BYTES = 50L * 1024L * 1024L
    private val cacheDirRef = AtomicReference<File?>(null)

    @JvmStatic
    fun initialize(cacheDir: File) {
        val httpCacheDir = File(cacheDir, "okhttp-http-cache")
        cacheDirRef.compareAndSet(null, httpCacheDir)
    }

    val baseClient: OkHttpClient by lazy {
        val builder = OkHttpClient.Builder()
            .connectionPool(ConnectionPool(16, 5, TimeUnit.MINUTES))
        cacheDirRef.get()?.let { dir ->
            runCatching {
                dir.mkdirs()
                builder.cache(Cache(dir, DISK_CACHE_BYTES))
            }
        }
        builder.build()
    }

    fun newBuilder(): OkHttpClient.Builder = baseClient.newBuilder()
}
