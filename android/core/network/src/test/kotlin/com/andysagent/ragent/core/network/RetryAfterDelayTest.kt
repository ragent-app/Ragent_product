package com.andysagent.ragent.core.network

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import java.time.Instant

class RetryAfterDelayTest {
    @Test fun `the stricter cooldown wins when both sources are present`() {
        assertEquals(9_000L, ApiResponse(429, """{"retryAfterMs":1250}""", mapOf("Retry-After" to "9")).retryAfterDelayMs())
        assertEquals(12_000L, ApiResponse(429, """{"retryAfterMs":12000}""", mapOf("retry-after" to "9")).retryAfterDelayMs())
        assertEquals(9_000L, ApiResponse(429, """{"retryAfterMs":0}""", mapOf("Retry-After" to "9")).retryAfterDelayMs())
    }

    @Test fun `individual hints and invalid input remain supported`() {
        assertEquals(2_500L, ApiResponse(429, """{"retryAfterMs":2500}""").retryAfterDelayMs())
        assertEquals(8_000L, ApiResponse(429, "{}", mapOf("Retry-After" to "8")).retryAfterDelayMs())
        assertEquals(0L, ApiResponse(429, "{}", mapOf("Retry-After" to "0")).retryAfterDelayMs())
        assertNull(ApiResponse(429, "invalid", mapOf("Retry-After" to "-1")).retryAfterDelayMs())
    }

    @Test fun `HTTP date cooldown is measured from the current time`() {
        val now = Instant.parse("2015-10-21T07:27:54Z")
        assertEquals(6_000L, ApiResponse(429, "{}", mapOf("Retry-After" to "Wed, 21 Oct 2015 07:28:00 GMT"))
            .retryAfterDelayMs(now))
        assertEquals(0L, ApiResponse(429, "{}", mapOf("Retry-After" to "Wed, 21 Oct 2015 07:27:00 GMT"))
            .retryAfterDelayMs(now))
    }
}
