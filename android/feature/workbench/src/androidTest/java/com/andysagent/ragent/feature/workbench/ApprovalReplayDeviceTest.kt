package com.andysagent.ragent.feature.workbench

import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.room.Room
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.domain.RoomSessionRepository
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Replays a real captured provider request after the current backend enriches it. */
@RunWith(AndroidJUnit4::class)
class ApprovalReplayDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun backendEventPersistsAndAppearsOnDevice() = runBlocking {
        val encoded = InstrumentationRegistry.getArguments().getString("approvalFixture")
        assumeTrue(!encoded.isNullOrBlank())
        val body = String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8)
        val expectedTarget = JSONObject(body).getJSONArray("events").getJSONObject(0)
            .getJSONObject("explanation").getJSONArray("targets").getString(0)
        val database = Room.inMemoryDatabaseBuilder(rule.activity, RagentDatabase::class.java).allowMainThreadQueries().build()
        val repository = RoomSessionRepository(database, ReplayTransport(body))
        try {
            repository.refreshEvents("replay")
            val approval = repository.observePendingApprovals("replay").first().single()
            assertEquals("delete", approval.explanation?.operation)
            assertEquals(true, approval.explanation?.conditional)
            assertEquals(listOf(expectedTarget), approval.explanation?.targets)
            assertTrue(approval.command.orEmpty().contains(expectedTarget))
            val state = AttentionReducer.reduce(AttentionUiState(),
                AttentionReducer.project(listOf(Session("replay", "Captured Claude approval")), listOf(approval))).copy(expanded = true)
            rule.setContent { RagentTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
            rule.onNodeWithTag("attention-headline").assertIsDisplayed()
                .assert(hasText(expectedTarget, substring = true))
            rule.onNodeWithText(rule.activity.getString(R.string.attention_approve)).assertIsDisplayed()
            rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
        } finally {
            repository.close()
            database.close()
        }
        Unit
    }
}

private class ReplayTransport(private val body: String) : RagentTransport {
    override val connectionState: StateFlow<RuntimeConnectionState> = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest) = ApiResponse(200, body)
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
