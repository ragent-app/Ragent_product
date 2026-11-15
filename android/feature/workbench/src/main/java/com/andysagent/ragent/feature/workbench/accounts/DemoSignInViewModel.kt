package com.andysagent.ragent.feature.workbench.accounts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class DemoSignInError { Credentials, Unavailable, RateLimited, Network, ExistingConnections, Failed }

data class DemoSignInUiState(
    val open: Boolean = false,
    val username: String = "",
    val password: String = "",
    val busy: Boolean = false,
    val error: DemoSignInError? = null,
    val signedInProfile: GoogleAccountProfile? = null,
) {
    val canSubmit get() = Regex("^[a-z0-9._-]{3,80}$").matches(username) && password.length in 16..256 && !busy
    override fun toString() = "DemoSignInUiState(open=$open,busy=$busy,error=$error)"
}

/** Passwords stay in memory only and are cleared on completion, dismissal or failure. */
class DemoSignInViewModel(
    private val signIn: suspend (String, String) -> GoogleAccountProfile,
) : ViewModel() {
    private val mutableState = MutableStateFlow(DemoSignInUiState())
    val state = mutableState.asStateFlow()
    private var job: Job? = null

    fun open() { if (!mutableState.value.busy) mutableState.value = DemoSignInUiState(open = true) }
    fun usernameChanged(value: String) {
        if (!mutableState.value.busy) mutableState.value = mutableState.value.copy(username = value.take(80), error = null)
    }
    fun passwordChanged(value: String) {
        if (!mutableState.value.busy) mutableState.value = mutableState.value.copy(password = value.take(256), error = null)
    }
    fun dismiss() {
        // Once the server may have issued a session, let the same operation finish.
        if (!mutableState.value.busy) mutableState.value = DemoSignInUiState()
    }
    fun consumeSuccess() { mutableState.value = DemoSignInUiState() }
    fun submit() {
        val input = mutableState.value
        if (!input.open || !input.canSubmit || job?.isActive == true) return
        mutableState.value = input.copy(busy = true, error = null)
        job = viewModelScope.launch {
            try {
                val profile = signIn(input.username, input.password)
                mutableState.value = DemoSignInUiState(signedInProfile = profile)
            } catch (cancelled: CancellationException) {
                mutableState.value = DemoSignInUiState()
                throw cancelled
            } catch (error: Exception) {
                val reason = if ((error as? AccountSessionException)?.code == "demo_existing_connections") {
                    DemoSignInError.ExistingConnections
                } else when ((error as? AccountSessionException)?.statusCode) {
                    400, 401 -> DemoSignInError.Credentials
                    403, 404, 501 -> DemoSignInError.Unavailable
                    429 -> DemoSignInError.RateLimited
                    0, 408, 502, 503, 504 -> DemoSignInError.Network
                    else -> DemoSignInError.Failed
                }
                mutableState.value = DemoSignInUiState(open = true, username = input.username, error = reason)
            }
        }
    }
}
