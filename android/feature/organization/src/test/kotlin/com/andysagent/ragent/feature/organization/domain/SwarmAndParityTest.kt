package com.andysagent.ragent.feature.organization.domain

import androidx.compose.ui.geometry.Offset
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.feature.organization.ConversationStatus
import com.andysagent.ragent.feature.organization.data.MemberConversationRefDto
import com.andysagent.ragent.feature.organization.data.OrganizationApi
import com.andysagent.ragent.feature.organization.data.OrganizationAttemptDto
import com.andysagent.ragent.feature.organization.data.OrganizationBindingDto
import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.PostBoardMessageResponseDto
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.data.SwarmBoardChannelDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardMessageDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardPayloadDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardResponseDto
import com.andysagent.ragent.feature.organization.data.SwarmCountsDto
import com.andysagent.ragent.feature.organization.data.SwarmMemberDto
import com.andysagent.ragent.feature.organization.data.SwarmRunFailureDto
import com.andysagent.ragent.feature.organization.data.SwarmStallAlertDto
import com.andysagent.ragent.feature.organization.data.SwarmStatusDto
import com.andysagent.ragent.feature.organization.data.UnifiedMemberDto
import com.andysagent.ragent.feature.organization.data.UnifiedMembersPageDto
import com.andysagent.ragent.feature.organization.extractEventFailureReason
import com.andysagent.ragent.feature.organization.initialConversationStatusForConnection
import com.andysagent.ragent.feature.organization.layout.LayoutBounds
import com.andysagent.ragent.feature.organization.layout.LayoutResult
import com.andysagent.ragent.feature.organization.layout.NodePosition
import com.andysagent.ragent.feature.organization.presentation.NodeActionKind
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiMapper
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.feature.organization.ui.computeHasCollaborators
import com.andysagent.ragent.feature.organization.ui.resolveFormalRootNodeId
import com.andysagent.ragent.feature.organization.ui.resolveMemberConversationRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SwarmAndParityTest {
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun resolveFormalRootNodeIdNeverAliasesNonRootLead() {
        val leadOnly = listOf(
            OrganizationNodeDto(
                id = "lead",
                parentId = null,
                role = "lead",
                displayName = "Lead Agent",
                status = "blocked",
                sessionId = "sess_lead_child",
                currentBinding = OrganizationBindingDto(sessionId = "sess_lead_child", generation = 1L),
            ),
            OrganizationNodeDto(
                id = "worker-1",
                parentId = "lead",
                role = "worker",
                displayName = "Worker 1",
                status = "working",
                sessionId = "sess_worker_1",
            ),
        )

        assertNull(resolveFormalRootNodeId(leadOnly, sessionId = "sess_owner_root", rootSessionId = "sess_owner_root"))
        assertEquals("lead", resolveFormalRootNodeId(leadOnly, sessionId = "sess_lead_child", rootSessionId = "sess_lead_child"))
    }

    @Test
    fun computeHasCollaboratorsTriggersForSwarmAndBoardEvenWithoutFormalSubordinate() {
        val swarmStatus = SwarmStatusDto(
            rootSessionId = "sess_swarm",
            mode = "ragent_swarm",
            organizationId = "org_swarm",
            counts = SwarmCountsDto(working = 1, waiting = 1, stopped = 0, killed = 0, active = 2, total = 2),
            members = listOf(
                SwarmMemberDto(nodeId = "lead", name = "Lead", swarmState = "waiting"),
                SwarmMemberDto(nodeId = "worker-1", name = "Worker 1", swarmState = "working", parentNodeId = "lead"),
            ),
        )
        assertTrue(computeHasCollaborators(null, loaded = false, baseProjection = null, swarmStatus = swarmStatus, boardResponse = null))

        val boardOnly = SwarmBoardResponseDto(
            rootSessionId = "sess_native",
            mode = "provider_native",
            readOnly = true,
            board = SwarmBoardPayloadDto(
                mode = "provider_native",
                readOnly = true,
                messages = listOf(SwarmBoardMessageDto(seq = 1L, channel = "main", senderName = "agent-1", bodyMarkdown = "hello")),
            ),
        )
        assertTrue(computeHasCollaborators(null, loaded = false, baseProjection = null, swarmStatus = null, boardResponse = boardOnly))

        val soloFormal = SwarmStatusDto(
            rootSessionId = "sess_formal",
            mode = "formal_org",
            members = listOf(SwarmMemberDto(nodeId = "lead", name = "Lead", swarmState = "working")),
        )
        val soloProjection = OrganizationProjectionDto(organizationId = "org_solo", hasCreatedSubordinate = false)
        assertFalse(computeHasCollaborators(null, loaded = true, baseProjection = soloProjection, swarmStatus = soloFormal, boardResponse = null))

        val unifiedTwo = UnifiedMembersPageDto(
            rootSessionId = "sess_1",
            rootCanonicalId = "root",
            members = listOf(
                UnifiedMemberDto(canonicalId = "root"),
                UnifiedMemberDto(canonicalId = "child-1", parentCanonicalId = "root"),
            ),
        )
        assertTrue(computeHasCollaborators(unifiedTwo, loaded = false, baseProjection = null, swarmStatus = null, boardResponse = null))
    }

    @Test
    fun projectionAndSwarmFailureCodesAndResultPacketsAreMappedToNodesAndUiState() {
        val projection = OrganizationProjectionDto(
            organizationId = "org_p2",
            nodes = listOf(
                OrganizationNodeDto(
                    id = "lead",
                    role = "lead",
                    displayName = "Team Lead",
                    status = "blocked",
                    sessionId = "sess_lead",
                    blocker = OrganizationBlockerDto(
                        id = "blk_1",
                        nodeId = "lead",
                        reasonCode = "MCP_ORGANIZATION_CAPABILITY_MISSING",
                    ),
                ),
                OrganizationNodeDto(
                    id = "worker-done",
                    parentId = "lead",
                    role = "worker",
                    displayName = "Build Worker",
                    status = "completed",
                    attempt = OrganizationAttemptDto(
                        id = "att_1",
                        state = "completed",
                        resultPacketId = "rsp_build_ok_42",
                    ),
                ),
                OrganizationNodeDto(
                    id = "worker-fail",
                    parentId = "lead",
                    role = "worker",
                    displayName = "Test Worker",
                    status = "failed",
                    attempt = OrganizationAttemptDto(
                        id = "att_2",
                        state = "failed",
                        runState = "failed",
                        failureReasonCode = "SUBPROCESS_TIMEOUT",
                    ),
                ),
            ),
        )
        val state = OrganizationReducer.reduceProjection(OrganizationState(), projection)
        val swarmState = OrganizationReducer.reduceSwarmStatus(
            state,
            SwarmStatusDto(
                mode = "ragent_swarm",
                organizationId = "org_p2",
                counts = SwarmCountsDto(waiting = 1, working = 0, stopped = 2, killed = 0, active = 1, total = 3),
                members = listOf(
                    SwarmMemberDto(
                        nodeId = "lead",
                        name = "Team Lead",
                        swarmState = "stopped",
                        harness = "claude",
                        lastRunFailure = SwarmRunFailureDto(reason = "MCP_ORGANIZATION_CAPABILITY_MISSING"),
                    ),
                    SwarmMemberDto(nodeId = "worker-done", name = "Build Worker", swarmState = "stopped", harness = "codex"),
                ),
                activeStalls = listOf(
                    SwarmStallAlertDto(
                        id = "stall_1",
                        conditionKind = "idle_with_pending",
                        targetNodeId = "lead",
                        details = buildJsonObject { put("reason", JsonPrimitive("waiting on capability")) },
                        alertCount = 2,
                    ),
                ),
            ),
        )

        val lead = swarmState.nodes["lead"]
        assertNotNull(lead)
        assertEquals(NodeRuntimeState.BLOCKED, lead.runtimeState)
        assertEquals("MCP_ORGANIZATION_CAPABILITY_MISSING", lead.failureCode)
        assertEquals("MCP_ORGANIZATION_CAPABILITY_MISSING", lead.blockerText)
        assertEquals("claude", lead.harness)

        val doneWorker = swarmState.nodes["worker-done"]
        assertNotNull(doneWorker)
        assertEquals("ResultPacket: rsp_build_ok_42", doneWorker.resultPacketSummary)

        val failedWorker = swarmState.nodes["worker-fail"]
        assertNotNull(failedWorker)
        assertEquals(NodeRuntimeState.FAILED, failedWorker.runtimeState)
        assertEquals("SUBPROCESS_TIMEOUT", failedWorker.failureCode)

        val layout = LayoutResult(
            nodePositions = mapOf(
                "lead" to NodePosition("lead", 100f, 100f, 30f),
                "worker-done" to NodePosition("worker-done", 200f, 200f, 26f),
                "worker-fail" to NodePosition("worker-fail", 300f, 200f, 26f),
            ),
            edges = emptyList(),
            bounds = LayoutBounds(0f, 0f, 400f, 300f),
            rootId = "lead",
        )
        val uiState = OrganizationUiMapper.mapToUiState(
            state = swarmState,
            layout = layout,
            nodeAnimations = emptyMap(),
            activeParticles = emptyList(),
            panOffset = Offset.Zero,
            zoomScale = 1f,
            focusNodeId = null,
            selectedSheetNodeId = "lead",
            activeDetailNodeId = "worker-done",
            isActivityFeedExpanded = false,
            reduceMotion = false,
        )

        val renderedLead = uiState.nodes.first { it.id == "lead" }
        assertEquals("MCP_ORGANIZATION_CAPABILITY_MISSING", renderedLead.failureCode)
        assertTrue(renderedLead.accessibilityText.contains("MCP_ORGANIZATION_CAPABILITY_MISSING"))

        val renderedDone = uiState.nodes.first { it.id == "worker-done" }
        assertEquals("ResultPacket: rsp_build_ok_42", renderedDone.resultPacketSummary)
        assertTrue(renderedDone.accessibilityText.contains("rsp_build_ok_42"))

        assertEquals("MCP_ORGANIZATION_CAPABILITY_MISSING", uiState.selectedSheetNode?.failureCode)
        assertEquals("ResultPacket: rsp_build_ok_42", uiState.activeDetailNode?.resultPacketSummary)
        assertEquals(2, uiState.swarmOverview?.stoppedCount)
        assertEquals(1, uiState.swarmOverview?.stalls?.size)
        assertTrue(uiState.swarmOverview?.stalls?.first()?.label?.contains("waiting on capability") == true)
    }

    @Test
    fun boardDeserializationReadOnlyEnforcementAndComposerPosting() = runTest(testDispatcher) {
        val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }
        val nativeJson = """
            {
              "rootSessionId": "sess_native",
              "mode": "provider_native",
              "readOnly": true,
              "board": {
                "mode": "provider_native",
                "readOnly": true,
                "messages": [
                  { "seq": 1, "channel": "main", "senderName": "worker-a", "bodyMarkdown": "progress update", "isDoneSignal": false }
                ]
              }
            }
        """.trimIndent()
        val nativeDto = json.decodeFromString<SwarmBoardResponseDto>(nativeJson)
        assertFalse(nativeDto.isWritable)

        val fakeApi = FakeSwarmOrganizationApi(boardDto = nativeDto)
        val repo = RealOrganizationRepository(fakeApi, this)
        val vm = OrganizationViewModel(repo)
        vm.applyBoardResponse(nativeDto)
        vm.setBoardComposerDraft("owner attempt on native")
        vm.postBoardMessage("sess_native")
        advanceUntilIdle()
        assertEquals(0, fakeApi.postedMessages.size)
        assertEquals(false, vm.uiState.value.swarmBoard?.isWritable)

        val swarmBoardDto = SwarmBoardResponseDto(
            rootSessionId = "sess_swarm",
            organizationId = "org_swarm",
            mode = "ragent_swarm",
            readOnly = false,
            channels = listOf(
                SwarmBoardChannelDto(name = "main", messageCount = 1, latestSeq = 1L),
                SwarmBoardChannelDto(name = "backend", messageCount = 1, latestSeq = 2L, unreadCount = 1),
            ),
            board = SwarmBoardPayloadDto(
                mode = "ragent_swarm",
                readOnly = false,
                headSeq = 2L,
                channels = listOf(
                    SwarmBoardChannelDto(name = "main", messageCount = 1, latestSeq = 1L),
                    SwarmBoardChannelDto(name = "backend", messageCount = 1, latestSeq = 2L, unreadCount = 1),
                ),
                messages = listOf(
                    SwarmBoardMessageDto(seq = 1L, channel = "main", senderName = "lead", senderRole = "lead", senderHarness = "claude", bodyMarkdown = "kickoff"),
                    SwarmBoardMessageDto(seq = 2L, channel = "backend", senderName = "be-1", senderRole = "worker", senderHarness = "codex", bodyMarkdown = "finished", isDoneSignal = true),
                ),
            ),
        )
        fakeApi.boardDto = swarmBoardDto
        vm.applyBoardResponse(swarmBoardDto)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.swarmBoard?.isWritable == true)
        assertEquals(2, vm.uiState.value.swarmBoard?.messages?.size)

        vm.selectBoardChannel("backend")
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.swarmBoard?.messages?.size)
        assertEquals("backend", vm.uiState.value.swarmBoard?.selectedChannel)

        vm.setBoardReplyToSeq(2L)
        vm.setBoardComposerDraft("LGTM @be-1")
        vm.postBoardMessage("sess_swarm")
        advanceUntilIdle()

        assertEquals(1, fakeApi.postedMessages.size)
        val posted = fakeApi.postedMessages.single()
        assertEquals("backend", posted.channel)
        assertEquals("LGTM @be-1", posted.body)
        assertEquals(2L, posted.replyToSeq)
        assertEquals("", vm.uiState.value.swarmBoard?.composerDraft)
        assertNull(vm.uiState.value.swarmBoard?.replyToSeq)
    }

    @Test
    fun viewModelAssignsFallbackBlockedAndFailedActionForLead() = runTest(testDispatcher) {
        val repo = RealOrganizationRepository(FakeSwarmOrganizationApi(), this)
        val vm = OrganizationViewModel(repo)
        vm.updateViewportSize(800f, 600f, 1f)
        vm.applyProjection(
            OrganizationProjectionDto(
                organizationId = "org_lead",
                rootSessionId = "sess_owner",
                nodes = listOf(
                    OrganizationNodeDto(
                        id = "lead",
                        role = "lead",
                        displayName = "Lead",
                        status = "blocked",
                        sessionId = "sess_lead",
                        blocker = OrganizationBlockerDto(nodeId = "lead", reasonCode = "MCP_ORGANIZATION_CAPABILITY_MISSING"),
                    ),
                ),
            ),
        )
        vm.setNodeActions(mapOf("lead" to NodeActionKind.WAITING_SUBORDINATES))
        val deadline = System.currentTimeMillis() + 5_000L
        while ((vm.uiState.value.nodes.firstOrNull { it.id == "lead" }?.action != NodeActionKind.BLOCKED) &&
            System.currentTimeMillis() < deadline
        ) {
            advanceUntilIdle()
            Thread.sleep(15)
        }
        val leadNode = vm.uiState.value.nodes.firstOrNull { it.id == "lead" }
        assertNotNull(leadNode)
        assertEquals(NodeActionKind.BLOCKED, leadNode.action)
    }

    @Test
    fun auditFixesPreserveChannelHideNativeCountsAndUseOrganizationConversationSource() = runTest(testDispatcher) {
        val nativeDto = SwarmBoardResponseDto(
            rootSessionId = "sess_native",
            mode = "provider_native",
            readOnly = true,
            board = SwarmBoardPayloadDto(
                mode = "provider_native",
                readOnly = true,
                messages = listOf(SwarmBoardMessageDto(seq = 1L, channel = "main", senderName = "w1", bodyMarkdown = "hi")),
            ),
        )
        val fakeApi = FakeSwarmOrganizationApi(boardDto = nativeDto)
        val repo = RealOrganizationRepository(fakeApi, this)
        val vm = OrganizationViewModel(repo)
        vm.applyBoardResponse(nativeDto)
        advanceUntilIdle()
        val nativeOverview = vm.uiState.value.swarmOverview
        assertNotNull(nativeOverview)
        assertTrue(nativeOverview.isReadOnlyNative)
        assertFalse(nativeOverview.showSwarmCounts)

        vm.selectBoardChannel("backend")
        assertEquals("backend", vm.activeBoardChannel())
        vm.refreshSwarmAndBoard("sess_swarm")
        advanceUntilIdle()
        assertEquals("backend", fakeApi.boardChannelsRequested.lastOrNull())

        assertNull(resolveMemberConversationRef(member = null, descriptor = null))
        assertEquals(
            "opaque_base64url_ref",
            resolveMemberConversationRef(
                member = null,
                descriptor = UnifiedMemberDto(
                    canonicalId = "m1",
                    conversation = MemberConversationRefDto(ref = "opaque_base64url_ref", generation = 1L, scope = "activity_only"),
                ),
            ),
        )
    }

    @Test
    fun conversationInitialStatusDoesNotFlashOfflineWhileConnectedAndExtractsFailureReason() {
        assertEquals(ConversationStatus.Loading, initialConversationStatusForConnection(RuntimeConnectionState.Connected))
        assertEquals(ConversationStatus.Denied, initialConversationStatusForConnection(RuntimeConnectionState.AuthenticationRequired))
        assertEquals(ConversationStatus.Offline, initialConversationStatusForConnection(RuntimeConnectionState.Disconnected))

        val events = listOf(
            SessionEventDto(seq = 1L, type = "run.started", runState = "running"),
            SessionEventDto(
                seq = 2L,
                type = "run.failed",
                runState = "failed",
                executorUnavailableReasonCode = "MCP_ORGANIZATION_CAPABILITY_MISSING",
            ),
        )
        assertEquals("MCP_ORGANIZATION_CAPABILITY_MISSING", extractEventFailureReason(events))
    }

    private data class RecordedBoardPost(
        val sessionId: String,
        val channel: String,
        val body: String,
        val replyToSeq: Long?,
    )

    private class FakeSwarmOrganizationApi(
        var swarmDto: SwarmStatusDto? = null,
        var boardDto: SwarmBoardResponseDto? = null,
    ) : OrganizationApi {
        val postedMessages = mutableListOf<RecordedBoardPost>()
        val boardChannelsRequested = mutableListOf<String?>()

        override suspend fun getProjection(organizationId: String, version: Int, sinceEventId: Long) =
            Result.failure<OrganizationProjectionDto>(UnsupportedOperationException())

        override suspend fun getSessionOrganization(sessionId: String) =
            Result.success<OrganizationProjectionDto?>(null)

        override suspend fun getSwarmStatus(sessionId: String) = Result.success(swarmDto)

        override suspend fun getBoard(sessionId: String, channel: String?, sinceSeq: Long, limit: Int): Result<SwarmBoardResponseDto?> {
            boardChannelsRequested += channel
            return Result.success(boardDto)
        }

        override suspend fun postBoardMessage(
            sessionId: String,
            channel: String,
            bodyMarkdown: String,
            replyToSeq: Long?,
            idempotencyKey: String?,
        ): Result<PostBoardMessageResponseDto> {
            postedMessages += RecordedBoardPost(sessionId, channel, bodyMarkdown, replyToSeq)
            val msg = SwarmBoardMessageDto(
                seq = 3L,
                channel = channel,
                senderKind = "owner",
                senderName = "owner",
                bodyMarkdown = bodyMarkdown,
                replyToSeq = replyToSeq,
            )
            return Result.success(PostBoardMessageResponseDto(sessionId, "org_swarm", msg, headSeq = 3L))
        }
    }
}
