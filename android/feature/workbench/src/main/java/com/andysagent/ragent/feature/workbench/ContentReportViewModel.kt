package com.andysagent.ragent.feature.workbench

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.domain.ContentReportError
import com.andysagent.ragent.core.domain.ContentReportException
import com.andysagent.ragent.core.domain.ContentReportReason
import com.andysagent.ragent.core.domain.ContentReportRecord
import com.andysagent.ragent.core.domain.ContentReportsRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ContentReportUiState(
    val open: Boolean = false,
    val selectedReply: Boolean = false,
    val reason: ContentReportReason? = null,
    val details: String = "",
    val includeContent: Boolean = false,
    val content: String = "",
    val record: ContentReportRecord? = null,
    val busy: Boolean = false,
    val error: ContentReportError? = null,
    val clearConfirmation: Boolean = false,
)

class ContentReportViewModel(private val repository: ContentReportsRepository) : ViewModel() {
    private val mutable = MutableStateFlow(ContentReportUiState())
    val state = mutable.asStateFlow()

    /** A new reply or Settings entry loads only the phone's journal, never the network. */
    fun open(text: String? = null) {
        if (mutable.value.busy) { mutable.update { it.copy(open = true) }; return }
        mutable.value = ContentReportUiState(open = true, selectedReply = text != null,
            content = text.orEmpty().replace("\u0000", "").take(4000), busy = true)
        work { val record = repository.saved(); mutable.update { it.copy(record = record) } }
    }
    fun dismiss() { mutable.update { it.copy(open = false, clearConfirmation = false) } }
    fun reason(value: ContentReportReason) = edit { copy(reason = value) }
    fun details(value: String) = edit { copy(details = value.take(1000).replace("\u0000", "")) }
    fun content(value: String) = edit { copy(content = value.take(4000).replace("\u0000", "")) }
    fun includeContent(value: Boolean) = edit { copy(includeContent = value) }
    private fun edit(change: ContentReportUiState.() -> ContentReportUiState) {
        if (!mutable.value.busy && mutable.value.record == null) mutable.update { it.change().copy(error = null) }
    }
    fun submit() {
        val draft = mutable.value
        if (draft.busy || draft.record != null || draft.reason == null || !draft.selectedReply || draft.error == ContentReportError.Storage) return
        mutable.update { it.copy(busy = true, error = null) }
        work {
            val record = repository.submit(draft.reason, draft.details, draft.includeContent, draft.content)
            mutable.update { it.copy(record = record) }
        }
    }
    fun checkReceipt(retryIfMissing: Boolean = false) {
        if (mutable.value.busy || mutable.value.record == null) return
        mutable.update { it.copy(busy = true, error = null) }
        work { val record = repository.checkReceipt(retryIfMissing); mutable.update { it.copy(record = record) } }
    }
    fun requestClear() { if (!mutable.value.busy) mutable.update { it.copy(clearConfirmation = true) } }
    fun cancelClear() { mutable.update { it.copy(clearConfirmation = false) } }
    fun clearLocal() {
        if (!mutable.value.clearConfirmation || mutable.value.busy) return
        mutable.update { it.copy(busy = true, clearConfirmation = false) }
        work {
            repository.clearLocal()
            mutable.value = ContentReportUiState(open = mutable.value.open)
        }
    }
    private fun work(block: suspend () -> Unit) {
        viewModelScope.launch {
            try { block() }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) {
                val restored = try { repository.saved() } catch (_: Exception) { null }
                mutable.update { it.copy(record = restored ?: it.record,
                    error = (error as? ContentReportException)?.kind ?: ContentReportError.Unconfirmed) }
            } finally { mutable.update { it.copy(busy = false) } }
        }
    }
}
