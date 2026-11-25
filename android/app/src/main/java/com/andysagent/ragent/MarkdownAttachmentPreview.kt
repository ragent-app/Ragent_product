package com.andysagent.ragent

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.ragent.core.agentui.AgentMarkdown
import com.andysagent.ragent.core.agentui.LocalPreparedMarkdownDocuments
import com.andysagent.ragent.core.agentui.MarkdownBlock
import com.andysagent.ragent.core.agentui.prepareMarkdownDocuments
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

private const val MAX_PREVIEW_CHARS = 256 * 1024

private sealed interface MarkdownPreviewState {
    data object Loading : MarkdownPreviewState
    data object Failed : MarkdownPreviewState
    data class Ready(
        val text: String,
        val truncated: Boolean,
        val blocks: Map<String, List<MarkdownBlock>>,
    ) : MarkdownPreviewState
}

@Composable
internal fun MarkdownAttachmentPreview(
    name: String,
    file: File,
    uriHandler: UriHandler,
    error: Int?,
    saved: Boolean,
    onDismiss: () -> Unit,
    onOpenWith: () -> Unit,
    onSave: () -> Unit,
) {
    val preview by produceState<MarkdownPreviewState>(MarkdownPreviewState.Loading, file) {
        value = try {
            val (text, truncated) = withContext(Dispatchers.IO) {
                file.inputStream().bufferedReader(Charsets.UTF_8).use { reader ->
                    val chars = CharArray(MAX_PREVIEW_CHARS + 1)
                    var length = 0
                    while (length < chars.size) {
                        coroutineContext.ensureActive()
                        val count = reader.read(chars, length, chars.size - length)
                        if (count < 0) break
                        length += count
                    }
                    val truncated = length > MAX_PREVIEW_CHARS
                    var end = minOf(length, MAX_PREVIEW_CHARS)
                    if (truncated && end > 0 && Character.isHighSurrogate(chars[end - 1])) end--
                    String(chars, 0, end) to truncated
                }
            }
            MarkdownPreviewState.Ready(text, truncated, prepareMarkdownDocuments(listOf(text)))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { MarkdownPreviewState.Failed }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).fillMaxHeight(0.9f), shape = MaterialTheme.shapes.large) {
            Column(Modifier.fillMaxSize().padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = onDismiss) { Text(stringResource(R.string.timeline_attachment_close)) }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (val state = preview) {
                        MarkdownPreviewState.Loading -> Text(stringResource(R.string.timeline_attachment_preview_loading))
                        MarkdownPreviewState.Failed -> Text(stringResource(R.string.timeline_attachment_preview_failed))
                        is MarkdownPreviewState.Ready -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                            if (state.truncated) Text(stringResource(R.string.timeline_attachment_preview_truncated))
                            CompositionLocalProvider(
                                LocalPreparedMarkdownDocuments provides state.blocks,
                                LocalUriHandler provides uriHandler,
                            ) { AgentMarkdown(state.text) }
                        }
                    }
                }
                if (error != null) Text(stringResource(error))
                if (saved) Text(stringResource(R.string.timeline_attachment_saved))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                    TextButton(onClick = onOpenWith) { Text(stringResource(R.string.timeline_attachment_open_with)) }
                    TextButton(onClick = onSave) { Text(stringResource(R.string.timeline_attachment_save)) }
                }
            }
        }
    }
}
