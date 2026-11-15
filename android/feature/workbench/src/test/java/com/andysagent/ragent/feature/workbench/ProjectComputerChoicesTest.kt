package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.RemoteTargetAccessState
import kotlin.test.Test
import kotlin.test.assertEquals

class ProjectComputerChoicesTest {
    @Test fun `revoked computers cannot be selected while offline and unpaired computers remain available`() {
        val targets = listOf(
            RemoteTarget(instanceId = "revoked", label = "Old", endpoint = "", accessState = RemoteTargetAccessState.Revoked),
            RemoteTarget(instanceId = "online", label = "Online", endpoint = "", accessState = RemoteTargetAccessState.Connected),
            RemoteTarget(instanceId = "offline", label = "Offline", endpoint = "", accessState = RemoteTargetAccessState.Offline),
            RemoteTarget(instanceId = "unpaired", label = "Unpaired", endpoint = "", accessState = RemoteTargetAccessState.NeedsPairing),
        )
        assertEquals(listOf("online", "offline", "unpaired"), projectComputerChoices(targets).map { it.instanceId })
        assertEquals(4, targets.size)
    }
}
