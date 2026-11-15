package com.andysagent.ragent.feature.appapi

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors

/** One Android Sharesheet target; the person chooses the receiving workflow inside Ragent. */
data class ShareRoutePreview(
    val title: String? = null,
    val text: String? = null,
    val attachmentCount: Int = 0,
)

@Composable
fun ShareRouteScreen(
    onSaveToTask: () -> Unit,
    onSendToTemporaryComputer: () -> Unit,
    onClose: () -> Unit,
    preview: ShareRoutePreview? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Column(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding()) {
        CaptureHeader(stringResource(R.string.share_route_title), onClose)
        Column(
            Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
                .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                stringResource(R.string.share_route_headline),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.primaryContent,
            )
            Text(
                stringResource(R.string.share_route_explanation),
                style = MaterialTheme.typography.bodyLarge,
                color = colors.secondaryContent,
            )
            if (preview != null) SharePreviewCard(preview)
            RouteCard(
                title = stringResource(R.string.share_route_task_title),
                description = stringResource(R.string.share_route_task_description),
                tag = "share-route-task",
                onClick = onSaveToTask,
            )
            RouteCard(
                title = stringResource(R.string.share_route_temporary_title),
                description = stringResource(R.string.share_route_temporary_description),
                tag = "share-route-temporary",
                onClick = onSendToTemporaryComputer,
            )
        }
    }
}

@Composable
private fun SharePreviewCard(preview: ShareRoutePreview) {
    val colors = LocalRagentColors.current
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = colors.surfaceLow,
        modifier = Modifier.fillMaxWidth().testTag("share-route-preview"),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.share_route_preview_label),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.secondaryContent,
                )
                if (preview.attachmentCount > 0) {
                    Text(
                        stringResource(R.string.share_route_attachment_count, preview.attachmentCount),
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.secondaryContent,
                        modifier = Modifier.testTag("share-route-preview-attachments"),
                    )
                }
            }
            preview.title?.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.titleSmall, color = colors.primaryContent,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            preview.text?.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent,
                    maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun RouteCard(title: String, description: String, tag: String, onClick: () -> Unit) {
    val colors = LocalRagentColors.current
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(24.dp),
        color = colors.surfaceLow,
        modifier = Modifier.fillMaxWidth().testTag(tag),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                color = colors.primaryContent)
            Text(description, style = MaterialTheme.typography.bodyMedium, color = colors.secondaryContent)
        }
    }
}

@Preview(showBackground = true, widthDp = 420, heightDp = 820)
@Composable
private fun ShareRoutePreview() {
    RagentTheme {
        ShareRouteScreen(onSaveToTask = {}, onSendToTemporaryComputer = {}, onClose = {})
    }
}
