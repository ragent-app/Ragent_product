package com.andysagent.ragent

import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.feature.appapi.*
import kotlinx.coroutines.flow.first

/** Non-exported owner consent. No Intent fields can select capabilities or approve a delegation. */
class AssistantDelegationActivity : ComponentActivity() {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val obscured = event.flags and MotionEvent.FLAG_WINDOW_IS_OBSCURED != 0 ||
            (android.os.Build.VERSION.SDK_INT >= 29 && event.flags and MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED != 0)
        return obscured || super.dispatchTouchEvent(event)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        val graph = (application as RagentApplication).runtime
        val port = object : AssistantDelegationPort {
            override suspend fun review(): AssistantDelegationReview {
                val context = graph.assistantDelegations.reviewContext(graph.appApiOwner)
                val rows = graph.assistantDelegations.list(graph.appApiOwner)
                val directory = graph.configStore.directory.first()
                return AssistantDelegationReview(context, directory.computers.filter { it.instanceId in context.pairedTargetIds }
                    .associate { it.instanceId to it.label.ifBlank { it.instanceId } }, rows, SystemClock.elapsedRealtime())
            }
            override suspend fun approve(review: AssistantDelegationReview, scope: AssistantDelegationScope) {
                if (SystemClock.elapsedRealtime() - review.openedAtElapsed !in 0..(5 * 60 * 1000L))
                    throw AppApiException(ApiError(ApiErrorCode.REQUEST_EXPIRED, "Review assistant delegation in the foreground again"))
                graph.assistantDelegations.approve(graph.appApiOwner, scope, review.context)
            }
            override suspend fun revoke(row: AssistantDelegation) { graph.assistantDelegations.revoke(graph.appApiOwner, row.id, row.revision) }
            override suspend fun deleteRevoked(row: AssistantDelegation) {
                if (!graph.assistantDelegations.deleteRevoked(graph.appApiOwner, row.id, row.revision))
                    throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Refresh assistant delegation history"))
            }
            override fun now() = System.currentTimeMillis()
        }
        val factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                require(modelClass == AssistantDelegationViewModel::class.java)
                @Suppress("UNCHECKED_CAST") return AssistantDelegationViewModel(port) as T
            }
        }
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val model: AssistantDelegationViewModel = viewModel(factory = factory)
                val state by model.state.collectAsStateWithLifecycle()
                AssistantDelegationScreen(state, { event ->
                    if (event != AssistantDelegationEvent.Approve || (hasWindowFocus() && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)))
                        model.onEvent(event)
                }, { if (!state.busy) finish() })
            }
        }
    }
}
