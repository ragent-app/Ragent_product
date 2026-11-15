package com.andysagent.ragent.core.network

import kotlinx.coroutines.CancellationException
import okhttp3.RequestBody
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer

/** Local sink writes, not peer acknowledgement. Each write attempt starts at zero. */
internal class ProgressRequestBody(
    private val delegate: RequestBody,
    private val observer: (Long) -> Unit,
) : RequestBody() {
    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()
    override fun isOneShot() = delegate.isOneShot()
    override fun isDuplex() = delegate.isDuplex()
    override fun writeTo(sink: BufferedSink) {
        var written = 0L
        var lastReport = 0L
        fun report(force: Boolean = false) {
            val tick = System.nanoTime()
            if (!force && tick - lastReport < 100_000_000L) return
            lastReport = tick
            try { observer(written) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* A detached UI must not invalidate an upload. */ }
        }
        report(force = true)
        val counted = object : ForwardingSink(sink) {
            override fun write(source: okio.Buffer, byteCount: Long) {
                var remaining = byteCount
                while (remaining > 0) {
                    val size = minOf(remaining, 64 * 1024L)
                    super.write(source, size)
                    written += size
                    remaining -= size
                    report()
                }
            }
        }.buffer()
        delegate.writeTo(counted)
        counted.flush()
        report(force = true)
    }
}
