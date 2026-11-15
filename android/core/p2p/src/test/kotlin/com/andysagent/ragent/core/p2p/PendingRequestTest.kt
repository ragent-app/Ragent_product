package com.andysagent.ragent.core.p2p

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

class PendingRequestTest {
    @Test fun `response and transport close complete a request only once`() {
        val executor = Executors.newFixedThreadPool(2)
        try {
            repeat(1_000) {
                val completions = AtomicInteger()
                val request = PendingRequest({ completions.incrementAndGet() }, { completions.incrementAndGet() })
                val start = CountDownLatch(1)
                val response = executor.submit { start.await(); request.onResponse(P2PHttpResponse(id = "r", status = 200)) }
                val close = executor.submit { start.await(); request.onError(Exception("closed")) }
                start.countDown()
                response.get(5, TimeUnit.SECONDS)
                close.get(5, TimeUnit.SECONDS)
                assertEquals(1, completions.get())
            }
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun `cancelled request ignores later response and close`() {
        val completions = AtomicInteger()
        val request = PendingRequest({ completions.incrementAndGet() }, { completions.incrementAndGet() })
        request.cancel()
        request.onResponse(P2PHttpResponse(id = "r", status = 200))
        request.onError(Exception("closed"))
        assertEquals(0, completions.get())
    }
}
