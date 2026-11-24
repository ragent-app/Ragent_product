package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Stable transport facade for ViewModels while the selected computer changes. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SwitchingRagentTransport(scope: CoroutineScope, private val closeDelegates: Boolean = true) : RagentTransport {
    private val mutableDelegate = MutableStateFlow<RagentTransport?>(null)
    private val switchMutex = Mutex()
    val delegate: StateFlow<RagentTransport?> = mutableDelegate.asStateFlow()

    override val connectionState: StateFlow<RuntimeConnectionState> = mutableDelegate
        .flatMapLatest { it?.connectionState ?: flowOf(RuntimeConnectionState.Disconnected) }
        .stateIn(scope, SharingStarted.Eagerly, RuntimeConnectionState.Disconnected)

    override val activeCarrier: StateFlow<ActiveCarrier> = mutableDelegate
        .flatMapLatest { it?.activeCarrier ?: flowOf(ActiveCarrier.None) }
        .stateIn(scope, SharingStarted.Eagerly, ActiveCarrier.None)

    override val carrierSupportsPushInvalidations: StateFlow<Boolean> = mutableDelegate
        .flatMapLatest { it?.carrierSupportsPushInvalidations ?: flowOf(false) }
        .stateIn(scope, SharingStarted.Eagerly, false)

    override val invalidations: Flow<InvalidationHint> = mutableDelegate
        .flatMapLatest { it?.invalidations ?: emptyFlow() }

    override val requiresEventPolling: Boolean
        get() = mutableDelegate.value?.requiresEventPolling == true

    suspend fun switchTo(transport: RagentTransport?) {
        switchMutex.withLock {
            val previous = mutableDelegate.value
            if (previous === transport) return
            mutableDelegate.value = null
            if (closeDelegates) previous?.close()
            mutableDelegate.value = transport
        }
    }

    override suspend fun execute(request: ApiRequest): ApiResponse = (mutableDelegate.value
        ?: error("No remote computer target is selected")).execute(request)

    override fun connectInvalidationSocket() {
        mutableDelegate.value?.connectInvalidationSocket()
    }

    override fun markAuthenticationRequired() {
        mutableDelegate.value?.markAuthenticationRequired()
    }

    override suspend fun close() {
        switchMutex.withLock {
            val previous = mutableDelegate.value
            mutableDelegate.value = null
            if (closeDelegates) previous?.close()
        }
    }
}
