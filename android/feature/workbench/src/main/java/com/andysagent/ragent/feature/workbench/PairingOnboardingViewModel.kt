package com.andysagent.ragent.feature.workbench

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.domain.DiscoveredComputer
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.protocol.parsePairingUri
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class PairingOnboardingStep {
    Welcome,
    ConnectionMethods,
    GoogleRequired,
    AccountClaimRequired,
    ComputerAliasRequired,
    ComputerSelect,
    Verifying,
    Bound,
    Error,
}

enum class PairingOnboardingMode {
    ConnectComputer,
    ConnectComputerFromWelcome,
    SignIn,
}

enum class TemporaryPairingFailure {
    PhoneQuotaExceeded,
    RateLimited,
    HostSlow,
    HostUnavailable,
}

data class PairingOnboardingUiState(
    val open: Boolean = false,
    val step: PairingOnboardingStep = PairingOnboardingStep.GoogleRequired,
    val mode: PairingOnboardingMode = PairingOnboardingMode.ConnectComputer,
    val errorMessage: String? = null,
    /** Localized user-facing copy for the error; errorMessage retains the English diagnostic. */
    val errorMessageRes: Int? = null,
    /** Rejected or expired codes must be replaced, never sent again by Retry. */
    val requiresNewCode: Boolean = false,
    val temporaryPairingFailure: TemporaryPairingFailure? = null,
    /** A scanner launched from the full-screen welcome must return there on cancel. */
    val scannerFailureReturnsToWelcome: Boolean = false,
    /** Lets the UI render scanner availability with the current app locale. */
    val scannerUnavailable: Boolean = false,
    val subscriptionRequired: Boolean = false,
    val discoveredComputers: List<DiscoveredComputer> = emptyList(),
    val selectedComputerIds: Set<String> = emptySet(),
    val selectedComputer: DiscoveredComputer? = null,
    val computerAlias: String = "",
    /** Signed, short-lived device grant; never treated as an account binding. */
    val temporaryPairing: Boolean = false,
    val temporaryFullControl: Boolean = false,
    val accountHandoff: Boolean = false,
    val canReplaceTemporaryClaim: Boolean = false,
    val replacementBlockedOperationCount: Int? = null,
) {
    val connectionPlan: String
        get() = discoveredComputers.firstOrNull()?.connectionPlan ?: "free"
    val unlimitedConnections: Boolean
        get() = discoveredComputers.firstOrNull()?.unlimitedConnections == true
    val connectionLimit: Int
        get() = discoveredComputers.firstOrNull()?.maximumConcurrentConnections ?: 1
    val activeConnections: Int
        get() = discoveredComputers.firstOrNull()?.activeComputerConnections ?: 0
    val availableSelections: Int
        get() = if (unlimitedConnections) Int.MAX_VALUE else (connectionLimit - activeConnections).coerceAtLeast(0)
}

sealed interface TemporaryClaimReplacementOutcome {
    data object ReadyToRetry : TemporaryClaimReplacementOutcome
    data class BlockedByOperations(val count: Int) : TemporaryClaimReplacementOutcome
}

private data class PairingErrorCopy(val english: String, val resourceId: Int)

sealed interface PairingOnboardingEvent {
    data object Open : PairingOnboardingEvent
    data object OpenWelcome : PairingOnboardingEvent
    data object ContinueFromWelcome : PairingOnboardingEvent
    data object SignInFromWelcome : PairingOnboardingEvent
    data object LearnConnectionMethods : PairingOnboardingEvent
    data object BackToWelcome : PairingOnboardingEvent
    data object Dismiss : PairingOnboardingEvent
    /** Hide local progress without claiming that an in-flight remote request was revoked. */
    data object StopWaiting : PairingOnboardingEvent
    /** Accounts v2 session was established or refreshed outside this ViewModel. */
    data object AccountSessionReady : PairingOnboardingEvent
    data object StartComputerConnection : PairingOnboardingEvent
    data object GoogleSignInCancelled : PairingOnboardingEvent
    data class PairingUriReceived(val value: String) : PairingOnboardingEvent
    data class ResumeTemporaryPairing(val instanceId: String) : PairingOnboardingEvent
    data object ReplaceTemporaryClaimAndRetry : PairingOnboardingEvent
    data class ComputerAliasChanged(val value: String) : PairingOnboardingEvent
    data object ConfirmComputerAlias : PairingOnboardingEvent
    data class ComputerSelected(val computer: DiscoveredComputer) : PairingOnboardingEvent
    data object TakeOverSelected : PairingOnboardingEvent
    data class ScannerFailed(
        val message: String? = null,
        val returnToWelcome: Boolean = false,
    ) : PairingOnboardingEvent
    data object Retry : PairingOnboardingEvent
}

