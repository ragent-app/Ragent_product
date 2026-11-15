package com.andysagent.ragent.core.designsystem

import androidx.compose.material3.ButtonDefaults

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties

/** Non-modal connection status. The underlying editor keeps focus and remains usable. */
@Composable
fun RagentonnectionProgress(
    title: String,
    detail: String,
    busy: Boolean,
    showRetry: Boolean,
    retryLabel: String,
    exitLabel: String,
    onRetry: () -> Unit,
    onExit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Box(Modifier.fillMaxSize()) {
        // A non-focusable popup preserves the editor's input connection and
        // allows touches outside its bounds to reach the underlying page.
        val topOffset = with(LocalDensity.current) { 24.dp.roundToPx() }
        Popup(alignment = Alignment.TopCenter, offset = IntOffset(0, topOffset),
            properties = PopupProperties(focusable = false, dismissOnClickOutside = false)) {
            Surface(
                modifier = modifier.padding(horizontal = 24.dp).widthIn(max = 420.dp).fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 4.dp,
                shadowElevation = 12.dp,
            ) {
                Column(Modifier.padding(horizontal = 20.dp, vertical = 16.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (busy) AgentoProgress(modifier = Modifier.testTag("demo-connection-progress"))
                    Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                    Text(detail, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary, textAlign = TextAlign.Center)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = onExit, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(exitLabel) }
                        if (showRetry) TextButton(onClick = onRetry, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(retryLabel) }
                    }
                }
            }
        }
    }
}
