package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.LocalRagentColors

/** Connectivity is an observation limit, never a terminal task status. */
internal fun journeyFeedbackResource(state: WorkbenchUiState): Int? = when {
    state.connection != AgentConnectionStatus.Connected &&
        (state.activeRemoteTargetId != null || state.sessionId != null) -> R.string.journey_connection_uncertain
    state.stopRequest == StopRequestState.AwaitingConfirmation -> R.string.journey_stop_waiting
    state.stopRequest == StopRequestState.OutcomeUnknown -> R.string.journey_stop_unknown
    else -> null
}

@Composable
internal fun JourneyRunFeedback(state: WorkbenchUiState, onReconnect: () -> Unit, modifier: Modifier = Modifier) {
    val message = journeyFeedbackResource(state) ?: return
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)
        .testTag("journey-run-feedback").semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(message), style = MaterialTheme.typography.bodySmall,
            color = LocalRagentColors.current.secondaryContent)
        if (state.connection !in setOf(AgentConnectionStatus.Connected,
                AgentConnectionStatus.Connecting, AgentConnectionStatus.Reconnecting) ||
            state.stopRequest == StopRequestState.OutcomeUnknown) {
            AgentoButton(stringResource(R.string.workbench_reconnect), onClick = onReconnect, secondary = true)
        }
    }
}
