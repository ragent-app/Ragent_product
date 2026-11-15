package com.andysagent.ragent

import com.andysagent.ragent.core.auth.StagedTemporaryAttachment
import com.andysagent.ragent.core.auth.TemporaryTextOperation

/** Finds a durable file-share operation if the process died after journal write but before UI state save. */
internal fun findRecoverableTemporaryFileShare(
    operations: List<TemporaryTextOperation>,
    instanceId: String,
    expectedText: String,
    stagedAttachments: List<StagedTemporaryAttachment>,
    nowMs: Long,
    runtimeId: String? = null,
): TemporaryTextOperation? {
    if (stagedAttachments.isEmpty()) return null
    return operations.asSequence()
        .filter { operation ->
            operation.instanceId == instanceId && operation.expiresAt > nowMs && operation.text == expectedText &&
                (runtimeId == null || operation.tool == runtimeId) &&
                operation.attachments.size == stagedAttachments.size && operation.attachments.indices.all { index ->
                    val old = operation.attachments[index]
                    val current = stagedAttachments[index]
                    old.originalName == current.originalName && old.mimeType == current.mimeType &&
                        old.sizeBytes == current.sizeBytes && old.sha256 == current.sha256
                }
        }
        .maxByOrNull { it.createdAt }
}
