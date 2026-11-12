package com.andysagent.agentoc.core.domain

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Bound account relay use while preserving attachment order in the message. */
internal suspend fun <T, R> mapAttachmentBatch(items: List<T>, process: suspend (Int, T) -> R): List<R> =
    coroutineScope {
        val permits = Semaphore(2)
        items.mapIndexed { index, item -> async { permits.withPermit { process(index, item) } } }.awaitAll()
    }
