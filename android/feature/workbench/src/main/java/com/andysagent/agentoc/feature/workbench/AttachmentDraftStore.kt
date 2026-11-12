package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.saveable.listSaver

internal data class AttachmentDraftOwner(val targetId: String?, val sessionId: String?, val newSessionProjectId: String?)

/** Attachment drafts are isolated by the computer and conversation that owns them. */
internal class AttachmentDraftStore {
    private val drafts = mutableStateMapOf<AttachmentDraftOwner, List<ComposerAttachment>>()

    operator fun get(owner: AttachmentDraftOwner): List<ComposerAttachment> = drafts[owner].orEmpty()

    operator fun set(owner: AttachmentDraftOwner, attachments: List<ComposerAttachment>) {
        if (attachments.isEmpty()) drafts.remove(owner) else drafts[owner] = attachments
    }

    fun append(owner: AttachmentDraftOwner, attachments: List<ComposerAttachment>) {
        if (attachments.isNotEmpty()) this[owner] = this[owner] + attachments
    }

    // Flat primitive state survives Android activity recreation and process
    // restoration without retaining a Context or file contents in the Bundle.
    internal fun snapshot(): List<String> = drafts.flatMap { (owner, values) ->
        values.flatMap { attachment -> listOf(
            owner.targetId, owner.sessionId, owner.newSessionProjectId,
            attachment.id, attachment.name, attachment.mimeType, attachment.sizeBytes.toString(),
            attachment.state.name, attachment.progress.toString(), attachment.previewUrl,
            attachment.localPath, attachment.assetId,
        ) }
    }.map { if (it == null) "0" else "1$it" }

    companion object {
        internal fun restore(values: List<String>): AttachmentDraftStore {
            val store = AttachmentDraftStore()
            require(values.size % 12 == 0) { "Invalid attachment draft state" }
            val decoded = values.map {
                when {
                    it == "0" -> null
                    it.startsWith("1") -> it.substring(1)
                    else -> error("Invalid attachment draft value")
                }
            }
            decoded.chunked(12).forEach { row ->
                val owner = AttachmentDraftOwner(row[0], row[1], row[2])
                store.append(owner, listOf(ComposerAttachment(
                    id = requireNotNull(row[3]), name = requireNotNull(row[4]), mimeType = requireNotNull(row[5]),
                    sizeBytes = requireNotNull(row[6]).toLong(), state = AttachmentState.valueOf(requireNotNull(row[7])),
                    progress = requireNotNull(row[8]).toFloat(), previewUrl = row[9], localPath = row[10], assetId = row[11],
                )))
            }
            return store
        }

        val Saver = listSaver<AttachmentDraftStore, String>(
            save = { it.snapshot() },
            restore = { restore(it) },
        )
    }
}
