package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.OrganizationConversationContent
import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.layout.LayoutBounds
import com.andysagent.ragent.feature.organization.presentation.NodeActionKind
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardChannelTabUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardMessageUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmHarnessBadgeUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmOverviewUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmStallBadgeUiState
import com.andysagent.ragent.feature.organization.ui.OrganizationScreenContent
import com.andysagent.ragent.feature.organization.ui.SwarmBoardPanel
import com.andysagent.ragent.feature.organization.ui.SwarmOverviewBar
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "ko-rKR-w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OrganizationParityUiTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun tappingMemberShowsLoadingInsteadOfFlashingOfflineEmptyWhileConnected() {
        val gate = CompletableDeferred<ApiResponse>()
        val transport = object : RagentTransport {
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override val connectionState: StateFlow<RuntimeConnectionState> =
                MutableStateFlow(RuntimeConnectionState.Connected)

            override suspend fun execute(request: ApiRequest): ApiResponse = gate.await()
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }

        rule.setContent {
            RagentTheme(darkTheme = false) {
                OrganizationConversationContent(
                    transport = transport,
                    organizationId = "org_1",
                    nodeId = "lead",
                    targetId = "local",
                    identityScope = "scope_1",
                    rootSessionId = "sess_root",
                    memberRef = "lead",
                )
            }
        }
        rule.waitForIdle()

        rule.onAllNodesWithText("연결 끊김 · 사용 가능한 메시지 없음").assertCountEquals(0)
        rule.onNodeWithText("대화를 불러오는 중…").assertIsDisplayed()
    }

    @Test
    fun swarmOverviewAndBoardRenderReadOnlyVsWritableComposerStrictness() {
        val baseOverview = SwarmOverviewUiState(
            mode = "ragent_swarm",
            workingCount = 1,
            waitingCount = 2,
            stoppedCount = 0,
            killedCount = 1,
            isDone = false,
            showSwarmCounts = true,
            isReadOnlyNative = false,
            harnesses = listOf(SwarmHarnessBadgeUiState("claude", 2)),
            stalls = listOf(SwarmStallBadgeUiState("s1", "[stall] worker stuck")),
        )
        val nativeOverview = SwarmOverviewUiState(
            mode = "provider_native",
            isDone = false,
            showSwarmCounts = false,
            isReadOnlyNative = true,
            stalls = listOf(SwarmStallBadgeUiState("s1", "[stall] worker stuck")),
        )
        val readOnlyBoard = SwarmBoardUiState(
            mode = "provider_native",
            readOnly = true,
            isWritable = false,
            channels = listOf(SwarmBoardChannelTabUiState("__all__", "All", 1, 0, true)),
            messages = listOf(
                SwarmBoardMessageUiState(
                    id = "m1",
                    seq = 1L,
                    channel = "main",
                    senderKind = "node",
                    senderName = "native-worker",
                    bodyMarkdown = "read-only note",
                ),
            ),
        )
        val writableBoard = SwarmBoardUiState(
            mode = "ragent_swarm",
            readOnly = false,
            isWritable = true,
            channels = listOf(
                SwarmBoardChannelTabUiState("__all__", "All", 1, 0, true),
                SwarmBoardChannelTabUiState("main", "#main", 1, 0, false),
            ),
            messages = listOf(
                SwarmBoardMessageUiState(
                    id = "m1",
                    seq = 1L,
                    channel = "main",
                    senderKind = "node",
                    senderName = "worker-1",
                    senderHarness = "codex",
                    bodyMarkdown = "done on main",
                    isDoneSignal = true,
                ),
            ),
            composerDraft = "",
        )

        var writableState by mutableStateOf(false)
        rule.setContent {
            RagentTheme(darkTheme = false) {
                Column {
                    SwarmOverviewBar(overview = if (writableState) baseOverview else nativeOverview)
                    SwarmBoardPanel(
                        board = if (writableState) writableBoard else readOnlyBoard,
                        onSelectChannel = {},
                        onComposerDraftChange = {},
                        onSelectReplySeq = {},
                        onPostMessage = {},
                    )
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("swarm-overview-bar").assertIsDisplayed()
        rule.onNodeWithText("read-only").assertIsDisplayed()
        rule.onAllNodesWithText("Working:", substring = true).assertCountEquals(0)
        rule.onNodeWithText("[stall] worker stuck").assertIsDisplayed()
        rule.onNodeWithTag("swarm-board-readonly-banner").assertIsDisplayed()
        rule.onAllNodesWithTag("swarm-board-composer").assertCountEquals(0)

        rule.runOnUiThread { writableState = true }
        rule.waitForIdle()
        rule.onNodeWithText("Working: 1").assertIsDisplayed()
        rule.onNodeWithTag("swarm-board-composer").assertIsDisplayed()
        rule.onAllNodesWithTag("swarm-board-readonly-banner").assertCountEquals(0)
    }

    @Test
    fun nonRootBlockedLeadOpensOwnConversationAndSurfacesErrorCodeAndResultPacket() {
        var rootClicked = false
        var openedConversationFor: String? = null
        val uiState = OrganizationUiState(
            organizationId = "org_1",
            rootSessionId = "sess_owner_root",
            objective = "Parity Check",
            state = "blocked",
            nodes = listOf(
                RenderedNodeUiState(
                    id = "lead",
                    x = 240f,
                    y = 240f,
                    radiusDp = 32f,
                    role = NodeRole.EXECUTIVE,
                    domain = AgentDomain.GENERAL,
                    displayName = "Lead Agent",
                    runtimeState = NodeRuntimeState.BLOCKED,
                    action = NodeActionKind.BLOCKED,
                    hasBlocker = true,
                    blockerText = "MCP_ORGANIZATION_CAPABILITY_MISSING",
                    failureCode = "MCP_ORGANIZATION_CAPABILITY_MISSING",
                    resultPacketSummary = "ResultPacket: rsp_lead_99",
                    accessibilityText = "Lead Agent, blocked, failure: MCP_ORGANIZATION_CAPABILITY_MISSING, ResultPacket: rsp_lead_99",
                ),
            ),
            bounds = LayoutBounds(0f, 0f, 480f, 480f),
        )

        rule.setContent {
            RagentTheme(darkTheme = false) {
                OrganizationScreenContent(
                    uiState = uiState,
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
                    modifier = Modifier.fillMaxSize(),
                    embedded = true,
                    embeddedRootId = null,
                    onRootClick = { rootClicked = true },
                    conversationContent = { nodeId, mod ->
                        openedConversationFor = nodeId
                        androidx.compose.material3.Text("conversation:$nodeId", modifier = mod)
                    },
                )
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("node-status-caption-lead").assertIsDisplayed()
        rule.onNodeWithText("MCP_ORGANIZATION_CAPABILITY_MISSING", substring = true).assertIsDisplayed()

        rule.onNodeWithContentDescription("MCP_ORGANIZATION_CAPABILITY_MISSING", substring = true).performClick()
        rule.waitForIdle()

        assertFalse(rootClicked)
        assertEquals("lead", openedConversationFor)
        rule.onNodeWithText("ResultPacket: rsp_lead_99", substring = true).assertIsDisplayed()
        rule.onNodeWithText("conversation:lead").assertIsDisplayed()
    }
}
