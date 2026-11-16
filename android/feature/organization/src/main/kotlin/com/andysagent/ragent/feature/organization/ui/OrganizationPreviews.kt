package com.andysagent.ragent.feature.organization.ui

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import com.andysagent.ragent.feature.organization.presentation.ActivityFeedItemUiState
import com.andysagent.ragent.feature.organization.presentation.NodeDetailUiState
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import com.andysagent.ragent.feature.organization.presentation.ParticleUiState
import com.andysagent.ragent.feature.organization.presentation.RenderedEdgeUiState
import com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState

private fun preview3NodeState(): OrganizationUiState {
    val root = RenderedNodeUiState(
        id = "root",
        x = 540f,
        y = 300f,
        radiusDp = 24f,
        role = NodeRole.EXECUTIVE,
        domain = AgentDomain.ARCHITECTURE,
        displayName = "Root Leader",
        runtimeState = NodeRuntimeState.WORKING,
    )
    val backend = RenderedNodeUiState(
        id = "backend",
        x = 340f,
        y = 650f,
        radiusDp = 20f,
        role = NodeRole.MANAGER,
        domain = AgentDomain.BACKEND,
        displayName = "Backend Lead",
        runtimeState = NodeRuntimeState.WORKING,
    )
    val android = RenderedNodeUiState(
        id = "android",
        x = 740f,
        y = 650f,
        radiusDp = 20f,
        role = NodeRole.MANAGER,
        domain = AgentDomain.MOBILE,
        displayName = "Android Lead",
        runtimeState = NodeRuntimeState.IDLE,
    )

    val edges = listOf(
        RenderedEdgeUiState(
            id = "e1",
            fromNodeId = "root",
            toNodeId = "backend",
            start = EdgePoint(540f, 300f),
            end = EdgePoint(340f, 650f),
            control1 = EdgePoint(540f, 460f),
            control2 = EdgePoint(340f, 490f),
        ),
        RenderedEdgeUiState(
            id = "e2",
            fromNodeId = "root",
            toNodeId = "android",
            start = EdgePoint(540f, 300f),
            end = EdgePoint(740f, 650f),
            control1 = EdgePoint(540f, 460f),
            control2 = EdgePoint(740f, 490f),
        ),
    )

    val particles = listOf(
        ParticleUiState("p1", CommunicationType.TASK_ASSIGNED, 440f, 475f, 0.5f),
    )

    return OrganizationUiState(
        organizationId = "org_preview_3",
        objective = "Build Ragent Windows Runtime",
        revisionNumber = 1,
        state = "running",
        nodes = listOf(root, backend, android),
        edges = edges,
        particles = particles,
        activityFeed = listOf(
            ActivityFeedItemUiState("a1", "2m ago", "Backend Lead started working", CommunicationType.TASK_ASSIGNED),
        ),
    )
}

@Preview(name = "3 Nodes - Dark", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun PreviewOrganization3NodesDark() {
    RagentTheme(darkTheme = true) {
        Box(modifier = Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)) {
            OrganizationScreenContent(
                uiState = preview3NodeState(),
                onPan = {},
                onZoom = {},
                onReset = {},
                onNodeClick = {},
                onNodeDoubleTap = {},
                onDismissSheet = {},
                onOpenDetail = {},
                onCloseDetail = {},
                onToggleActivityFeed = {},
                onApproveBlocker = {},
                onRejectBlocker = {},
            )
        }
    }
}

@Preview(name = "3 Nodes - Light", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun PreviewOrganization3NodesLight() {
    RagentTheme(darkTheme = false) {
        Box(modifier = Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)) {
            OrganizationScreenContent(
                uiState = preview3NodeState(),
                onPan = {},
                onZoom = {},
                onReset = {},
                onNodeClick = {},
                onNodeDoubleTap = {},
                onDismissSheet = {},
                onOpenDetail = {},
                onCloseDetail = {},
                onToggleActivityFeed = {},
                onApproveBlocker = {},
                onRejectBlocker = {},
            )
        }
    }
}

@Preview(name = "Blocked Organization", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun PreviewOrganizationBlocked() {
    val state = preview3NodeState().copy(
        nodes = preview3NodeState().nodes.map {
            if (it.id == "backend") it.copy(
                runtimeState = NodeRuntimeState.BLOCKED,
                hasBlocker = true,
                blockerText = "Requires elevation approval for named pipe driver",
            ) else it
        },
        approvalOverlay = com.andysagent.ragent.feature.organization.presentation.ApprovalOverlayUiState(
            id = "backend",
            requestingNodeName = "Backend Lead",
            actionSummary = "Privileged operation: Windows driver registration",
            details = "Driver installation requires elevated permissions on host.",
        ),
    )
    RagentTheme(darkTheme = true) {
        Box(modifier = Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)) {
            OrganizationScreenContent(
                uiState = state,
                onPan = {},
                onZoom = {},
                onReset = {},
                onNodeClick = {},
                onNodeDoubleTap = {},
                onDismissSheet = {},
                onOpenDetail = {},
                onCloseDetail = {},
                onToggleActivityFeed = {},
                onApproveBlocker = {},
                onRejectBlocker = {},
            )
        }
    }
}

@Preview(name = "Reviewing Organization", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun PreviewOrganizationReviewing() {
    val reviewer = RenderedNodeUiState(
        id = "rev",
        x = 540f,
        y = 650f,
        radiusDp = 16f,
        role = NodeRole.REVIEWER,
        domain = AgentDomain.SECURITY,
        displayName = "Security Reviewer",
        runtimeState = NodeRuntimeState.REVIEWING,
    )
    val state = preview3NodeState().copy(
        nodes = preview3NodeState().nodes + reviewer,
    )
    RagentTheme(darkTheme = true) {
        Box(modifier = Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)) {
            OrganizationScreenContent(
                uiState = state,
                onPan = {},
                onZoom = {},
                onReset = {},
                onNodeClick = {},
                onNodeDoubleTap = {},
                onDismissSheet = {},
                onOpenDetail = {},
                onCloseDetail = {},
                onToggleActivityFeed = {},
                onApproveBlocker = {},
                onRejectBlocker = {},
            )
        }
    }
}

@Preview(name = "Completed Organization", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun PreviewOrganizationCompleted() {
    val state = preview3NodeState().copy(
        isCompleted = true,
        state = "completed",
        leaderSummary = "All 3 deliverables verified. Windows Named Pipe Executor operational with 23/23 tests passing.",
        nodes = preview3NodeState().nodes.map { it.copy(runtimeState = NodeRuntimeState.DONE) },
    )
    RagentTheme(darkTheme = true) {
        Box(modifier = Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)) {
            OrganizationScreenContent(
                uiState = state,
                onPan = {},
                onZoom = {},
                onReset = {},
                onNodeClick = {},
                onNodeDoubleTap = {},
                onDismissSheet = {},
                onOpenDetail = {},
                onCloseDetail = {},
                onToggleActivityFeed = {},
                onApproveBlocker = {},
                onRejectBlocker = {},
            )
        }
    }
}
