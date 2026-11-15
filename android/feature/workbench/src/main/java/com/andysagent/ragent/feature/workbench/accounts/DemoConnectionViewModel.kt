package com.andysagent.ragent.feature.workbench.accounts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.DiscoveredComputer
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class DemoConnectionPhase { Discovering, Connecting, Reconnecting, Ready, Unavailable }

data class DemoConnectionUiState(
    val active: Boolean = false,
    val phase: DemoConnectionPhase = DemoConnectionPhase.Discovering,
    val targetId: String? = null,
    val targetLabel: String? = null,
    val elapsedMillis: Long = 0,
    val readyWithinFiveSeconds: Boolean? = null,
) {
    val ready get() = active && phase == DemoConnectionPhase.Ready
    val takingLonger get() = active && !ready && elapsedMillis >= 5_000
}

/** Uses only server-authorized account targets; the ordinary controller owns each carrier. */
class DemoConnectionViewModel(
    private val discover: suspend (accountId: String) -> List<DiscoveredComputer>,
    private val connect: suspend (accountId: String, targetId: String) -> Unit,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val reconnect: suspend (accountId: String, targetId: String) -> Unit = connect,
) : ViewModel() {
    private val mutableState = MutableStateFlow(DemoConnectionUiState())
    val state = mutableState.asStateFlow()
    private var account: String? = null
    private var connectionJob: Job? = null
    private var clockJob: Job? = null
    private var startedAt = 0L
    private var selectedTarget: String? = null
    private var observedConnection = RuntimeConnectionState.Disconnected

    fun activate(verifiedAccountId: String) {
        if (!verifiedAccountId.matches(Regex("^acct_demo_[a-f0-9]{48}$"))) { deactivate(); return }
        if (account == verifiedAccountId && mutableState.value.active) return
        deactivate()
        account = verifiedAccountId
        mutableState.value = DemoConnectionUiState(active = true)
        begin(reconnecting = false)
    }

    fun deactivate() {
        account = null
        connectionJob?.cancel(); connectionJob = null
        clockJob?.cancel(); clockJob = null
        mutableState.value = DemoConnectionUiState()
    }

    fun connectionChanged(targetId: String?, connection: RuntimeConnectionState) {
        selectedTarget = targetId
        observedConnection = connection
        val current = mutableState.value
        if (!current.active || current.targetId == null || current.targetId != targetId) return
        when {
            connection == RuntimeConnectionState.Connected -> markReady()
            connection == RuntimeConnectionState.AuthenticationRequired -> {
                connectionJob?.cancel()
                mutableState.value = current.copy(phase = DemoConnectionPhase.Unavailable)
            }
            current.ready -> begin(reconnecting = true)
        }
    }

    fun retry() {
        if (account != null) begin(reconnecting = mutableState.value.targetId != null, explicitRetry = true)
    }

    private fun begin(reconnecting: Boolean, explicitRetry: Boolean = false) {
        val owner = account ?: return
        connectionJob?.cancel()
        clockJob?.cancel()
        startedAt = monotonicMillis()
        mutableState.value = mutableState.value.copy(active = true,
            phase = if (reconnecting) DemoConnectionPhase.Reconnecting else DemoConnectionPhase.Discovering,
            elapsedMillis = 0, readyWithinFiveSeconds = null)
        clockJob = viewModelScope.launch {
            while (isActive && account == owner && !mutableState.value.ready) {
                mutableState.value = mutableState.value.copy(elapsedMillis = elapsed())
                delay(100)
            }
        }
        connectionJob = viewModelScope.launch {
            var attempt = 0
            while (isActive && account == owner) {
                try {
                    val computers = discover(owner)
                    val preferred = if (reconnecting) mutableState.value.targetId else selectedTarget
                    val computer = computers.firstOrNull { it.instanceId == preferred }
                        ?: if (reconnecting) null else computers.firstOrNull()
                    if (account != owner) return@launch
                    if (computer == null) {
                        // Missing authorized targets never fall back to a cached/personal computer.
                        mutableState.value = mutableState.value.copy(phase = DemoConnectionPhase.Unavailable)
                        return@launch
                    }
                    mutableState.value = mutableState.value.copy(targetId = computer.instanceId,
                        targetLabel = computer.alias,
                        phase = if (reconnecting) DemoConnectionPhase.Reconnecting else DemoConnectionPhase.Connecting)
                    if (selectedTarget == computer.instanceId && observedConnection == RuntimeConnectionState.Connected) {
                        markReady(); return@launch
                    }
                    // An explicit retry must reach the controller even when a
                    // prior attempt still reports Reconnecting. Ordinary state
                    // updates continue to reuse the controller's own recovery.
                    if (explicitRetry) reconnect(owner, computer.instanceId)
                    else connect(owner, computer.instanceId)
                    // Pairing/lease persistence alone is not a successful connection.
                    // Only the controller's protected probe may publish Connected.
                    if (selectedTarget == computer.instanceId && observedConnection == RuntimeConnectionState.Connected) markReady()
                    return@launch
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (account != owner) return@launch
                    mutableState.value = mutableState.value.copy(phase = DemoConnectionPhase.Unavailable)
                    if (error is AccountSessionException && error.statusCode in setOf(400, 401, 403)) return@launch
                    delay((1_000L shl attempt.coerceAtMost(3)).coerceAtMost(10_000L))
                    attempt++
                    if (account == owner) mutableState.value = mutableState.value.copy(
                        phase = if (reconnecting) DemoConnectionPhase.Reconnecting else DemoConnectionPhase.Discovering)
                }
            }
        }
    }

    private fun elapsed() = (monotonicMillis() - startedAt).coerceAtLeast(0)
    private fun markReady() {
        if (!mutableState.value.active) return
        val elapsed = if (mutableState.value.ready) mutableState.value.elapsedMillis else elapsed()
        mutableState.value = mutableState.value.copy(phase = DemoConnectionPhase.Ready,
            elapsedMillis = elapsed, readyWithinFiveSeconds = elapsed <= 5_000)
        clockJob?.cancel()
    }
}
