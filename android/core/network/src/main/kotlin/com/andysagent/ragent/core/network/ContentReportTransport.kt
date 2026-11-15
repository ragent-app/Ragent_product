package com.andysagent.ragent.core.network

import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okio.BufferedSink

/** Separate first-party channel: no bearer, redirects, hidden write retry or selected-PC fallback. */
fun contentReportTransport(accountsEndpoint: String): RagentTransport {
    val uri = URI(accountsEndpoint)
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null)
    return OkHttpRagentTransport(
        endpointProvider = { accountsEndpoint.trimEnd('/') },
        credentialProvider = { null },
        client = contentReportHttpClient(),
    )
}

internal fun contentReportHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .retryOnConnectionFailure(false)
    .followRedirects(false)
    .followSslRedirects(false)
    .callTimeout(25, TimeUnit.SECONDS)
    .connectTimeout(12, TimeUnit.SECONDS)
    .addInterceptor { chain ->
        val request = chain.request()
        val body = request.body
        val frozen = if (body == null) request else request.newBuilder().method(request.method, object : RequestBody() {
            // Also blocks response-driven follow-ups, e.g. a503 with Retry-After:0.
            override fun isOneShot() = true
            override fun contentType() = body.contentType()
            override fun contentLength() = body.contentLength()
            override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
        }).build()
        chain.proceed(frozen)
    }.build()
