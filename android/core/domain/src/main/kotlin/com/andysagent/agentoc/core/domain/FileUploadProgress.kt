package com.andysagent.agentoc.core.domain

/** Transient upload observation. Null bytes means the carrier cannot measure body writes. */
data class FileUploadProgress(val phase: FileUploadPhase, val totalBytes: Long, val writtenBytes: Long? = null) {
    init { require(totalBytes > 0); require(writtenBytes == null || writtenBytes in 0..totalBytes) }
}

enum class FileUploadPhase { CHECKING, PREPARING, TRANSFERRING, RETRYING, VERIFYING, CONFIRMED }
