package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.feature.appapi.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.encodeToString

/** Foreign apps must launch for result. Android's calling package is the principal. */
class CallerConsentActivity : ComponentActivity() {
    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        val obscured = event.flags and android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED != 0 ||
            (android.os.Build.VERSION.SDK_INT >= 29 && event.flags and android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED != 0)
        return obscured || super.dispatchTouchEvent(event)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setResult(RESULT_CANCELED)
        val graph = (application as RagentApplication).runtime
        val identity: InstalledCallerIdentity
        val request: CallerConsentRequest
        try {
            val actualPackage = callingPackage ?: throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Launch for result from an identifiable app"))
            identity = graph.appApiCallerIdentities.installed(actualPackage)
            if (android.os.Build.VERSION.SDK_INT >= 34 && launchedFromUid != android.os.Process.INVALID_UID &&
                (launchedFromUid != identity.uid || launchedFromPackage != actualPackage))
                throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Platform launch identity does not match the installation"))
            if (identity.uid == android.os.Process.myUid()) throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "External caller required"))
            if (intent.action != CallerConsentContract.ACTION) throw IllegalArgumentException()
            request = CallerConsentContract.decode(intent.getStringExtra(CallerConsentContract.REQUEST) ?: throw IllegalArgumentException())
        } catch (error: Exception) {
            val code = (error as? AppApiException)?.error?.code ?: ApiErrorCode.INVALID_ARGUMENT
            setResult(RESULT_CANCELED, Intent().putExtra(CallerConsentContract.ERROR, code.name)); finish(); return
        }
        val label = runCatching { application.packageManager.getApplicationLabel(application.packageManager.getApplicationInfo(identity.packageName, 0)).toString().take(128) }
            .getOrDefault(identity.packageName)
        val port = object : CallerConsentPort {
            override suspend fun review(): CallerConsentReview {
                if (!graph.appApiCallerIdentities.isCurrent(identity)) throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Caller changed"))
                val context = graph.appApiCallerGrants.reviewContext(graph.appApiOwner)
                val targets = request.targetIds.ifEmpty { context.pairedTargetIds }
                if (targets.isEmpty() || !context.pairedTargetIds.containsAll(targets)) throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Review paired targets"))
                val directory = graph.configStore.directory.first()
                return CallerConsentReview(identity, label, request, directory.computers.filter { it.instanceId in targets }
                    .associate { it.instanceId to it.label.ifBlank { it.instanceId } }, context, SystemClock.elapsedRealtime())
            }
            override suspend fun approve(review: CallerConsentReview, capabilities: Set<String>, targets: Set<String>, createSessions: Boolean, durationMs: Long): CallerConsentReceipt {
                if (review.identity != identity || review.request != request ||
                    SystemClock.elapsedRealtime() - review.openedAtElapsed !in 0..(5 * 60 * 1000L))
                    throw AppApiException(ApiError(ApiErrorCode.REQUEST_EXPIRED, "Review access in the foreground again"))
                val grant = request.narrow(identity, capabilities, targets, createSessions, durationMs, System.currentTimeMillis())
                val approved = graph.appApiCallerGrants.approve(graph.appApiOwner, identity, grant, expectedContext = review.context)
                return CallerConsentReceipt(approved.grantId, grant.capabilityIds, grant.targetIds, grant.expiresAt, grant.sessionIds, grant.projectIds, grant.mayCreateSessions)
            }
        }
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val model: CallerConsentViewModel = viewModel(factory = authorizationFactory(CallerConsentViewModel::class.java) { CallerConsentViewModel(port) })
                val state by model.state.collectAsStateWithLifecycle()
                LaunchedEffect(state.receipt) { state.receipt?.let {
                    setResult(RESULT_OK, Intent().putExtra(CallerConsentContract.RECEIPT, AppApiJson.encodeToString(it)))
                    finish()
                } }
                CallerConsentScreen(state, { event ->
                    if (event != CallerConsentEvent.Approve || (hasWindowFocus() && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)))
                        model.onEvent(event)
                }, { if (!state.saving) finish() })
            }
        }
    }
}

/** Owner-only entry; callers cannot launch this component to manage permissions. */
class CallerGrantsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as RagentApplication).runtime
        val port = object : CallerGrantManagementPort {
            override suspend fun list() = graph.appApiCallerGrants.list(graph.appApiOwner)
            override suspend fun revoke(grant: PersistedCallerGrant) { graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision) }
            override suspend fun deleteRevoked(grant: PersistedCallerGrant) {
                if (!graph.appApiCallerGrants.deleteRevoked(graph.appApiOwner, grant.grantId, grant.revision))
                    throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Refresh authorization history"))
            }
        }
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val model: CallerGrantsViewModel = viewModel(factory = authorizationFactory(CallerGrantsViewModel::class.java) { CallerGrantsViewModel(port) })
                val state by model.state.collectAsStateWithLifecycle()
                CallerGrantsScreen(state, model::onEvent, ::finish)
            }
        }
    }
}
private fun <T : ViewModel> authorizationFactory(type: Class<T>, make: () -> T) = object : ViewModelProvider.Factory {
    override fun <V : ViewModel> create(modelClass: Class<V>): V {
        require(modelClass == type)
        @Suppress("UNCHECKED_CAST") return make() as V
    }
}
