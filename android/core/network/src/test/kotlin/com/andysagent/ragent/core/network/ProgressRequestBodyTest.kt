package com.andysagent.ragent.core.network

import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import okio.ForwardingSink
import okio.buffer
import java.io.IOException
import kotlin.test.*

class ProgressRequestBodyTest {
    @Test fun bodyWritesAreMeasuredAndEachAttemptResetsWithoutChangingBytes() {
        val payload = ByteArray(180_000) { (it % 127).toByte() }
        val progress = mutableListOf<Long>()
        val body = ProgressRequestBody(payload.toRequestBody(), progress::add)
        repeat(2) {
            progress.clear()
            val output = Buffer()
            body.writeTo(output)
            assertEquals(0L, progress.first())
            assertEquals(payload.size.toLong(), progress.last())
            assertTrue(progress.zipWithNext().all { (a, b) -> a <= b })
            assertContentEquals(payload, output.readByteArray())
        }
    }

    @Test fun failedSinkNeverReportsUnwrittenRemainderAndObserverFailureDoesNotCorruptBody() {
        val payload = ByteArray(180_000) { 7 }
        val written = Buffer()
        val progress = mutableListOf<Long>()
        val sink = object : ForwardingSink(written) {
            override fun write(source: Buffer, byteCount: Long) {
                if (written.size > 0) throw IOException("Connection lost")
                Thread.sleep(110) // Make the first successful chunk observable through the throttle.
                super.write(source, byteCount)
            }
        }.buffer()
        assertFailsWith<IOException> { ProgressRequestBody(payload.toRequestBody(), progress::add).writeTo(sink) }
        assertEquals(65_536L, written.size)
        assertEquals(written.size, progress.last())
        assertTrue(progress.none { it == payload.size.toLong() })
        val output = Buffer()
        ProgressRequestBody(payload.toRequestBody()) { error("Detached renderer") }.writeTo(output)
        assertContentEquals(payload, output.readByteArray())
    }
}
