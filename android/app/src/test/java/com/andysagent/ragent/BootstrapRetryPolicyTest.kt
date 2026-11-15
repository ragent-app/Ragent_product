package com.andysagent.ragent

import kotlin.test.Test
import kotlin.test.assertEquals

class BootstrapRetryPolicyTest {
    @Test
    fun `bootstrap retry delay doubles and caps`() {
        assertEquals(1_000L, bootstrapRetryDelayMs(0))
        assertEquals(2_000L, bootstrapRetryDelayMs(1))
        assertEquals(4_000L, bootstrapRetryDelayMs(2))
        assertEquals(30_000L, bootstrapRetryDelayMs(5))
        assertEquals(30_000L, bootstrapRetryDelayMs(99))
    }
}
