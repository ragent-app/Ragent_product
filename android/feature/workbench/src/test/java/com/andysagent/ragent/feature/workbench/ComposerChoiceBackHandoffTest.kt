package com.andysagent.ragent.feature.workbench

import org.junit.Assert.*
import org.junit.Test

class ComposerChoiceBackHandoffTest {
    @Test fun openingClaimsBackBeforeTheNextRender() {
        val handoff = ComposerChoiceBackHandoff()
        handoff.observe(false, false)
        handoff.dispatch(WorkbenchEvent.OpenRuntimePicker)
        assertEquals(WorkbenchEvent.CloseRuntimePicker, handoff.dismissal)
        handoff.dispatch(WorkbenchEvent.OpenEffortPicker)
        assertEquals(WorkbenchEvent.CloseEffortPicker, handoff.dismissal)
    }

    @Test fun cancellationAndLeafCommitReleaseOnlyChoiceOwnership() {
        val handoff = ComposerChoiceBackHandoff()
        handoff.dispatch(WorkbenchEvent.OpenRuntimePicker)
        handoff.dispatch(WorkbenchEvent.CloseEffortPicker)
        assertEquals(WorkbenchEvent.CloseRuntimePicker, handoff.dismissal)
        handoff.dispatch(WorkbenchEvent.CloseRuntimePicker)
        assertNull(handoff.dismissal)
        handoff.dispatch(WorkbenchEvent.OpenRuntimePicker)
        handoff.dispatch(WorkbenchEvent.SelectModel("example"))
        assertNull(handoff.dismissal)
        handoff.dispatch(WorkbenchEvent.OpenEffortPicker)
        handoff.dispatch(WorkbenchEvent.SelectModel("previous-choice"))
        assertEquals(WorkbenchEvent.CloseEffortPicker, handoff.dismissal)
    }

    @Test fun externalStateAndClosingChatReconcileBackOwnership() {
        val handoff = ComposerChoiceBackHandoff()
        handoff.observe(false, true)
        assertEquals(WorkbenchEvent.CloseEffortPicker, handoff.dismissal)
        handoff.observe(true, false)
        assertEquals(WorkbenchEvent.CloseRuntimePicker, handoff.dismissal)
        handoff.observe(false, false)
        assertNull(handoff.dismissal)
        handoff.dispatch(WorkbenchEvent.OpenEffortPicker)
        handoff.dispatch(WorkbenchEvent.CloseChat)
        assertNull(handoff.dismissal)
    }
}
