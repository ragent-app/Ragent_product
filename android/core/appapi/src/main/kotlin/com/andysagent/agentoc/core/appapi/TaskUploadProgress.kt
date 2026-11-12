package com.andysagent.agentoc.core.appapi

import com.andysagent.agentoc.core.domain.FileUploadPhase

/** Owner UI observation tied to a frozen operation. Confirmed totals come only from saved receipts. */
data class TaskUploadProgress(
    val operationId: String,
    val targetInstanceId: String,
    val resourceId: String,
    val originalName: String,
    val confirmedFiles: Int,
    val totalFiles: Int,
    val confirmedBytes: Long,
    val totalBytes: Long,
    val phase: TaskUploadPhase,
    val fileBytes: Long,
    val writtenBytes: Long? = null,
)

enum class TaskUploadPhase { CHECKING, PREPARING, TRANSFERRING, VERIFYING, CONFIRMED }

internal fun FileUploadPhase.toTaskPhase() = when (this) {
    FileUploadPhase.CHECKING -> TaskUploadPhase.CHECKING
    FileUploadPhase.PREPARING -> TaskUploadPhase.PREPARING
    FileUploadPhase.TRANSFERRING -> TaskUploadPhase.TRANSFERRING
    FileUploadPhase.RETRYING -> TaskUploadPhase.TRANSFERRING
    FileUploadPhase.VERIFYING -> TaskUploadPhase.VERIFYING
    FileUploadPhase.CONFIRMED -> TaskUploadPhase.CONFIRMED
}
