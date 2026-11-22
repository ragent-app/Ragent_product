package com.andysagent.ragent.feature.organization.domain

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.feature.organization.ConversationStatus
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.MemberConversationRefDto
import com.andysagent.ragent.feature.organization.data.OrganizationApi
import com.andysagent.ragent.feature.organization.data.OrganizationAttemptDto
import com.andysagent.ragent.feature.organization.data.OrganizationBindingDto
import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationPhaseDto
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
import com.andysagent.ragent.feature.organization.data.isOrganizationAuthorizationRevokedStatus
import com.andysagent.ragent.feature.organization.data.isOrganizationFeatureUnavailableStatus
import com.andysagent.ragent.feature.organization.data.normalizeOrganizationUnavailableResponse
import com.andysagent.ragent.feature.organization.extractEventFailureReason
import com.andysagent.ragent.feature.organization.extractEventResultPacketInfo
import com.andysagent.ragent.feature.organization.initialConversationStatusForConnection
import com.andysagent.ragent.feature.organization.layout.LayoutBounds
import com.andysagent.ragent.feature.organization.layout.LayoutResult
import com.andysagent.ragent.feature.organization.layout.NodePosition
import com.andysagent.ragent.feature.organization.presentation.NodeActionKind
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiMapper
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardChannelTabUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmOverviewUiState
import com.andysagent.ragent.feature.organization.ui.computeHasCollaborators
import com.andysagent.ragent.feature.organization.ui.computeNodeCaptionOffset
import com.andysagent.ragent.feature.organization.ui.formatBoardChannelChipLabel
import com.andysagent.ragent.feature.organization.ui.rectToSegmentDistance
import com.andysagent.ragent.feature.organization.ui.resolveFormalRootNodeId
import com.andysagent.ragent.feature.organization.ui.resolveMemberConversationRef
import com.andysagent.ragent.feature.organization.ui.resolveOrganizationSubtitleRes
import com.andysagent.ragent.feature.organization.ui.shouldShowBoardChannelUnreadBadge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    @Test
    fun httpUnavailableStatusesDoNotTriggerAuthRevocationAndNormalizeResponse() {
        assertTrue(isOrganizationAuthorizationRevokedStatus(401))
        assertTrue(isOrganizationAuthorizationRevokedStatus(403))
        for (status in listOf(404, 405, 410, 501, 500, 200)) {
            assertFalse(isOrganizationAuthorizationRevokedStatus(status), "status=$status")
        }

        for (status in listOf(404, 405, 410, 501)) {
            assertTrue(isOrganizationFeatureUnavailableStatus(status), "status=$status")
        }
        for (status in listOf(401, 403, 500, 200)) {
            assertFalse(isOrganizationFeatureUnavailableStatus(status), "status=$status")
        }

        val normalized404 = normalizeOrganizationUnavailableResponse(ApiResponse(statusCode = 404, body = ""))
        assertEquals(404, normalized404.statusCode)
        val parsed404 = Json.parseToJsonElement(normalized404.body).jsonObject
        assertEquals("ROUTE_UNAVAILABLE", parsed404["code"]?.jsonPrimitive?.content)
        assertTrue(parsed404["error"]?.jsonPrimitive?.content?.contains("404") == true)

        val normalizedHtml501 = normalizeOrganizationUnavailableResponse(
            ApiResponse(statusCode = 501, body = "<html>Not Implemented</html>"),
        )
        val parsed501 = Json.parseToJsonElement(normalizedHtml501.body).jsonObject
        assertEquals("ROUTE_UNAVAILABLE", parsed501["code"]?.jsonPrimitive?.content)
        assertTrue(parsed501["error"]?.jsonPrimitive?.content?.contains("501") == true)

        val existingJson404 = """{"error":"Feature disabled","code":"FEATURE_DISABLED"}"""
        assertEquals(
            existingJson404,
            normalizeOrganizationUnavailableResponse(ApiResponse(statusCode = 404, body = existingJson404)).body,
        )

        assertEquals(
            "",
            normalizeOrganizationUnavailableResponse(ApiResponse(statusCode = 401, body = "")).body,
        )
    }

    @Test
    fun doneSwarmBoardLocksWritingUpdatesSubtitleAndAvoidsDuplicateChannelCount() = runTest(testDispatcher) {
        val doneBoardDto = SwarmBoardResponseDto(
            rootSessionId = "sess_done",
            organizationId = "org_done",
            mode = "ragent_swarm",
            readOnly = false,
            board = SwarmBoardPayloadDto(
                mode = "ragent_swarm",
                readOnly = false,
                isDone = true,
                headSeq = 5L,
                channels = listOf(SwarmBoardChannelDto(id = "main", name = "main", messageCount = 5, unreadCount = 5)),
                messages = listOf(
                    SwarmBoardMessageDto(
                        seq = 1L,
                        channel = "main",
                        senderKind = "worker",
                        senderName = "worker-1",
                        bodyMarkdown = "[done] finished",
                        isDoneSignal = true,
                    ),
                ),
            ),
        )
        assertFalse(doneBoardDto.isWritable)

        val fakeApi = FakeSwarmOrganizationApi(
            swarmDto = SwarmStatusDto(
                rootSessionId = "sess_done",
                mode = "ragent_swarm",
                organizationId = "org_done",
                isDone = true,
                counts = SwarmCountsDto(working = 0, waiting = 1, stopped = 0, killed = 0, active = 0, total = 1),
            ),
            boardDto = doneBoardDto,
        )
        val repo = RealOrganizationRepository(fakeApi, this)
        val vm = OrganizationViewModel(repo)
        vm.applyProjection(
            OrganizationProjectionDto(
                organizationId = "org_done",
                rootSessionId = "sess_done",
                state = "active",
            ),
        )
        vm.applySwarmStatus(fakeApi.swarmDto)
        vm.applyBoardResponse(doneBoardDto)
        advanceUntilIdle()

        val uiState = vm.uiState.value
        assertTrue(uiState.isCompleted)
        assertTrue(uiState.swarmBoard?.isDone == true)
        assertFalse(uiState.swarmBoard?.isWritable == true)
        assertEquals(R.string.organization_state_done, resolveOrganizationSubtitleRes(uiState))

        vm.setBoardComposerDraft("follow-up")
        vm.setBoardReplyToSeq(1L)
        vm.postBoardMessage("sess_done")
        advanceUntilIdle()
        assertTrue(fakeApi.postedMessages.isEmpty())

        assertEquals(
            R.string.organization_state_active,
            resolveOrganizationSubtitleRes(
                OrganizationUiState(
                    state = "active",
                    isCompleted = false,
                    swarmOverview = SwarmOverviewUiState(isDone = false),
                    swarmBoard = SwarmBoardUiState(isDone = false),
                ),
            ),
        )
        assertEquals(
            R.string.organization_state_done,
            resolveOrganizationSubtitleRes(
                OrganizationUiState(
                    state = "active",
                    isCompleted = false,
                    swarmOverview = SwarmOverviewUiState(isDone = true),
                ),
            ),
        )

        val allTabDuplicate = SwarmBoardChannelTabUiState(
            id = "__all__",
            label = "All",
            messageCount = 5,
            unreadCount = 5,
            selected = true,
        )
        assertEquals("All (5)", formatBoardChannelChipLabel(allTabDuplicate))
        assertFalse(shouldShowBoardChannelUnreadBadge(allTabDuplicate))

        val partialUnreadTab = SwarmBoardChannelTabUiState(
            id = "backend",
            label = "#backend",
            messageCount = 5,
            unreadCount = 2,
            selected = false,
        )
        assertEquals("#backend (5)", formatBoardChannelChipLabel(partialUnreadTab))
        assertTrue(shouldShowBoardChannelUnreadBadge(partialUnreadTab))

        val emptyTab = SwarmBoardChannelTabUiState(id = "qa", label = "#qa", messageCount = 0, unreadCount = 0)
        assertEquals("#qa", formatBoardChannelChipLabel(emptyTab))
        assertFalse(shouldShowBoardChannelUnreadBadge(emptyTab))
    }

    @Test
    fun resultPacketSummaryBlockedDetailsAndCaptionPlacementAvoidManagesEdges() = runTest(testDispatcher) {
        val repo = RealOrganizationRepository(FakeSwarmOrganizationApi(), this)
        val vm = OrganizationViewModel(repo)
        vm.updateViewportSize(900f, 700f, 1f)
        val projection = OrganizationProjectionDto(
            organizationId = "org_detail",
            rootSessionId = "sess_owner",
            state = "blocked",
            phases = listOf(
                OrganizationPhaseDto(
                    phaseId = "phase_1",
                    objective = "Verify desktop and mobile builds",
                    state = "blocked",
                    reviewRequired = true,
                    reviewState = "needs_changes",
                ),
            ),
            nodes = listOf(
                OrganizationNodeDto(
                    id = "lead",
                    role = "lead",
                    displayName = "Lead",
                    status = "working",
                    sessionId = "sess_lead",
                ),
                OrganizationNodeDto(
                    id = "worker-1",
                    parentId = "lead",
                    role = "worker",
                    displayName = "Worker One",
                    phaseId = "phase_1",
                    status = "blocked",
                    sessionId = "sess_w1",
                    reviewState = "not_applicable",
                    resultPacketId = "rsp_abc123",
                    resultPacket = buildJsonObject {
                        put("verdict", JsonPrimitive("needs_changes"))
                        put("summary", JsonPrimitive("Two verification checks still need clean logs."))
                        put("blockers", JsonArray(listOf(JsonPrimitive("Missing integration proof on Windows"))))
                    },
                    blocker = OrganizationBlockerDto(
                        id = "blk_1",
                        nodeId = "worker-1",
                        reasonCode = "EVIDENCE_GAP",
                        reason = "Missing integration proof on Windows",
                    ),
                    attempt = OrganizationAttemptDto(
                        id = "att_1",
                        number = 2,
                        state = "failed",
                        failureReasonCode = "EVIDENCE_GAP",
                        failureReason = "Smoke test timed out after 30s",
                    ),
                ),
                OrganizationNodeDto(
                    id = "worker-2",
                    parentId = "lead",
                    role = "worker",
                    displayName = "Worker Two",
                    status = "done",
                    sessionId = "sess_w2",
                    resultPacketId = "rsp_only",
                ),
            ),
            edges = listOf(
                OrganizationEdgeDto(id = "e1", parentId = "lead", childId = "worker-1", type = "MANAGES"),
                OrganizationEdgeDto(id = "e2", parentId = "lead", childId = "worker-2", type = "MANAGES"),
            ),
        )
        vm.applyProjection(projection)
        val nodesDeadline = System.currentTimeMillis() + 5_000L
        while (vm.uiState.value.nodes.none { it.id == "worker-1" } && System.currentTimeMillis() < nodesDeadline) {
            advanceUntilIdle()
            Thread.sleep(15)
        }
        vm.onNodeClicked("worker-1")
        val deadline = System.currentTimeMillis() + 5_000L
        while (vm.uiState.value.selectedSheetNode?.id != "worker-1" && System.currentTimeMillis() < deadline) {
            advanceUntilIdle()
            Thread.sleep(15)
        }
        advanceUntilIdle()

        val uiState = vm.uiState.value
        val w1Node = uiState.nodes.firstOrNull { it.id == "worker-1" }
        assertNotNull(w1Node)
        assertTrue(w1Node.hasBlocker)
        assertEquals("EVIDENCE_GAP", w1Node.failureCode)
        assertEquals("rsp_abc123", w1Node.resultPacketId)
        assertTrue(w1Node.resultPacketSummary?.contains("Two verification checks still need clean logs.") == true)
        assertTrue(w1Node.blockerText?.contains("Missing integration proof on Windows") == true)
        assertEquals("needs_changes", w1Node.reviewState)

        val sheetNode = uiState.selectedSheetNode
        assertNotNull(sheetNode)
        assertEquals("rsp_abc123", sheetNode.resultPacketId)
        assertTrue(sheetNode.resultPacketSummary?.contains("Two verification checks still need clean logs.") == true)
        assertTrue(sheetNode.blockerText?.contains("Missing integration proof on Windows") == true)
        assertEquals("EVIDENCE_GAP", sheetNode.failureCode)
        assertEquals("needs_changes", sheetNode.reviewState)

        val w2Node = uiState.nodes.firstOrNull { it.id == "worker-2" }
        assertNotNull(w2Node)
        assertEquals("ResultPacket: rsp_only", w2Node.resultPacketSummary)

        val packetInfo = extractEventResultPacketInfo(
            listOf(
                SessionEventDto(
                    seq = 1L,
                    type = "assistant.message",
                    text = "Done\n<result_packet>{\"verdict\":\"blocked\",\"summary\":\"Compiled cleanly; smoke test failed.\",\"blockers\":[\"Port 8787 busy\"],\"acceptanceNotes\":[\"Retry after stopping stale process\"]}</result_packet>",
                ),
            ),
        )
        assertNotNull(packetInfo)
        assertEquals("blocked", packetInfo.state)
        assertEquals("Compiled cleanly; smoke test failed.", packetInfo.summary)
        assertEquals(listOf("Port 8787 busy"), packetInfo.blockers)
        assertEquals(listOf("Retry after stopping stale process"), packetInfo.acceptanceNotes)

        val deniedReason = extractEventFailureReason(
            listOf(
                SessionEventDto(
                    seq = 2L,
                    type = "tool.call",
                    state = "denied",
                    payload = buildJsonObject { put("failureReason", JsonPrimitive("Command denied by policy")) },
                ),
            ),
        )
        assertEquals("Command denied by policy", deniedReason)

        val parentCenter = Offset(400f, 160f)
        val parentEdges = listOf(
            parentCenter to Offset(400f, 360f),
            parentCenter to Offset(260f, 360f),
            parentCenter to Offset(540f, 360f),
        )
        val captionW = 140f
        val captionH = 44f
        val parentTopLeft = computeNodeCaptionOffset(
            center = parentCenter,
            radius = 40f,
            captionWidth = captionW,
            captionHeight = captionH,
            density = 1f,
            edgeSegments = parentEdges,
            viewportWidth = 800f,
            viewportHeight = 600f,
        )
        val parentCaptionRect = Rect(
            parentTopLeft.x,
            parentTopLeft.y,
            parentTopLeft.x + captionW,
            parentTopLeft.y + captionH,
        )
        parentEdges.forEach { (start, end) ->
            assertTrue(
                rectToSegmentDistance(parentCaptionRect, start, end) >= 6f,
                "Parent caption rect $parentCaptionRect overlapped edge $start -> $end",
            )
        }

        val leafCenter = Offset(400f, 360f)
        val leafEdges = listOf(parentCenter to leafCenter)
        val leafTopLeft = computeNodeCaptionOffset(
            center = leafCenter,
            radius = 40f,
            captionWidth = captionW,
            captionHeight = captionH,
            density = 1f,
            edgeSegments = leafEdges,
            viewportWidth = 800f,
            viewportHeight = 600f,
        )
        assertTrue(leafTopLeft.y >= leafCenter.y + 40f)
        val leafCaptionRect = Rect(leafTopLeft.x, leafTopLeft.y, leafTopLeft.x + captionW, leafTopLeft.y + captionH)
        assertTrue(rectToSegmentDistance(leafCaptionRect, parentCenter, leafCenter) >= 6f)
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
