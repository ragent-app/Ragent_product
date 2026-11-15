package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * L2's Agent & apps surface intentionally reuses the complete Web-parity
 * management page. Keeping one page implementation prevents the session
 * picker and Settings from drifting into two different agent workflows.
 */
@Composable
fun AgentSurface(
    state: WebParityUiState,
    onParityEvent: (WebParityEvent) -> Unit,
    onEvent: (WorkbenchEvent) -> Unit,
    currentProjectId: String? = null,
    backProgress: Float = 0f,
    modifier: Modifier = Modifier,
) {
    WebParitySurface(
        page = WebParityPage.Agents,
        state = state,
        onEvent = onParityEvent,
        onBack = { onEvent(WorkbenchEvent.CloseAgents) },
        projectId = currentProjectId,
        backContentDescription = "Back to project",
        backProgress = backProgress,
        modifier = modifier,
    )
}
