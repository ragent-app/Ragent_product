package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BackgroundCapacityPolicyTest {
    @Test fun `known capacity rejects a new target but allows an existing one`() {
        assertFailsWith<IllegalArgumentException> { checkBackgroundConnectionCapacity(true, false, 1, 1, 0) }
        checkBackgroundConnectionCapacity(true, true, 1, 1, 0)
        checkBackgroundConnectionCapacity(true, false, 1, 2, 0)
    }

    @Test fun `unknown capacity does not pretend the cached default is authoritative`() {
        checkBackgroundConnectionCapacity(false, false, 1, 1, 0)
    }

    @Test fun `active throttle reports its remaining time instead of a quota claim`() {
        val error = assertFailsWith<AccountSessionException> { checkBackgroundConnectionCapacity(false, false, 1, 1, 19_000) }
        assertEquals(429, error.statusCode)
        assertEquals(19_000L, error.retryAfterMs)
        assertEquals(true, error.retryable)
    }
}
