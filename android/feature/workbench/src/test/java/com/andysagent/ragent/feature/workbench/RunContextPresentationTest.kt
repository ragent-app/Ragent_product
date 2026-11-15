package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunContextPresentationTest {
    @Test fun `real context is model then engine then run metadata`() {
        val context = runContextPresentation(RunMetricsUiState(model = " Model ", provider = "Provider",
            runtimeFamily = "Runtime", runId = "run-42", phase = "working", failureReason = "reason"))
        assertEquals(RunContextPresentation("Model", "Provider · Runtime", "run-42", "working", "reason"), context)
    }
    @Test fun `no placeholder or duplicated engine values are manufactured`() {
        assertTrue(runContextPresentation(RunMetricsUiState(model = " ", provider = "\n")).isEmpty)
        assertEquals(RunContextPresentation("Engine", null, null, null, null),
            runContextPresentation(RunMetricsUiState(provider = "Engine", runtimeFamily = "Engine")))
        assertEquals(RunContextPresentation(null, null, "id", null, "failure"),
            runContextPresentation(RunMetricsUiState(runId = "id", failureReason = "failure")))
    }
}
