package com.andysagent.ragent

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.domain.SwitchingSessionRepository
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.SwitchingRagentTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The detail pane owns its computer independently of the foreground list. */
internal class TabletChatBinding : ViewModel() {
    val sessions = SwitchingSessionRepository(viewModelScope)
    val transport = SwitchingRagentTransport(viewModelScope, closeDelegates = false)
    private val mutableTargetId = MutableStateFlow<String?>(null)
    val targetId = mutableTargetId.asStateFlow()

    suspend fun bind(repository: SessionRepository?, targetId: String?, source: RagentTransport?) {
        transport.switchTo(source)
        sessions.switchTo(repository)
        mutableTargetId.value = targetId
    }
}
