package com.andysagent.ragent.feature.workbench

import java.io.ByteArrayInputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class AttachmentThumbnailReadTest {
    @Test fun acceptsExactLimitAndRejectsOneByteMore() = runBlocking {
        val data = ByteArray(1025) { (it % 251).toByte() }
        assertArrayEquals(data.copyOf(1024), readThumbnailSourceBounded(ByteArrayInputStream(data.copyOf(1024)), 1024))
        assertNull(readThumbnailSourceBounded(ByteArrayInputStream(data), 1024))
    }

    @Test fun acceptsEmptyStreamAndRejectsDataAtZeroLimit() = runBlocking {
        assertArrayEquals(ByteArray(0), readThumbnailSourceBounded(ByteArrayInputStream(ByteArray(0)), 0))
        assertNull(readThumbnailSourceBounded(ByteArrayInputStream(byteArrayOf(1)), 0))
    }

    @Test fun cancelledReadDoesNotReturnData() {
        try {
            runBlocking {
                cancel()
                readThumbnailSourceBounded(ByteArrayInputStream(byteArrayOf(1)))
            }
            fail("Expected cancellation")
        } catch (_: CancellationException) { }
    }
}
