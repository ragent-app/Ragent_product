package com.andysagent.ragent.feature.organization.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModelFactory

/** A separate, local-only view model: the sample never reaches the real repository or cache. */
@Composable
internal fun OrganizationDemoScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val demoFactory = remember {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                val model = OrganizationViewModelFactory().create(OrganizationViewModel::class.java)
                model.applyProjection(
                    OrganizationViewModelFactory.sampleOrganizationProjection("demo_only").copy(
                        objective = "示例：团队协作架构",
                        state = "idle",
                        nodes = listOf(
                            OrganizationNodeDto(id = "lead", role = "executive", domain = "architecture", displayName = "负责人"),
                            OrganizationNodeDto(id = "planning", parentId = "lead", role = "manager", domain = "architecture", displayName = "规划"),
                            OrganizationNodeDto(id = "android", parentId = "planning", role = "worker", domain = "android", displayName = "Android开发"),
                            OrganizationNodeDto(id = "backend", parentId = "planning", role = "worker", domain = "backend", displayName = "后端开发"),
                            OrganizationNodeDto(id = "review", parentId = "lead", role = "reviewer", domain = "security", displayName = "审核"),
                        ),
                        edges = listOf(
                            OrganizationEdgeDto(id = "lead-plan", parentId = "lead", childId = "planning", type = "MANAGES"),
                            OrganizationEdgeDto(id = "plan-android", parentId = "planning", childId = "android", type = "MANAGES"),
                            OrganizationEdgeDto(id = "plan-backend", parentId = "planning", childId = "backend", type = "MANAGES"),
                            OrganizationEdgeDto(id = "lead-review", parentId = "lead", childId = "review", type = "REVIEWS"),
                        ),
                        phases = emptyList(), activeCommunications = emptyList(), recentEvents = emptyList(),
                    ),
                )
                return model as T
            }
        }
    }
    val model: OrganizationViewModel = viewModel(key = "local-organization-demo", factory = demoFactory)
    val colors = LocalRagentColors.current
    CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
        Column(Modifier.fillMaxSize().background(colors.canvas).clickable(
            interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {},
        )) {
            TextButton(onClick = onBack) { Text("退出演示") }
            Text("演示数据 · 仅用于展示，不会修改真实团队", Modifier.padding(horizontal = 16.dp))
            Text("实线：管理关系    虚线：审核关系", Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            OrganizationScreen(model, modifier = Modifier.weight(1f), showNodeLabels = true)
        }
    }
}
