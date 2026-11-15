package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import org.junit.Assert.*
import org.junit.Test

class WorkbenchNavigationProjectionTest {
    @Test fun newlyLoadedAccountComputersReachRetainedSettings() {
        val initial = WorkbenchUiState()
        val computer = RemoteTarget(instanceId = "review-full", label = "Review", endpoint = "")
        val updated = initial.copy(remoteTargets = listOf(computer), activeRemoteTargetId = computer.instanceId)
        assertNotEquals(initial.navigationProjection(), updated.navigationProjection())
        assertEquals(listOf(computer), updated.navigationProjection().remoteTargets)
        assertEquals(computer.instanceId, updated.navigationProjection().activeRemoteTargetId)
    }
    @Test fun targetSelectionAndAccountDirectoryChangesAreNotFrozen() {
        val initial = WorkbenchUiState(activeRemoteTargetId = "first")
        assertNotEquals(initial.navigationProjection(), initial.copy(activeRemoteTargetId = "second").navigationProjection())
        val computer = RemoteTarget(instanceId = "review-full", label = "Review", endpoint = "")
        assertEquals(listOf(computer), initial.copy(accountComputers = listOf(computer)).navigationProjection().accountComputers)
    }
    @Test fun tokenAndComposerChangesLeaveNavigationEqual() {
        val initial = WorkbenchUiState()
        val streaming = initial.copy(timelineItems = listOf(TimelineItem.Message("reply", 1, TimelineRole.Agent, "partial", false)),
            composerText = "draft", messageCount = 1, unseenCount = 1)
        assertEquals(initial.navigationProjection(), streaming.navigationProjection())
    }
}