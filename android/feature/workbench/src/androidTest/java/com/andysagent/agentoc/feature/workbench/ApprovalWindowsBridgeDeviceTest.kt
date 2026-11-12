package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.domain.RoomSessionRepository
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.OkHttpAgentoCTransport
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Loopback carrier only: the Windows fixture calls the real policy and queue. */
@RunWith(AndroidJUnit4::class)
class ApprovalWindowsBridgeDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun phoneDecisionReachesWindowsApprovalQueue() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("samsungApprovalBridge") == "local-fixture-v1")
        val transport = OkHttpAgentoCTransport({ "http://127.0.0.1:18667" }, { null })
        val database = Room.inMemoryDatabaseBuilder(rule.activity, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val repository = RoomSessionRepository(database, transport)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            runBlocking { repository.refreshEvents("samsung-fixture") }
            val approval = runBlocking { repository.observePendingApprovals("samsung-fixture").first().single() }
            assertTrue(approval.command.orEmpty().contains("example"))
            val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(
                listOf(Session("samsung-fixture", "Windows approval fixture")), listOf(approval))).copy(expanded = true)
            val done = AtomicBoolean(false)
            val failure = AtomicReference<Throwable?>(null)
            rule.setContent {
                AgentocTheme {
                    AttentionSurface(state, onEvent = { event ->
                        if (event is AttentionEvent.ResolveApproval && !event.approve) {
                            scope.launch {
                                try {
                                    repository.resolveRuntimeApproval(requireNotNull(approval.runId), approval.id,
                                        "deny", emptyList(), null, "samsung-device-deny")
                                } catch (error: Throwable) { failure.set(error) }
                                finally { done.set(true) }
                            }
                        }
                    }, onOpenSession = {})
                }
            }
            rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed().performClick()
            rule.waitUntil(30_000) { done.get() }
            failure.get()?.let { throw it }
            val response = runBlocking { transport.execute(ApiRequest("GET", "/fixture/status")) }
            assertEquals(200, response.statusCode)
            assertTrue(JSONObject(response.body).getBoolean("queued"))
        } finally {
            scope.cancel()
            runBlocking { repository.close(); transport.close() }
            database.close()
        }
    }
}
