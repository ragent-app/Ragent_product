package com.andysagent.ragent

import android.os.Bundle
import android.content.Intent
import com.andysagent.ragent.core.appapi.CaptureDraft
import com.andysagent.ragent.core.appapi.ApiErrorCode
import com.andysagent.ragent.feature.appapi.CaptureWorkflowPort
import java.util.UUID

/** Debug-only native callback harness. Tests supply a real isolated graph with replaced PC carriers. */
class ProcessTextQaActivity : ProcessTextActivity() {
    override fun intake(savedInstanceState: Bundle?): CaptureEntry = if (port != null) super.intake(savedInstanceState)
        else CaptureEntry(UUID.randomUUID().toString(), error = ApiErrorCode.CAPABILITY_UNSUPPORTED)
    override fun workflowPort(graph: AndroidRuntimeGraph, entry: CaptureEntry): CaptureWorkflowPort = port ?: super.workflowPort(graph, entry)
    override fun savedTaskIntent(draft: CaptureDraft): Intent = Intent(this, SavedProcessTextQaActivity::class.java)
        .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draft.draftId)
    companion object { @Volatile var port: CaptureWorkflowPort? = null }
}

/** Same isolated owner journal as the callback harness; not exported and not in release APKs. */
class SavedProcessTextQaActivity : CaptureEditorActivity() {
    override fun intake(savedInstanceState: Bundle?): CaptureEntry = if (ProcessTextQaActivity.port != null) CaptureEntry(
        savedInstanceState?.getString(SAVED_DRAFT_ID) ?: intent.getStringExtra(ShareDraftActivity.EXTRA_DRAFT_ID).orEmpty())
        else CaptureEntry(UUID.randomUUID().toString(), error = ApiErrorCode.CAPABILITY_UNSUPPORTED)
    override fun workflowPort(graph: AndroidRuntimeGraph, entry: CaptureEntry): CaptureWorkflowPort = ProcessTextQaActivity.port ?: super.workflowPort(graph, entry)
}
