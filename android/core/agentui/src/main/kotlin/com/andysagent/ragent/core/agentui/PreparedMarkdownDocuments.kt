package com.andysagent.ragent.core.agentui

import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Entry-scoped documents: no global history cache or retained message bodies. */
val LocalPreparedMarkdownDocuments = staticCompositionLocalOf<Map<String, List<MarkdownBlock>>> { emptyMap() }

/** Prepare a loaded history snapshot off the UI thread, without a process-wide cache. */
suspend fun prepareMarkdownDocuments(texts: List<String>): Map<String, List<MarkdownBlock>> =
    withContext(Dispatchers.Default) {
        texts.distinct().associateWith(::parseBlocksFast)
    }
