package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationApi
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel

/** A separate, local-only view model: the sample never reaches the real repository or cache. */
@Composable
internal fun OrganizationDemoScreen(onBack: () -> Unit) {
    val demoFactory = remember {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                val projection = OrganizationProjectionDto(
                        organizationId = "demo_only",
                        objective = "优化聊天体验",
                        state = "idle",
                        nodes = listOf(
                            OrganizationNodeDto(id = "lead", role = "executive", domain = "architecture", displayName = "负责人"),
                            OrganizationNodeDto(id = "planning", parentId = "lead", role = "manager", domain = "architecture", displayName = "规划"),
                            OrganizationNodeDto(id = "android", parentId = "planning", role = "worker", domain = "android", displayName = "Android开发"),
                            OrganizationNodeDto(id = "backend", parentId = "planning", role = "worker", domain = "backend", displayName = "后端开发"),
                            OrganizationNodeDto(id = "review", parentId = "planning", role = "reviewer", domain = "security", displayName = "质量审核"),
                        ),
                        edges = listOf(
                            OrganizationEdgeDto(id = "lead-plan", parentId = "lead", childId = "planning", type = "MANAGES"),
                            OrganizationEdgeDto(id = "plan-android", parentId = "planning", childId = "android", type = "MANAGES"),
                            OrganizationEdgeDto(id = "plan-backend", parentId = "planning", childId = "backend", type = "MANAGES"),
                            OrganizationEdgeDto(id = "plan-review", parentId = "planning", childId = "review", type = "REVIEWS"),
                        ),
                        phases = emptyList(), activeCommunications = emptyList(), recentEvents = emptyList(),
                )
                val api = object : OrganizationApi {
                    override suspend fun getProjection(organizationId: String, version: Int, sinceEventId: Long) = Result.success(projection)
                    override suspend fun getSessionOrganization(sessionId: String): Result<OrganizationProjectionDto?> = Result.success(projection)
                }
                val repository = RealOrganizationRepository(api)
                repository.applyProjection(projection)
                val model = OrganizationViewModel(repository)
                return model as T
            }
        }
    }
    val model: OrganizationViewModel = viewModel(key = "local-organization-demo", factory = demoFactory)
    val colors = LocalRagentColors.current
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
        Column(Modifier.fillMaxSize().background(colors.canvas).clickable(
            interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {},
        )) {
            OrganizationScreen(model, modifier = Modifier.weight(1f), onBack = onBack, isDemo = true)
        }
    }
    }
}
