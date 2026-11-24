package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.Message
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.timeline.TimelineItem
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class SwitchingSessionRepositoryTest {

    private class FakeTargetRepository(
        override val runtimeTargetId: String,
        initialConnection: RuntimeConnectionState,
    ) : SessionRepository {
        private val mutableConnection = MutableStateFlow(initialConnection)
        override val connectionState: StateFlow<RuntimeConnectionState> = mutableConnection.asStateFlow()
        override val invalidations: Flow<SessionInvalidation> = MutableSharedFlow()
        override fun observeComputers(): Flow<List<Computer>> = MutableStateFlow(emptyList())
        override fun observeProjects(): Flow<List<Project>> = MutableStateFlow(emptyList())
        override fun observeSessions(): Flow<List<Session>> = MutableStateFlow(emptyList())
        override fun observeSession(sessionId: String): Flow<Session?> = MutableStateFlow(null)
        override fun observeMessages(sessionId: String): Flow<List<Message>> = MutableStateFlow(emptyList())
        override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = MutableStateFlow(emptyList())
        override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = MutableStateFlow(emptyList())
        override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = null
        override suspend fun createSession(name: String, tool: String): Session = Session("s", name)
        override suspend fun createProject(name: String, rootPath: String): Project = Project("p", name, rootPath)
        override suspend fun refreshComputers() = Unit
        override suspend fun refreshProjects() = Unit
        override suspend fun refreshSessions() = Unit
        override suspend fun refreshEvents(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0)
        override suspend fun refreshSessionDetail(sessionId: String): Session? = null
        override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult =
            RefreshResult.Applied(events.size, 0)
        override suspend fun sendMessage(sessionId: String, text: String, requestId: String) = Unit
        override suspend fun cancelSession(sessionId: String) = Unit
        override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) = Unit
        override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
        override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) = Unit
        override suspend fun resolveRuntimeApproval(
            runId: String,
            approvalId: String,
            decision: String,
            choices: List<String>,
            customAnswer: String?,
            requestId: String,
        ) = Unit
        override suspend fun resumePendingOperations(): Int = 0
    }

    @Test
    fun observeDelegateConnectionsEmitsConnectedToConnectedTargetSwitch() = runTest {
        val repoA = FakeTargetRepository("pc-a", RuntimeConnectionState.Connected)
        val repoB = FakeTargetRepository("pc-b", RuntimeConnectionState.Connected)
        val switching = SwitchingSessionRepository(backgroundScope)
        val emissions = mutableListOf<Pair<String?, RuntimeConnectionState>>()

        val job = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            switching.observeDelegateConnections().collect { (repo, state) ->
                emissions += repo?.runtimeTargetId to state
            }
        }

        switching.switchTo(repoA)
        switching.switchTo(repoB)

        assertEquals(
            listOf(
                null to RuntimeConnectionState.Disconnected,
                "pc-a" to RuntimeConnectionState.Connected,
                "pc-b" to RuntimeConnectionState.Connected,
            ),
            emissions,
        )
        job.cancel()
    }
}
