package com.andysagent.agentoc.feature.organization.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.feature.organization.data.RealOrganizationApi
import com.andysagent.agentoc.feature.organization.data.RealOrganizationRepository
import com.andysagent.agentoc.feature.organization.data.OrganizationNodeDto
import com.andysagent.agentoc.feature.organization.presentation.OrganizationViewModel
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun ConnectedOrganizationScreen(transport: AgentoCTransport, sessionId: String, targetId: String?, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, onBack: () -> Unit) {
    val repository = remember(transport, targetId, sessionId) { RealOrganizationRepository(RealOrganizationApi(transport)) }
    val factory = remember(repository) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OrganizationViewModel(repository) as T
        }
    }
    val organizationViewModel: OrganizationViewModel = viewModel(key = "organization:${targetId.orEmpty()}:$sessionId", factory = factory)
    var status by remember(transport, targetId, sessionId) { mutableStateOf("Loading organization…") }
    var loaded by remember(transport, targetId, sessionId) { mutableStateOf(false) }
    var refresh by remember(transport, targetId, sessionId) { mutableStateOf(0) }
    var organizationId by remember(transport, targetId, sessionId) { mutableStateOf<String?>(null) }
    var workOpen by remember(transport, targetId, sessionId) { mutableStateOf(selectedResponsibilityId != null) }
    var messagesOpen by remember(transport, targetId, sessionId) { mutableStateOf(false) }
    var nodes by remember(transport, targetId, sessionId) { mutableStateOf<List<OrganizationNodeDto>>(emptyList()) }
    LaunchedEffect(transport, targetId, sessionId, refresh) {
        loaded = false
        status = "Loading organization…"
        RealOrganizationApi(transport).getSessionOrganization(sessionId).fold(
            onSuccess = { projection ->
                if (projection == null) status = "No organization is available for this session."
                else { organizationViewModel.applyProjection(projection); organizationId = projection.organizationId; nodes = projection.nodes; loaded = true }
            },
            onFailure = { status = "Organization unavailable: ${it.message ?: "request failed"}" },
        )
    }
    Column(Modifier.fillMaxSize().background(LocalAgentocColors.current.canvas)) {
        TextButton(onClick = onBack) { Text("Back") }
        if (loaded && workOpen && organizationId != null) FactoryWorkScreen(transport, organizationId!!, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, sessionId, onBack = { workOpen = false })
        else if (loaded && messagesOpen && organizationId != null) TeamMessagesScreen(transport, organizationId!!, nodes, onBack = { messagesOpen = false })
        else if (loaded) {
            TextButton(onClick = { workOpen = true }) { Text("Work items") }
            TextButton(onClick = { messagesOpen = true }) { Text("Team messages") }
            OrganizationScreen(organizationViewModel, modifier = Modifier.weight(1f))
        }
        else {
            Text(status)
            TextButton(onClick = { refresh++ }) { Text("Retry") }
        }
    }
}
