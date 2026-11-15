package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.RemoteTarget
import kotlin.test.Test
import kotlin.test.assertEquals

class ActiveComputerDisplayNameTest {
    @Test
    fun `active computer alias wins over the paired Android device name`() {
        val name = activeComputerDisplayName(
            activeTargetId = "windows-instance",
            remoteTargets = listOf(
                RemoteTarget(
                    instanceId = "windows-instance",
                    label = "Windows",
                    endpoint = "https://control.example.com",
                ),
            ),
            computers = listOf(Computer("android-device", "Android 7f9a", connected = true)),
            fallback = "This computer",
        )

        assertEquals("Windows", name)
    }

    @Test
    fun `paired device name remains a fallback for legacy connections`() {
        val name = activeComputerDisplayName(
            activeTargetId = null,
            remoteTargets = emptyList(),
            computers = listOf(Computer("android-device", "Android device", connected = true)),
            fallback = "This computer",
        )

        assertEquals("Android device", name)
    }
}