/**
 * Owns the first-run trust flow. Google is completed by the Accounts session
 * orchestrator before this ViewModel receives [AccountSessionReady]; this class
 * therefore never sees, stores, retries, or forwards an ID token or `rac_`.
 */
class PairingOnboardingViewModel(
    private val deviceName: String,
    private val completePairing: suspend (pairingUri: String, deviceName: String) -> Unit,
    private val completePairingWithAlias: (suspend (pairingUri: String, deviceName: String, computerAlias: String) -> Unit)? = null,
    private val discoverComputers: (suspend (deviceName: String) -> List<DiscoveredComputer>)? = null,
    private val takeOverComputers: (suspend (computers: List<DiscoveredComputer>, deviceName: String) -> Unit)? = null,
    private val completeTemporaryPairing: (suspend (ticket: String) -> Unit)? = null,
    /** Full-workbench temporary control is a separate QR and transport contract. */
    private val completeTemporaryControlPairing: (suspend (ticket: String) -> Unit)? = null,
    private val resumeTemporaryPairing: (suspend (instanceId: String) -> Unit)? = null,
    private val isTemporaryClaimConflict: (Throwable) -> Boolean = { false },
    private val replaceTemporaryClaim: (suspend (ticket: String) -> TemporaryClaimReplacementOutcome)? = null,
) : ViewModel() {
    private val mutableState = MutableStateFlow(PairingOnboardingUiState())
    val state: StateFlow<PairingOnboardingUiState> = mutableState.asStateFlow()

    private var accountSessionReady = false
    private var pendingPairingUri: String? = null
    private var activePairingUri: String? = null
    private var activeComputerIds: Set<String> = emptySet()
    private var activeTemporaryInstanceId: String? = null
    private var pairingInFlight = false

    fun onEvent(event: PairingOnboardingEvent) {
        when (event) {
            PairingOnboardingEvent.Open -> open()
            PairingOnboardingEvent.OpenWelcome -> openWelcome()
            PairingOnboardingEvent.ContinueFromWelcome -> continueFromWelcome()
            PairingOnboardingEvent.SignInFromWelcome -> signInFromWelcome()
            PairingOnboardingEvent.LearnConnectionMethods -> openConnectionMethods()
            PairingOnboardingEvent.BackToWelcome -> openWelcome()
            PairingOnboardingEvent.Dismiss -> dismiss()
            PairingOnboardingEvent.StopWaiting -> stopWaiting()
            PairingOnboardingEvent.AccountSessionReady -> acceptAccountSession()
            PairingOnboardingEvent.StartComputerConnection -> startComputerConnection()
            PairingOnboardingEvent.GoogleSignInCancelled -> {
                if (pairingInFlight) return
                val mode = mutableState.value.mode
                accountSessionReady = false
                mutableState.value = PairingOnboardingUiState(
                    open = true,
                    step = PairingOnboardingStep.GoogleRequired,
                    mode = mode,
                )
            }
            is PairingOnboardingEvent.PairingUriReceived -> acceptPairingUri(event.value)
            is PairingOnboardingEvent.ResumeTemporaryPairing -> resumeTemporary(event.instanceId)
            PairingOnboardingEvent.ReplaceTemporaryClaimAndRetry -> replaceTemporaryClaimAndRetry()
            is PairingOnboardingEvent.ComputerAliasChanged -> {
                if (!pairingInFlight && mutableState.value.step == PairingOnboardingStep.ComputerAliasRequired) {
                    mutableState.value = mutableState.value.copy(computerAlias = event.value)
                }
            }
            PairingOnboardingEvent.ConfirmComputerAlias -> confirmComputerAlias()
            is PairingOnboardingEvent.ComputerSelected -> selectComputer(event.computer)
            PairingOnboardingEvent.TakeOverSelected -> takeOverSelectedComputer()
            is PairingOnboardingEvent.ScannerFailed -> if (!pairingInFlight) showError(
                message = event.message.orEmpty(),
                returnToWelcome = event.returnToWelcome,
                scannerUnavailable = true,
            )
            PairingOnboardingEvent.Retry -> retry()
        }
    }

    private fun open() {
        mutableState.value = mutableState.value.copy(open = true)
    }

    private fun openWelcome() {
        if (pairingInFlight) return
        accountSessionReady = false
        pendingPairingUri = null
        activePairingUri = null
        activeTemporaryInstanceId = null
        activeComputerIds = emptySet()
        mutableState.value = PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Welcome,
            mode = PairingOnboardingMode.ConnectComputer,
        )
    }

    private fun continueFromWelcome() {
        openGoogleGuide(PairingOnboardingMode.ConnectComputerFromWelcome)
    }

    private fun signInFromWelcome() {
        openGoogleGuide(PairingOnboardingMode.SignIn)
    }

    private fun openConnectionMethods() {
        if (pairingInFlight) return
        mutableState.value = PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.ConnectionMethods,
            mode = PairingOnboardingMode.ConnectComputer,
        )
    }

    private fun openGoogleGuide(mode: PairingOnboardingMode) {
        if (pairingInFlight) return
        mutableState.value = PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.GoogleRequired,
            mode = mode,
        )
    }

    private fun dismiss() {
        if (pairingInFlight) return
        accountSessionReady = false
        pendingPairingUri = null
        activePairingUri = null
        activeTemporaryInstanceId = null
        activeComputerIds = emptySet()
        mutableState.value = mutableState.value.copy(open = false, errorMessage = null)
    }

    private fun stopWaiting() {
        if (!pairingInFlight || mutableState.value.step != PairingOnboardingStep.Verifying) return
        // The claim may already have reached the computer. Let it settle, retain
        // the result, and never interpret hiding this dialog as remote revocation.
        mutableState.value = mutableState.value.copy(open = false)
    }

    private fun acceptAccountSession() {
        if (pairingInFlight) return
        accountSessionReady = true
        val pendingUri = pendingPairingUri
        if (pendingUri != null) {
            pendingPairingUri = null
            acceptPairingUri(pendingUri)
        } else {
            when (mutableState.value.mode) {
                PairingOnboardingMode.ConnectComputer -> discover()
                // Let the success screen hand the user back to the signed-in
                // Welcome before starting device discovery.
                PairingOnboardingMode.ConnectComputerFromWelcome -> Unit
                PairingOnboardingMode.SignIn -> {
                    mutableState.value = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.AccountClaimRequired,
                        mode = PairingOnboardingMode.SignIn,
                    )
                }
            }
        }
    }

    private fun startComputerConnection() {
        if (pairingInFlight) return
        if (!accountSessionReady) {
            mutableState.value = mutableState.value.copy(
                open = true,
                step = PairingOnboardingStep.GoogleRequired,
                errorMessage = null,
            )
            return
        }
        val pendingUri = pendingPairingUri
        if (pendingUri != null) {
            pendingPairingUri = null
            acceptPairingUri(pendingUri)
        } else {
            discover()
        }
    }

    private fun discover() {
        if (pairingInFlight) return
        val discover = discoverComputers
        if (discover == null) {
            mutableState.value = PairingOnboardingUiState(open = true, step = PairingOnboardingStep.AccountClaimRequired)
            return
        }
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Verifying)
        viewModelScope.launch {
            try {
                val computers = discover(deviceName)
                if (computers.isEmpty()) {
                    mutableState.value = PairingOnboardingUiState(open = mutableState.value.open, step = PairingOnboardingStep.AccountClaimRequired)
                } else {
                    mutableState.value = PairingOnboardingUiState(
                        open = mutableState.value.open,
                        step = PairingOnboardingStep.ComputerSelect,
                        discoveredComputers = computers,
                    )
                }
            } catch (error: Throwable) {
                showError(messageFor(error), error, preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    private fun selectComputer(computer: DiscoveredComputer) {
        if (pairingInFlight) return
        val state = mutableState.value
        val selected = state.selectedComputerIds
        val next = when {
            computer.instanceId in selected -> selected - computer.instanceId
            selected.size >= state.availableSelections -> selected
            else -> selected + computer.instanceId
        }
        if (next == selected) return
        mutableState.value = state.copy(
            selectedComputerIds = next,
            selectedComputer = state.discoveredComputers.firstOrNull { it.instanceId in next },
        )
    }

    private fun acceptPairingUri(value: String) {
        if (pairingInFlight) return
        mutableState.value = mutableState.value.copy(open = true)
        val uri = value.trim()
        if (uri.isBlank()) {
            showError(PairingErrorCopy("No account-link code was found in that scan.", R.string.pairing_error_empty_scan))
            return
        }
        if (uri.startsWith("{")) {
            val controlTicket = runCatching { TemporaryControlProtocol.parseIfControl(uri, System.currentTimeMillis()) }
            if (controlTicket.isFailure) {
                showError(PairingErrorCopy("That temporary control code is invalid or has expired.", R.string.pairing_error_invalid_control_code))
                return
            }
            if (controlTicket.getOrNull() != null) {
                startTemporaryControlPairing(uri)
                return
            }
            startTemporaryPairing(uri)
            return
        }
        val invitation = runCatching { parsePairingUri(uri) }.getOrNull()
        if (!accountSessionReady && invitation?.version != 4) {
            pendingPairingUri = uri
            mutableState.value = mutableState.value.copy(
                open = true,
                step = PairingOnboardingStep.GoogleRequired,
                errorMessage = null,
            )
            return
        }
        runCatching { parsePairingUri(uri) }.onFailure {
            activePairingUri = null
            showError(PairingErrorCopy("That QR code is not a valid Ragent account-link code.", R.string.pairing_error_invalid_account_code))
            return
        }
        activePairingUri = uri
        // Naming can be changed after connection; the scan starts authorization.
        startPairing(uri, "")
    }

    private fun startTemporaryPairing(ticket: String) {
        if (pairingInFlight) return
        val complete = completeTemporaryPairing ?: run {
            showError(PairingErrorCopy("Temporary pairing is unavailable in this build.", R.string.pairing_error_temporary_unavailable))
            return
        }
        activePairingUri = ticket
        activeTemporaryInstanceId = null
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(open = true,
            step = PairingOnboardingStep.Verifying, temporaryPairing = true)
        viewModelScope.launch {
            try {
                complete(ticket)
                activePairingUri = null
                mutableState.value = PairingOnboardingUiState(open = mutableState.value.open,
                    step = PairingOnboardingStep.Bound, temporaryPairing = true)
            } catch (error: Throwable) {
                showError(messageFor(error), error,
                    canReplaceTemporaryClaim = isTemporaryClaimConflict(error), preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    /** A v2 control QR never enters the legacy share runtime or Google login flow. */
    private fun startTemporaryControlPairing(ticket: String) {
        if (pairingInFlight) return
        val complete = completeTemporaryControlPairing ?: run {
            showError(PairingErrorCopy("Temporary full control is unavailable in this build.", R.string.pairing_error_control_unavailable))
            return
        }
        activePairingUri = ticket
        activeTemporaryInstanceId = null
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(open = true,
            step = PairingOnboardingStep.Verifying, temporaryPairing = true, temporaryFullControl = true)
        viewModelScope.launch {
            try {
                complete(ticket)
                activePairingUri = null
                mutableState.value = PairingOnboardingUiState(open = mutableState.value.open,
                    step = PairingOnboardingStep.Bound, temporaryPairing = true, temporaryFullControl = true)
            } catch (error: Throwable) {
                showError(messageFor(error), error, preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    private fun replaceTemporaryClaimAndRetry() {
        if (pairingInFlight) return
        val ticket = activePairingUri ?: return
        val replace = replaceTemporaryClaim ?: return
        val complete = completeTemporaryPairing ?: return
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(open = true,
            step = PairingOnboardingStep.Verifying, temporaryPairing = true)
        viewModelScope.launch {
            try {
                when (val outcome = replace(ticket)) {
                    TemporaryClaimReplacementOutcome.ReadyToRetry -> {
                        complete(ticket)
                        activePairingUri = null
                        mutableState.value = PairingOnboardingUiState(open = mutableState.value.open,
                            step = PairingOnboardingStep.Bound, temporaryPairing = true)
                    }
                    is TemporaryClaimReplacementOutcome.BlockedByOperations -> {
                        mutableState.value = PairingOnboardingUiState(open = mutableState.value.open,
                            step = PairingOnboardingStep.Error, temporaryPairing = true,
                            replacementBlockedOperationCount = outcome.count)
                    }
                }
            } catch (error: Throwable) {
                showError(messageFor(error), error,
                    canReplaceTemporaryClaim = isTemporaryClaimConflict(error), preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    private fun resumeTemporary(instanceId: String) {
        if (pairingInFlight || !instanceId.matches(Regex("^inst_[A-Za-z0-9_-]{24,64}$"))) return
        val resume = resumeTemporaryPairing ?: return
        activeTemporaryInstanceId = instanceId
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(open = true,
            step = PairingOnboardingStep.Verifying, temporaryPairing = true)
        viewModelScope.launch {
            try {
                resume(instanceId)
                activeTemporaryInstanceId = null
                mutableState.value = PairingOnboardingUiState(open = mutableState.value.open,
                    step = PairingOnboardingStep.Bound, temporaryPairing = true)
            } catch (error: Throwable) {
                showError(messageFor(error), error, preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    private fun confirmComputerAlias() {
        if (pairingInFlight) return
        val uri = activePairingUri ?: return
        startPairing(uri, mutableState.value.computerAlias)
    }

    private fun startPairing(uri: String, computerAlias: String = mutableState.value.computerAlias) {
        if (pairingInFlight) return
        val accountHandoff = runCatching { parsePairingUri(uri).version == 4 }.getOrDefault(false)
        if (!accountSessionReady && !accountHandoff) {
            pendingPairingUri = uri
            mutableState.value = PairingOnboardingUiState(open = true)
            return
        }
        runCatching { parsePairingUri(uri) }.onFailure {
            activePairingUri = null
            showError(PairingErrorCopy("That QR code is not a valid Ragent account-link code.", R.string.pairing_error_invalid_account_code))
            return
        }
        activePairingUri = uri
        val mode = mutableState.value.mode
        val normalizedAlias = computerAlias.replace(Regex("[\\r\\n]+"), " ").trim().take(64)
        pairingInFlight = true
        mutableState.value = PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Verifying,
            mode = mode,
            computerAlias = normalizedAlias,
            accountHandoff = accountHandoff,
        )
        viewModelScope.launch {
            try {
                completePairingWithAlias?.invoke(uri, deviceName, normalizedAlias)
                    ?: completePairing(uri, deviceName)
                accountSessionReady = true
                activePairingUri = null
                mutableState.value = PairingOnboardingUiState(
                    open = mutableState.value.open,
                    step = PairingOnboardingStep.Bound,
                    mode = mode,
                )
            } catch (error: Throwable) {
                showError(messageFor(error), error, preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    fun takeOverSelectedComputer() {
        if (pairingInFlight) return
        val state = mutableState.value
        val computers = state.discoveredComputers.filter { it.instanceId in state.selectedComputerIds }
        if (computers.isEmpty()) return
        val takeOver = takeOverComputers ?: return
        if (!accountSessionReady) return
        pairingInFlight = true
        activeComputerIds = computers.mapTo(linkedSetOf()) { it.instanceId }
        mutableState.value = mutableState.value.copy(step = PairingOnboardingStep.Verifying)
        viewModelScope.launch {
            try {
                takeOver(computers, deviceName)
                activeComputerIds = emptySet()
                mutableState.value = PairingOnboardingUiState(open = mutableState.value.open, step = PairingOnboardingStep.Bound)
            } catch (error: Throwable) {
                showError(messageFor(error), error, preserveVisibility = true)
            } finally {
                pairingInFlight = false
            }
        }
    }

    private fun retry() {
        if (pairingInFlight) return
        if (mutableState.value.scannerFailureReturnsToWelcome) {
            openWelcome()
            return
        }
        if (mutableState.value.requiresNewCode) {
            val returnToWelcome = mutableState.value.temporaryPairing || mutableState.value.accountHandoff
            activePairingUri = null
            pendingPairingUri = null
            activeTemporaryInstanceId = null
            activeComputerIds = emptySet()
            mutableState.value = PairingOnboardingUiState(
                open = true,
                step = if (returnToWelcome) PairingOnboardingStep.Welcome else PairingOnboardingStep.AccountClaimRequired,
                mode = mutableState.value.mode,
            )
            return
        }
        val activeUri = activePairingUri
        activeTemporaryInstanceId?.takeIf { mutableState.value.temporaryPairing }?.let {
            resumeTemporary(it)
            return
        }
        if (mutableState.value.temporaryPairing && activeUri != null) {
            acceptPairingUri(activeUri)
            return
        }
        if ((accountSessionReady || mutableState.value.accountHandoff) && activeUri != null) {
            val alias = mutableState.value.computerAlias
            startPairing(activeUri, alias)
            return
        }
        mutableState.value = if (!accountSessionReady) {
            PairingOnboardingUiState(open = true)
        } else {
            PairingOnboardingUiState(open = true, step = PairingOnboardingStep.AccountClaimRequired)
        }
    }

    private fun showError(
        message: PairingErrorCopy,
        error: Throwable? = null,
        canReplaceTemporaryClaim: Boolean = false,
        preserveVisibility: Boolean = false,
    ) = showError(
        message = message.english,
        error = error,
        canReplaceTemporaryClaim = canReplaceTemporaryClaim,
        preserveVisibility = preserveVisibility,
        errorMessageRes = message.resourceId,
        requiresNewCode = !canReplaceTemporaryClaim && error?.let(::temporaryPairingFailureFor) == null && message.resourceId in setOf(
            R.string.pairing_error_empty_scan,
            R.string.pairing_error_invalid_control_code,
            R.string.pairing_error_invalid_account_code,
            R.string.pairing_error_handoff_expired,
            R.string.pairing_error_temporary_expired,
            R.string.pairing_error_temporary_rejected,
            R.string.pairing_error_temporary_failed,
            R.string.pairing_error_link_rejected,
            R.string.pairing_error_request_rejected,
            R.string.pairing_error_request_conflict,
            R.string.pairing_error_code_expired,
            R.string.pairing_error_wrong_computer,
            R.string.pairing_error_link_failed,
        ),
    )

    private fun showError(
        message: String,
        error: Throwable? = null,
        returnToWelcome: Boolean = false,
        scannerUnavailable: Boolean = false,
        canReplaceTemporaryClaim: Boolean = false,
        preserveVisibility: Boolean = false,
        errorMessageRes: Int? = null,
        requiresNewCode: Boolean = false,
    ) {
        mutableState.value = PairingOnboardingUiState(
            open = if (preserveVisibility) mutableState.value.open else true,
            step = PairingOnboardingStep.Error,
            errorMessage = message,
            errorMessageRes = errorMessageRes,
            requiresNewCode = requiresNewCode,
            mode = mutableState.value.mode,
            temporaryPairingFailure = error?.let(::temporaryPairingFailureFor),
            scannerFailureReturnsToWelcome = returnToWelcome,
            scannerUnavailable = scannerUnavailable,
            subscriptionRequired = error?.let(::isDeviceQuotaError) == true,
            temporaryPairing = mutableState.value.temporaryPairing,
            temporaryFullControl = mutableState.value.temporaryFullControl,
            accountHandoff = mutableState.value.accountHandoff,
            canReplaceTemporaryClaim = canReplaceTemporaryClaim,
        )
    }

    private fun messageFor(error: Throwable): PairingErrorCopy {
        fun copy(resourceId: Int, english: String) = PairingErrorCopy(english, resourceId)
        if (quotaErrorCode(error) == "temporary_control_use_account_pairing") return copy(
            R.string.pairing_error_use_account_code,
            "This phone is signed in. Scan the computer's ordinary account pairing code.",
        )
        if (mutableState.value.accountHandoff) {
            val detail = error.message.orEmpty().lowercase()
            return when {
                "expired" in detail -> copy(R.string.pairing_error_handoff_expired, "This account pairing code expired. Create another code on the computer.")
                "confirm" in detail -> copy(R.string.pairing_error_handoff_pending, "Account sign-in is still pending. Keep both devices online and try again.")
                "network" in detail || "connect" in detail || "reached" in detail -> copy(R.string.pairing_error_handoff_network, "Keep both devices online and try again. Account sign-in completes automatically.")
                else -> copy(R.string.pairing_error_handoff_failed, "Account sign-in could not finish. Keep the computer online and try again.")
            }
        }
        when (quotaErrorCode(error)) {
            "device_phone_quota_exceeded" ->
                return copy(R.string.pairing_error_phone_quota, "This Google account has reached the Free plan limit of 1 phone. Upgrade to Pro to link more devices.")
            "device_computer_quota_exceeded" ->
                return copy(R.string.pairing_error_computer_quota, "This Google account has reached the Free plan limit of 1 computer. Upgrade to Pro to link more devices.")
        }
        if (mutableState.value.temporaryPairing) {
            val detail = error.message.orEmpty().lowercase()
            return when {
                (error is ApiException && error.statusCode == 410) || "expired" in detail ->
                    copy(R.string.pairing_error_temporary_expired, "This temporary code or access expired. Create a fresh short-lived code and scan it again.")
                error is ApiException && error.statusCode == 429 ->
                    copy(R.string.pairing_error_temporary_limit, "This computer has reached its temporary connection limit. Try again later.")
                error is ApiException && error.statusCode in 401..403 ->
                    copy(R.string.pairing_error_temporary_rejected, "This temporary code was rejected. Create a fresh code on the computer and scan again.")
                "business api" in detail || "business access" in detail ->
                    copy(R.string.pairing_error_temporary_preparing, "This computer did not finish preparing temporary access. Keep both devices online and try again.")
                "network" in detail || "connect" in detail || "turn" in detail || "p2p" in detail ->
                    copy(R.string.pairing_error_temporary_network, "The code was accepted, but the temporary connection could not finish. Check both devices' network connections and try again.")
                else ->
                    copy(R.string.pairing_error_temporary_failed, "The code was accepted, but this computer could not finish the temporary connection. Keep both devices online and try again with a fresh code.")
            }
        }
        if (error is AccountsRepositoryException) {
            return when (error.code) {
                "google_login_not_configured" ->
                    copy(R.string.pairing_error_accounts_not_configured, "This computer's Google account service is not configured. Configure Accounts on the computer and try again.")
                "owner_auth_broker_unavailable" ->
                    copy(R.string.pairing_error_account_service_unavailable, "The computer's account service is temporarily unavailable. Try again in a moment.")
                "owner_auth_binding_mismatch" ->
                    copy(R.string.pairing_error_account_mismatch, "This computer is linked to a different Google account. Use the account that owns the computer.")
                "owner_auth_binding_revoked", "owner_auth_not_owner" ->
                    copy(R.string.pairing_error_link_rejected, "This computer rejected the device link. Show a new account-link code and try again.")
                "owner_auth_token_invalid" ->
                    copy(R.string.pairing_error_google_verification, "Google verification failed. Complete Google sign-in again and retry.")
                "owner_auth_convergence_pending" ->
                    copy(R.string.pairing_error_link_pending, "The computer is finishing the link. Retry in a moment.")
                "NETWORK_ERROR", "P2P_NETWORK_ERROR", "TURN_NETWORK_ERROR" ->
                    copy(R.string.pairing_error_computer_unreachable, "The computer could not be reached. Check the connection and try again.")
                else -> when (error.statusCode) {
                    401, 403 -> copy(R.string.pairing_error_request_rejected, "The computer rejected this account-link request. Show a new code and try again.")
                    409 -> copy(R.string.pairing_error_request_conflict, "The computer could not accept this account-link request. Start the flow again.")
                    503 -> copy(R.string.pairing_error_account_service_unavailable, "The computer's account service is temporarily unavailable. Try again in a moment.")
                    else -> if (error.retryable) {
                        copy(R.string.pairing_error_link_retryable, "The computer could not complete the link. Try again in a moment.")
                    } else {
                        copy(R.string.pairing_error_link_configuration, "The computer could not complete the link. Check its account configuration and try again.")
                    }
                }
            }
        }
        val detail = error.message.orEmpty().lowercase()
        return when {
            "discovery" in detail || "directory" in detail -> copy(R.string.pairing_error_discovery_empty, "No available computer was found for this Google account.")
            "expired" in detail || "unknown" in detail -> copy(R.string.pairing_error_code_expired, "This account-link code expired. Show a new code on the computer and scan again.")
            "mismatch" in detail || "different" in detail -> copy(R.string.pairing_error_wrong_computer, "This account-link code belongs to a different computer. Scan the intended computer.")
            "google" in detail || "token" in detail || "account" in detail -> copy(R.string.pairing_error_google_incomplete, "Google verification did not complete. Try again.")
            "network" in detail || "connect" in detail -> copy(R.string.pairing_error_computer_unreachable, "The computer could not be reached. Check the connection and try again.")
            else -> copy(R.string.pairing_error_link_failed, "This computer could not be linked. Try the account-link flow again.")
        }
    }

    private fun quotaErrorCode(error: Throwable): String? = when (error) {
        is AccountsRepositoryException -> error.code
        is ApiException -> error.code
        else -> null
    }

    private fun temporaryPairingFailureFor(error: Throwable): TemporaryPairingFailure? = when (quotaErrorCode(error)) {
        "temporary_broker_turn_quota_exceeded" -> TemporaryPairingFailure.PhoneQuotaExceeded
        "temporary_host_rate_limited" -> TemporaryPairingFailure.RateLimited
        "temporary_host_timeout" -> TemporaryPairingFailure.HostSlow
        "temporary_host_unavailable", "temporary_broker_request_failed" -> TemporaryPairingFailure.HostUnavailable
        else -> null
    }

    private fun isDeviceQuotaError(error: Throwable): Boolean = when (quotaErrorCode(error)) {
        "device_phone_quota_exceeded", "device_computer_quota_exceeded" -> true
        else -> false
    }
}

class PairingOnboardingViewModelFactory(
    private val deviceName: String,
    private val completePairing: suspend (pairingUri: String, deviceName: String) -> Unit,
    private val completePairingWithAlias: (suspend (pairingUri: String, deviceName: String, computerAlias: String) -> Unit)? = null,
    private val discoverComputers: (suspend (deviceName: String) -> List<DiscoveredComputer>)? = null,
    private val takeOverComputers: (suspend (computers: List<DiscoveredComputer>, deviceName: String) -> Unit)? = null,
    private val completeTemporaryPairing: (suspend (ticket: String) -> Unit)? = null,
    private val completeTemporaryControlPairing: (suspend (ticket: String) -> Unit)? = null,
    private val resumeTemporaryPairing: (suspend (instanceId: String) -> Unit)? = null,
    private val isTemporaryClaimConflict: (Throwable) -> Boolean = { false },
    private val replaceTemporaryClaim: (suspend (ticket: String) -> TemporaryClaimReplacementOutcome)? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        PairingOnboardingViewModel(deviceName, completePairing, completePairingWithAlias,
            discoverComputers, takeOverComputers, completeTemporaryPairing, completeTemporaryControlPairing, resumeTemporaryPairing,
            isTemporaryClaimConflict, replaceTemporaryClaim) as T
}
