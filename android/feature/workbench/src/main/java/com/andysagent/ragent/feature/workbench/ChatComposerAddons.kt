package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import com.andysagent.ragent.core.designsystem.AgentoSwitch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.net.Uri
import androidx.collection.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoFrostedModalBottomSheet
import com.andysagent.ragent.core.designsystem.LocalModalBottomSheetDismiss
import com.andysagent.ragent.core.designsystem.AgentoMotion
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoStatusTone
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTextStyles
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoAmbientShadow
import com.andysagent.ragent.core.designsystem.ragentComposerShadow
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import java.util.UUID

enum class AttachmentState { Pending, Uploading, Ready, Failed }

@Immutable
data class ComposerAttachment(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val mimeType: String = "image/png",
    val sizeBytes: Long = 0L,
    val state: AttachmentState = AttachmentState.Ready,
    val progress: Float = 1f,
    val previewUrl: String? = null,
    val localPath: String? = null,
    /** Existing server asset that can be reused without reopening a local file. */
    val assetId: String? = null,
)

@Immutable
data class QueuedMessageUiState(
    val id: String = UUID.randomUUID().toString(),
    val text: String,
    val attachments: List<ComposerAttachment> = emptyList(),
    val timestamp: Long = System.currentTimeMillis(),
    val isSteering: Boolean = false,
)

/**
 * Composer '+' Action Bottom Sheet (Spec-01)
 * Provides rapid access to Photos, Documents, Plan Mode, Slash Commands, and Model selection.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ComposerActionSheet(
    onDismiss: () -> Unit,
    onPickImage: () -> Unit,
    onPickDocument: () -> Unit,
    planMode: Boolean,
    onTogglePlanMode: (Boolean) -> Unit,
    goalMode: Boolean = false,
    goalText: String = "",
    onToggleGoalMode: (Boolean) -> Unit = {},
    onOpenGoalPanel: () -> Unit = {},
    onOpenAgents: () -> Unit = {},
    onOpenConnectors: () -> Unit = {},
    onInsertSlashCommand: (String) -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val commandInk = if (isDark) Color.White else colors.primaryContent
    val largeType = LocalDensity.current.fontScale >= 1.6f
    val closeLabel = stringResource(R.string.composer_actions_close)

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier,
    ) {
        val dismissSheet = LocalModalBottomSheetDismiss.current ?: onDismiss

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("composer-actions-content")
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AgentoSpacing.ComposerMargin, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.composer_actions_title),
                    modifier = Modifier.weight(1f).testTag("composer-actions-title"),
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 18.sp,
                    ),
                    color = colors.primaryContent,
                )
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("composer-actions-close")
                        .clip(CircleShape)
                        .clickable(onClick = dismissSheet)
                        .semantics { contentDescription = closeLabel },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(colors.primaryContent.copy(alpha = if (isDark) 0.09f else 0.055f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Close,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                            tint = colors.secondaryContent,
                        )
                    }
                }
            }

            ComposerActionGroup {
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_images),
                    glyph = AgentoWebGlyph.Image,
                    onClick = {
                        dismissSheet()
                        onPickImage()
                    },
                )
                ComposerActionDivider()
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_files),
                    glyph = AgentoWebGlyph.File,
                    onClick = {
                        dismissSheet()
                        onPickDocument()
                    },
                )
            }

            ComposerActionGroup {
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_plan),
                    glyph = AgentoWebGlyph.Edit,
                    checked = planMode,
                    onCheckedChange = onTogglePlanMode,
                    onClick = { onTogglePlanMode(!planMode) },
                )
                ComposerActionDivider()
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_goal),
                    subtitle = goalText.trim().takeIf { it.isNotEmpty() },
                    glyph = AgentoWebGlyph.TargetArrow,
                    checked = goalMode,
                    onCheckedChange = onToggleGoalMode,
                    onClick = {
                        if (goalMode) {
                            dismissSheet()
                            onOpenGoalPanel()
                        } else {
                            onToggleGoalMode(true)
                        }
                    },
                )
            }

            ComposerActionGroup {
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_agents),
                    glyph = AgentoWebGlyph.Agent,
                    showChevron = true,
                    onClick = {
                        dismissSheet()
                        onOpenAgents()
                    },
                )
                ComposerActionDivider()
                ComposerActionRow(
                    title = stringResource(R.string.composer_action_connectors),
                    glyph = AgentoWebGlyph.Share,
                    showChevron = true,
                    onClick = {
                        dismissSheet()
                        onOpenConnectors()
                    },
                )
            }

            val slashCommands = listOf("/goal", "/plan", "/schedule", "/grill-me", "/learn")
            val commands: @Composable () -> Unit = {
                slashCommands.forEach { cmd ->
                    Surface(
                        onClick = {
                            dismissSheet()
                            onInsertSlashCommand(cmd)
                        },
                        shape = RoundedCornerShape(percent = 50),
                        color = colors.primaryContent.copy(alpha = if (isDark) 0.09f else 0.055f),
                        contentColor = commandInk,
                        modifier = Modifier.testTag("composer-command-${cmd.drop(1)}"),
                    ) {
                        Row(
                            modifier = Modifier.heightIn(min = 44.dp)
                                .padding(horizontal = 13.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = cmd,
                                style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 12.sp,
                                    color = commandInk,
                                ),
                            )
                        }
                    }
                }
            }
            // Large type needs one predictable scrolling axis. Do not hide
            // later commands inside a horizontal strip below the IME viewport.
            if (largeType) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) { commands() }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) { commands() }
            }

            Spacer(Modifier.height(10.dp))
        }
    }
}

@Composable
private fun ComposerActionGroup(
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.primaryContent.copy(alpha = if (isDark) 0.045f else 0.026f)),
    ) { content() }
}

@Composable
private fun ComposerActionDivider() {
    val colors = LocalRagentColors.current
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = 52.dp)
            .height(0.5.dp)
            .background(colors.subtleOutline.copy(alpha = 0.18f)),
    )
}

@Composable
private fun ComposerActionRow(
    title: String,
    glyph: AgentoWebGlyph,
    onClick: () -> Unit,
    subtitle: String? = null,
    checked: Boolean? = null,
    onCheckedChange: (Boolean) -> Unit = {},
    showChevron: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val stackToggle = checked != null && LocalDensity.current.fontScale >= 1.6f
    val icon: @Composable () -> Unit = {
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(colors.primaryContent.copy(alpha = if (isDark) 0.06f else 0.034f)),
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = glyph,
                contentDescription = null,
                modifier = Modifier.size(15.dp),
                tint = if (checked == true) colors.accentPrimary else colors.primaryContent,
            )
        }
    }
    val label: @Composable (Modifier) -> Unit = { labelModifier ->
        Column(
            modifier = labelModifier,
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                ),
                color = colors.primaryContent,
            )
            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.5.sp),
                    color = colors.tertiaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
    val trailing: @Composable () -> Unit = {
        when {
            checked != null -> Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                AgentoSwitch(
                    checked = checked,
                    onCheckedChange = onCheckedChange,
                    modifier = Modifier.semantics { contentDescription = title },
                )
            }
            showChevron -> AgentoWebIcon(
                glyph = AgentoWebGlyph.ChevronRight,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = colors.tertiaryContent,
            )
        }
    }
    val rowModifier = Modifier
        .fillMaxWidth()
        .heightIn(min = if (subtitle == null) 54.dp else 62.dp)
        .clickable(onClick = onClick)
        .padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp)
    if (stackToggle) {
        Column(
            modifier = rowModifier,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                icon()
                label(Modifier.weight(1f))
            }
            Box(Modifier.align(Alignment.End)) { trailing() }
        }
    } else {
        Row(
            modifier = rowModifier,
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            icon()
            label(Modifier.weight(1f))
            trailing()
        }
    }
}

/** Give long mode labels their own row instead of splitting words beside a switch. */
@Composable
private fun AdaptiveComposerModeRow(
    title: String,
    glyph: AgentoWebGlyph,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val colors = LocalRagentColors.current
    val density = LocalDensity.current
    val style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium)
    val measurer = rememberTextMeasurer()
    val longestWord = remember(title, style, density, measurer) {
        title.split(' ').maxOf { measurer.measure(it, style, softWrap = false, maxLines = 1).size.width }
    }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        val stacked = with(density) { longestWord.toDp() > maxWidth - 32.dp - 10.dp - 48.dp - 12.dp }
        val label: @Composable (Modifier) -> Unit = { labelModifier ->
            Row(labelModifier, verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(32.dp).clip(CircleShape)
                    .background(if (checked) LocalRagentColors.current.accentPrimary.copy(alpha = 0.15f) else Ragentolors.SurfaceLevel2),
                    contentAlignment = Alignment.Center) {
                    AgentoWebIcon(glyph, contentDescription = null, modifier = Modifier.size(16.dp),
                        tint = if (checked) LocalRagentColors.current.accentPrimary else colors.secondaryContent)
                }
                Text(title, modifier = Modifier.weight(1f), style = style, color = colors.primaryContent)
            }
        }
        val toggle: @Composable () -> Unit = {
            // Keep a named stateful switch; the enclosing card remains clickable.
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                AgentoSwitch(checked, onCheckedChange,
                    modifier = Modifier.semantics { contentDescription = title })
            }
        }
        if (stacked) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                label(Modifier.fillMaxWidth())
                Box(Modifier.align(Alignment.End)) { toggle() }
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                label(Modifier.weight(1f))
                toggle()
            }
        }
    }
}

/** Keep a two-column grid only when its words fit at the user's actual font size. */
@Composable
private fun AdaptiveActionPair(
    firstTitle: String,
    secondTitle: String,
    first: @Composable (Modifier) -> Unit,
    second: @Composable (Modifier) -> Unit,
) {
    val density = LocalDensity.current
    val style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold)
    val measurer = rememberTextMeasurer()
    val longestWord = remember(firstTitle, secondTitle, style, density, measurer) {
        listOf(firstTitle, secondTitle).flatMap { it.split(' ') }.maxOf {
            measurer.measure(it, style, softWrap = false, maxLines = 1).size.width
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val textWidth = (maxWidth - 10.dp) / 2 - 24.dp - 20.dp - 10.dp
        val stacked = density.fontScale >= 1.6f || with(density) { longestWord.toDp() > textWidth }
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                first(Modifier.fillMaxWidth())
                second(Modifier.fillMaxWidth())
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                first(Modifier.weight(1f))
                second(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ActionCard(
    title: String,
    glyph: AgentoWebGlyph,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val pressSource = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        interactionSource = pressSource,
        shape = AgentoShapes.SquircleS,
        color = Ragentolors.SurfaceLevel1,
        contentColor = colors.primaryContent,
        modifier = modifier.heightIn(min = 48.dp).agentoPressScale(interactionSource = pressSource),
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentoWebIcon(
                glyph = glyph,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = colors.primaryContent,
            )
            Text(
                text = title,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = colors.primaryContent,
            )
        }
    }
}

/**
 * Helper to determine if an attachment represents an image file.
 */
fun isImageAttachment(attachment: ComposerAttachment): Boolean {
    val mime = attachment.mimeType.lowercase()
    if (mime.startsWith("image/")) return true
    val name = attachment.name.lowercase()
    return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") ||
        name.endsWith(".webp") || name.endsWith(".gif") || name.endsWith(".bmp") ||
        name.endsWith(".heic") || name.endsWith(".heif")
}

private const val MAX_REMOTE_THUMBNAIL_SOURCE_BYTES = 16 * 1024 * 1024

internal suspend fun readThumbnailSourceBounded(stream: InputStream, maxBytes: Int = MAX_REMOTE_THUMBNAIL_SOURCE_BYTES): ByteArray? {
    require(maxBytes >= 0)
    val output = ByteArrayOutputStream(minOf(maxBytes, 16 * 1024))
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
        currentCoroutineContext().ensureActive()
        val count = stream.read(buffer)
        if (count < 0) return output.toByteArray()
        if (count == 0) continue
        if (count > maxBytes - total) return null
        output.write(buffer, 0, count)
        total += count
    }
}

private object AttachmentThumbnailLoader {
    private val memoryCache = object : LruCache<String, ImageBitmap>(32) {}

    fun getCached(key: String): ImageBitmap? = memoryCache.get(key)

    fun putCached(key: String, bitmap: ImageBitmap) {
        memoryCache.put(key, bitmap)
    }

    suspend fun loadThumbnail(
        context: Context,
        attachment: ComposerAttachment,
        reqWidth: Int = 180,
        reqHeight: Int = 180,
    ): ImageBitmap? = withContext(Dispatchers.IO) {
        val pathOrUri = attachment.localPath ?: attachment.previewUrl
        val cacheKey = pathOrUri ?: attachment.id
        getCached(cacheKey)?.let { return@withContext it }

        if (pathOrUri.isNullOrBlank()) {
            if (attachment.id.startsWith("qa-")) {
                val mock = createMockThumbnailBitmap(attachment.name)
                putCached(cacheKey, mock)
                return@withContext mock
            }
            return@withContext null
        }

        val bitmap = runCatching {
            when {
                pathOrUri.startsWith("content://") -> {
                    val uri = Uri.parse(pathOrUri)
                    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    val boundsStream = context.contentResolver.openInputStream(uri) ?: return@withContext null
                    boundsStream.use { BitmapFactory.decodeStream(it, null, options) }
                    if (options.outWidth <= 0 || options.outHeight <= 0) return@withContext null
                    options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight)
                    options.inJustDecodeBounds = false
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        BitmapFactory.decodeStream(stream, null, options)?.asImageBitmap()
                    }
                }
                pathOrUri.startsWith("file://") -> {
                    val uri = Uri.parse(pathOrUri)
                    val filePath = uri.path ?: return@withContext null
                    decodeSampledBitmapFile(filePath, reqWidth, reqHeight)
                }
                pathOrUri.startsWith("http://") || pathOrUri.startsWith("https://") -> {
                    val connection = (URL(pathOrUri).openConnection() as? HttpURLConnection) ?: return@withContext null
                    try {
                        connection.connectTimeout = 3000
                        connection.readTimeout = 3000
                        connection.doInput = true
                        connection.connect()
                        if (connection.responseCode in 200..299 &&
                            (connection.contentLengthLong < 0L || connection.contentLengthLong <= MAX_REMOTE_THUMBNAIL_SOURCE_BYTES)) {
                            val bytes = connection.inputStream.use { readThumbnailSourceBounded(it) }
                            bytes?.let { decodeSampledBitmap(it, reqWidth, reqHeight) }
                        } else null
                    } finally {
                        connection.disconnect()
                    }
                }
                else -> {
                    val file = File(pathOrUri)
                    if (file.exists() && file.isFile) {
                        decodeSampledBitmapFile(file.absolutePath, reqWidth, reqHeight)
                    } else if (attachment.id.startsWith("qa-")) {
                        createMockThumbnailBitmap(attachment.name)
                    } else null
                }
            }
        }.getOrElse { error ->
            if (error is CancellationException) throw error
            null
        }
        currentCoroutineContext().ensureActive()

        if (bitmap != null) {
            putCached(cacheKey, bitmap)
        }
        bitmap
    }

    private fun decodeSampledBitmap(bytes: ByteArray, reqWidth: Int, reqHeight: Int): ImageBitmap? {
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight)
        options.inJustDecodeBounds = false
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        return decoded?.asImageBitmap()
    }

    private fun decodeSampledBitmapFile(path: String, reqWidth: Int, reqHeight: Int): ImageBitmap? {
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeFile(path, options)
        options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight)
        options.inJustDecodeBounds = false
        val decoded = BitmapFactory.decodeFile(path, options)
        return decoded?.asImageBitmap()
    }

    private fun calculateInSampleSize(
        options: BitmapFactory.Options,
        reqWidth: Int,
        reqHeight: Int,
    ): Int {
        val (height: Int, width: Int) = options.outHeight to options.outWidth
        var inSampleSize = 1
        if (height > reqHeight || width > reqWidth) {
            val halfHeight: Int = height / 2
            val halfWidth: Int = width / 2
            while ((halfHeight / inSampleSize) >= reqHeight && (halfWidth / inSampleSize) >= reqWidth) {
                inSampleSize *= 2
            }
        }
        return inSampleSize.coerceAtLeast(1)
    }

    private fun createMockThumbnailBitmap(name: String): ImageBitmap {
        val size = 160
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        paint.shader = android.graphics.LinearGradient(
            0f, 0f, size.toFloat(), size.toFloat(),
            intArrayOf(android.graphics.Color.rgb(41, 128, 185), android.graphics.Color.rgb(44, 62, 80)),
            null,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), paint)

        paint.shader = null
        paint.color = android.graphics.Color.argb(220, 241, 196, 15)
        canvas.drawCircle(size * 0.72f, size * 0.30f, size * 0.12f, paint)

        paint.color = android.graphics.Color.argb(160, 52, 73, 94)
        val pathBack = Path().apply {
            moveTo(size * 0.20f, size.toFloat())
            lineTo(size * 0.58f, size * 0.44f)
            lineTo(size.toFloat(), size.toFloat())
            close()
        }
        canvas.drawPath(pathBack, paint)

        paint.color = android.graphics.Color.argb(220, 26, 188, 156)
        val pathFront = Path().apply {
            moveTo(0f, size.toFloat())
            lineTo(size * 0.35f, size * 0.54f)
            lineTo(size * 0.80f, size.toFloat())
            close()
        }
        canvas.drawPath(pathFront, paint)

        return bitmap.asImageBitmap()
    }
}

@Composable
fun rememberAttachmentThumbnail(attachment: ComposerAttachment): ImageBitmap? {
    val context = LocalContext.current
    val key = attachment.localPath ?: attachment.previewUrl ?: attachment.id
    return key(key) {
        val initial = remember { AttachmentThumbnailLoader.getCached(key) }
        val bitmapState = produceState(initialValue = initial) {
            if (value == null) {
                value = AttachmentThumbnailLoader.loadThumbnail(context, attachment)
            }
        }
        bitmapState.value
    }
}

/**
 * Attachment Tray (Spec-01)
 * Horizontal preview strip of currently attached media/documents,
 * with adaptive positioning of the CancelEditPill.
 *
 * When remaining horizontal space in the attachment row is sufficient,
 * the CancelEditPill is positioned immediately to the right of the last attachment,
 * with its bottom edge flush with the attachments.
 * When space is insufficient (or when there are no attachments while editing),
 * it transitions smoothly to the top-left position above the attachments.
 */
@Composable
fun AttachmentTray(
    attachments: List<ComposerAttachment>,
    onRemove: (ComposerAttachment) -> Unit,
    isEditing: Boolean = false,
    onCancelEdit: (() -> Unit)? = null,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    if (attachments.isEmpty() && !isEditing) return

    val density = LocalDensity.current
    val itemWidths = remember { mutableStateMapOf<String, Int>() }
    var measuredPillWidthPx by remember { mutableIntStateOf(0) }
    var measuredPillHeightPx by remember { mutableIntStateOf(0) }

    val pillWidth = if (measuredPillWidthPx > 0) with(density) { measuredPillWidthPx.toDp() } else 96.dp
    val pillHeight = 34.dp

    val maxAttachmentHeight = when {
        attachments.any { isImageAttachment(it) } -> 60.dp
        attachments.isNotEmpty() -> 54.dp
        else -> 0.dp
    }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 2.dp),
    ) {
        val availableWidth = if (maxWidth.value.isFinite() && maxWidth > 0.dp) maxWidth else 360.dp

        // Compute total width of all attachments
        val totalAttachmentsWidth = attachments.map { att ->
            itemWidths[att.id]?.let { px -> with(density) { px.toDp() } }
                ?: if (isImageAttachment(att)) 60.dp else 170.dp
        }.fold(0.dp) { acc, dp -> acc + dp } + ((attachments.size - 1).coerceAtLeast(0) * 8).dp

        val requiredRowWidth = 4.dp + totalAttachmentsWidth + 8.dp + pillWidth + 4.dp
        val fitsInRow = isEditing && attachments.isNotEmpty() && (requiredRowWidth <= availableWidth)

        // Targets for Pill X, Pill Y, Attachments Y, Container Height
        val targetPillX = when {
            !isEditing -> 4.dp
            attachments.isEmpty() -> 4.dp
            fitsInRow -> 4.dp + totalAttachmentsWidth + 8.dp
            else -> 4.dp
        }

        val targetPillY = when {
            !isEditing -> 4.dp
            attachments.isEmpty() -> 4.dp
            fitsInRow -> 4.dp + (maxAttachmentHeight - pillHeight)
            else -> 4.dp
        }

        val targetAttachmentsY = when {
            attachments.isEmpty() -> 0.dp
            !isEditing || fitsInRow -> 4.dp
            else -> 4.dp + pillHeight + 8.dp
        }

        val targetContainerHeight = when {
            attachments.isEmpty() && isEditing -> 4.dp + pillHeight + 4.dp
            !isEditing -> 4.dp + maxAttachmentHeight + 4.dp
            fitsInRow -> 4.dp + maxAttachmentHeight + 4.dp
            else -> 4.dp + pillHeight + 8.dp + maxAttachmentHeight + 4.dp
        }

        val springSpec = spring<Dp>(
            dampingRatio = 0.82f,
            stiffness = 380f,
        )

        val animatedPillX by animateDpAsState(targetValue = targetPillX, animationSpec = springSpec, label = "pill_x")
        val animatedPillY by animateDpAsState(targetValue = targetPillY, animationSpec = springSpec, label = "pill_y")
        val animatedAttachmentsY by animateDpAsState(targetValue = targetAttachmentsY, animationSpec = springSpec, label = "att_y")
        val animatedContainerHeight by animateDpAsState(targetValue = targetContainerHeight, animationSpec = springSpec, label = "container_h")

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(animatedContainerHeight),
        ) {
            // Attachments Row
            if (attachments.isNotEmpty()) {
                val rowScrollState = rememberScrollState()
                Row(
                    modifier = Modifier
                        .then(
                            if (fitsInRow) {
                                Modifier.width((4.dp + totalAttachmentsWidth + 4.dp).coerceAtMost(availableWidth))
                            } else {
                                Modifier.fillMaxWidth()
                            }
                        )
                        .offset(y = animatedAttachmentsY)
                        .horizontalScroll(rowScrollState)
                        .padding(horizontal = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    attachments.forEach { attachment ->
                        key(attachment.id) {
                            AttachmentThumbnailCard(
                                attachment = attachment,
                                onRemove = { onRemove(attachment) },
                                backdropLayer = backdropLayer,
                                backdropOrigin = backdropOrigin,
                                modifier = Modifier.onSizeChanged { size ->
                                    if (size.width > 0) {
                                        itemWidths[attachment.id] = size.width
                                    }
                                },
                            )
                        }
                    }
                }
            }

            // Cancel Edit Pill
            if (isEditing && onCancelEdit != null) {
                Box(
                    modifier = Modifier
                        .offset(x = animatedPillX, y = animatedPillY)
                        .onSizeChanged { size ->
                            if (size.width > 0) measuredPillWidthPx = size.width
                            if (size.height > 0) measuredPillHeightPx = size.height
                        },
                ) {
                    CancelEditPill(
                        onCancel = onCancelEdit,
                        backdropLayer = backdropLayer,
                        backdropOrigin = backdropOrigin,
                    )
                }
            }
        }
    }
}

/**
 * Image Attachment Thumbnail Card (ChatGPT style)
 * Square rounded squircle rendering the actual image thumbnail, with top-right overlay close button.
 */
@Composable
fun ImageAttachmentThumbnailCard(
    attachment: ComposerAttachment,
    onRemove: (() -> Unit)?,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val bitmap = rememberAttachmentThumbnail(attachment)
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }
    val cardShape = RoundedCornerShape(18.dp)

    Box(
        modifier = modifier
            .size(60.dp)
            .ragentComposerShadow(shape = cardShape)
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            }
            .semantics {
                this[SemanticsProperties.Text] = listOf(AnnotatedString(attachment.name))
                contentDescription = attachment.name
            },
    ) {
        AgentoFrostedGlassBox(
            modifier = Modifier.fillMaxSize(),
            shape = cardShape,
            surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.86f)) else AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            backdropLayer = backdropLayer,
            backdropOffset = backdropOffset,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = false,
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Image,
                            contentDescription = null,
                            modifier = Modifier.size(24.dp),
                            tint = colors.secondaryContent.copy(alpha = 0.6f),
                        )
                    }
                }

                if (attachment.state == AttachmentState.Uploading || attachment.state == AttachmentState.Pending) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.35f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                    }
                }

                // Overlay specular border on top of the image so the high-end glass border outline stays crisp
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .border(
                            width = 0.75.dp,
                            brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                            shape = cardShape,
                        ),
                )

                // Top-right close button (ChatGPT style overlay)
                if (onRemove != null) Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 4.dp, end = 4.dp)
                        .size(18.dp)
                        .clip(CircleShape)
                        .background(Color.Black.copy(alpha = 0.55f))
                        .clickable(
                            role = Role.Button,
                            onClick = onRemove,
                        )
                        .semantics { contentDescription = "Remove ${attachment.name}" },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Close,
                        contentDescription = null,
                        modifier = Modifier.size(9.dp),
                        tint = Color.White,
                    )
                }
            }
        }
    }
}

/**
 * Document Attachment Thumbnail Card (ChatGPT style)
 * Clean horizontal pill card with type badge (e.g. red for PDF), truncated title, extension & size, and close button.
 */
@Composable
fun DocumentAttachmentThumbnailCard(
    attachment: ComposerAttachment,
    onRemove: (() -> Unit)?,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    val extension = remember(attachment.name) {
        attachment.name.substringAfterLast('.', "").uppercase().take(4)
    }
    val isPdf = remember(attachment.mimeType, extension) {
        attachment.mimeType.contains("pdf", ignoreCase = true) || extension == "PDF"
    }
    val isCode = remember(extension) {
        extension in listOf("JSON", "PY", "KT", "JS", "TS", "HTML", "CSS", "XML", "YAML", "YML", "SH", "MD")
    }
    val isSheet = remember(extension) {
        extension in listOf("CSV", "XLS", "XLSX")
    }

    val (badgeBg, badgeTint) = when {
        isPdf -> (if (isDark) Color(0x33E53935) else Color(0x1FE53935)) to Color(0xFFE53935)
        isCode -> colors.accentPrimary.copy(alpha = if (isDark) 0.20f else 0.12f) to colors.accentPrimary
        isSheet -> (if (isDark) Color(0x332E7D32) else Color(0x1F2E7D32)) to Color(0xFF2E7D32)
        else -> (if (isDark) Color(0x28FFFFFF) else Color(0x12000000)) to colors.secondaryContent
    }

    val cardShape = RoundedCornerShape(18.dp)

    Box(
        modifier = modifier
            .widthIn(min = 140.dp, max = 220.dp)
            .height(54.dp)
            .ragentComposerShadow(shape = cardShape)
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
    ) {
        AgentoFrostedGlassBox(
            modifier = Modifier.fillMaxSize(),
            shape = cardShape,
            surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.86f)) else AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            backdropLayer = backdropLayer,
            backdropOffset = backdropOffset,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = false,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Type badge
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(badgeBg),
                    contentAlignment = Alignment.Center,
                ) {
                    if (isPdf) {
                        Text(
                            text = "PDF",
                            style = RagentTextStyles.caption.copy(
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                color = badgeTint,
                            ),
                        )
                    } else {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.File,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = badgeTint,
                        )
                    }
                }

                // Name and size
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = attachment.name,
                        style = RagentTextStyles.caption.copy(fontWeight = FontWeight.SemiBold, fontSize = 12.sp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = colors.primaryContent,
                    )
                    val subText = buildString {
                        if (extension.isNotBlank()) {
                            append(extension)
                            append(" · ")
                        }
                        append(formatFileSize(attachment.sizeBytes))
                    }
                    Text(
                        text = subText,
                        style = RagentTextStyles.caption.copy(fontSize = 10.sp),
                        maxLines = 1,
                        color = colors.secondaryContent,
                    )
                }

                // Remove button
                if (onRemove != null) Box(
                    modifier = Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(if (isDark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.06f))
                        .clickable(
                            role = Role.Button,
                            onClick = onRemove,
                        )
                        .semantics { contentDescription = "Remove ${attachment.name}" },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Close,
                        contentDescription = null,
                        modifier = Modifier.size(10.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }
        }
    }
}

/**
 * Attachment Thumbnail Card dispatcher.
 * Routes to ImageAttachmentThumbnailCard if attachment is an image, otherwise DocumentAttachmentThumbnailCard.
 */
@Composable
fun AttachmentThumbnailCard(
    attachment: ComposerAttachment,
    onRemove: (() -> Unit)?,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    if (isImageAttachment(attachment)) {
        ImageAttachmentThumbnailCard(
            attachment = attachment,
            onRemove = onRemove,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = modifier,
        )
    } else {
        DocumentAttachmentThumbnailCard(
            attachment = attachment,
            onRemove = onRemove,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = modifier,
        )
    }
}

/**
 * Edit-Resend Pill (Spec-01)
 * Displays a compact capsule button to cancel editing a queued message or turn.
 */
@Composable
fun EditTurnBanner(
    turnText: String = "",
    supportingText: String? = null,
    onCancel: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        CancelEditPill(
            onCancel = onCancel,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
        )
    }
}

/**
 * Capsule-shaped cancel edit button (left-aligned above attachments / composer).
 */
@Composable
fun CancelEditPill(
    onCancel: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val cancelText = stringResource(R.string.composer_cancel_edit)
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    Box(
        modifier = modifier
            .ragentComposerShadow(shape = AgentoShapes.PillShape)
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            }
            .clip(AgentoShapes.PillShape)
            .agentoPressScale(pressedScale = 0.95f, onClick = onCancel)
            .semantics {
                role = Role.Button
                contentDescription = cancelText
            },
    ) {
        AgentoFrostedGlassBox(
            shape = AgentoShapes.PillShape,
            surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.86f)) else AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            backdropLayer = backdropLayer,
            backdropOffset = backdropOffset,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = false,
        ) {
            Row(
                modifier = Modifier
                    .height(34.dp)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Close,
                    contentDescription = null,
                    modifier = Modifier.size(11.dp),
                    tint = colors.secondaryContent,
                )
                Text(
                    text = cancelText,
                    style = RagentTextStyles.caption.copy(
                        fontWeight = FontWeight.Medium,
                        fontSize = 12.sp,
                    ),
                    color = colors.primaryContent,
                )
            }
        }
    }
}

/** The head of the server-owned queue; actions always target the displayed item. */
@Composable
fun QueuedMessageRail(
    queuedMessages: List<QueuedMessageUiState>,
    onSteer: (QueuedMessageUiState) -> Unit,
    onRemove: (QueuedMessageUiState) -> Unit,
    modifier: Modifier = Modifier,
) {
    val next = queuedMessages.firstOrNull() ?: return
    ComposerSupportRail(
        title = pluralStringResource(R.plurals.composer_queued_messages, queuedMessages.size, queuedMessages.size),
        preview = next.text.ifBlank {
            if (next.attachments.isNotEmpty()) {
                pluralStringResource(R.plurals.composer_queued_attachments, next.attachments.size, next.attachments.size)
            } else stringResource(R.string.composer_message_no_text)
        },
        modifier = modifier.testTag("composer-queue-rail"),
    ) {
        ComposerRailAction(stringResource(R.string.composer_steer), { onSteer(next) })
        AgentoIconButton(onClick = { onRemove(next) },
            contentDescription = stringResource(R.string.composer_remove_queued)) {
            AgentoWebIcon(AgentoWebGlyph.Close, contentDescription = null,
                modifier = Modifier.size(20.dp), tint = LocalRagentColors.current.secondaryContent)
        }
    }
}

/** A quiet content rail, not another primary action or decorative glass card. */
@Composable
private fun ComposerSupportRail(
    title: String,
    preview: String,
    supportingText: String? = null,
    modifier: Modifier,
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    Surface(modifier = modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp),
        color = colors.quietSurface, contentColor = colors.primaryContent) {
        BoxWithConstraints(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            val stacked = maxWidth < 340.dp || LocalDensity.current.fontScale >= 1.4f
            val summary: @Composable (Modifier) -> Unit = { summaryModifier ->
                Column(summaryModifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(title, style = MaterialTheme.typography.labelMedium, color = colors.secondaryContent)
                    Text(preview, style = MaterialTheme.typography.bodyMedium, maxLines = 2,
                        overflow = TextOverflow.Ellipsis, color = colors.primaryContent)
                    if (supportingText != null) {
                        Text(
                            supportingText,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            if (stacked) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    summary(Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically, content = actions)
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    summary(Modifier.weight(1f))
                    Row(verticalAlignment = Alignment.CenterVertically, content = actions)
                }
            }
        }
    }
}

@Composable
private fun ComposerRailAction(label: String, onClick: () -> Unit) {
    Box(Modifier.widthIn(min = 48.dp, max = 160.dp).heightIn(min = 48.dp).clip(AgentoShapes.PillShape)
        .clickable(role = Role.Button, onClick = onClick)
        .padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(label, style = MaterialTheme.typography.labelLarge,
            color = LocalRagentColors.current.accentPrimary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}
private fun formatFileSize(bytes: Long): String = when {
    bytes <= 0 -> "0 KB"
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
}

/**
 * Turn Version Switcher Rail `< 1 / N >` (Spec-02)
 * Allows switching between multiple regenerated/edited versions of an Agent message.
 */
@Composable
fun TurnVersionSwitcher(
    currentVersion: Int,
    totalVersions: Int,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (totalVersions <= 1) return
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    Surface(
        shape = RoundedCornerShape(percent = 50),
        color = if (isDark) Ragentolors.SurfaceLevel2 else Ragentolors.SurfaceLevel1,
        contentColor = colors.primaryContent,
        modifier = modifier.height(26.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // Previous button
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(CircleShape)
                    .clickable(enabled = currentVersion > 1, onClick = onPrevious)
                    .semantics { contentDescription = "Previous version" },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "‹",
                    style = androidx.compose.ui.text.TextStyle(
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (currentVersion > 1) colors.primaryContent else colors.disabledContent,
                    ),
                )
            }

            Text(
                text = "$currentVersion / $totalVersions",
                style = RagentTextStyles.caption.copy(
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                ),
                color = colors.secondaryContent,
            )

            // Next button
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(CircleShape)
                    .clickable(enabled = currentVersion < totalVersions, onClick = onNext)
                    .semantics { contentDescription = "Next version" },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "›",
                    style = androidx.compose.ui.text.TextStyle(
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (currentVersion < totalVersions) colors.primaryContent else colors.disabledContent,
                    ),
                )
            }
        }
    }
}

/**
 * Session Goal Panel (Spec-01 & Goal chasing modal)
 * Allows configuring session goal, starting/pausing auto-continue, clearing or saving goal.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalPanelModalBottomSheet(
    onDismiss: () -> Unit,
    goalText: String,
    autoContinue: Boolean,
    onSaveGoal: (String) -> Unit,
    onClearGoal: () -> Unit,
    onStartAutoContinue: (String) -> Unit,
    onPauseAutoContinue: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var currentInput by androidx.compose.runtime.remember(goalText) {
        androidx.compose.runtime.mutableStateOf(goalText)
    }
    val inputDescription = stringResource(R.string.goal_input)
    val closeDescription = stringResource(R.string.goal_close)
    val status = when {
        currentInput.trim() != goalText.trim() -> R.string.goal_unsaved
        autoContinue -> R.string.goal_running
        goalText.isNotBlank() -> R.string.goal_saved
        else -> R.string.goal_empty_hint
    }
    val isDirty = currentInput.trim() != goalText.trim()

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier.imePadding(),
    ) {
        val dismiss = LocalModalBottomSheetDismiss.current ?: onDismiss
        val insetCardBg = colors.primaryContent.copy(alpha = if (isDark) 0.065f else 0.038f)

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("goal-panel-content")
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AgentoSpacing.ComposerMargin, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        text = stringResource(R.string.goal_title),
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 18.sp,
                        ),
                        color = colors.primaryContent,
                    )
                    if (isDirty || autoContinue || goalText.isNotBlank()) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Box(
                                Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            isDirty -> colors.stateWarning
                                            autoContinue -> colors.accentPrimary
                                            else -> colors.stateSuccess
                                        },
                                    ),
                            )
                            Text(
                                text = stringResource(status),
                                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.5.sp),
                                color = colors.secondaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("goal-panel-close")
                        .clip(CircleShape)
                        .clickable(onClick = dismiss)
                        .semantics { contentDescription = closeDescription },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(colors.primaryContent.copy(alpha = if (isDark) 0.09f else 0.055f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Close,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                            tint = colors.secondaryContent,
                        )
                    }
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(20.dp))
                    .background(insetCardBg)
                    .padding(horizontal = 15.dp, vertical = 13.dp),
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(modifier = Modifier.fillMaxWidth()) {
                        if (currentInput.isEmpty()) {
                            Text(
                                text = stringResource(R.string.goal_placeholder),
                                style = MaterialTheme.typography.bodyLarge.copy(
                                    fontSize = 14.5.sp,
                                    lineHeight = 21.sp,
                                ),
                                color = colors.secondaryContent.copy(alpha = 0.55f),
                            )
                        }
                        androidx.compose.foundation.text.BasicTextField(
                            value = currentInput,
                            onValueChange = { currentInput = it },
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics { contentDescription = inputDescription },
                            textStyle = MaterialTheme.typography.bodyLarge.copy(
                                fontSize = 14.5.sp,
                                color = colors.primaryContent,
                                lineHeight = 21.sp,
                            ),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(colors.accentPrimary),
                            minLines = 3,
                            maxLines = 6,
                        )
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(0.5.dp)
                            .background(colors.subtleOutline.copy(alpha = 0.60f)),
                    )
                    Text(
                        text = stringResource(R.string.goal_empty_hint),
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontSize = 11.5.sp,
                            lineHeight = 16.sp,
                            color = colors.tertiaryContent,
                        ),
                    )
                }
            }

            val primaryLabel = when {
                autoContinue -> stringResource(R.string.goal_pause)
                isDirty -> stringResource(R.string.goal_save)
                else -> stringResource(R.string.goal_start)
            }
            val primaryGlyph = when {
                autoContinue -> AgentoWebGlyph.Pause
                isDirty -> AgentoWebGlyph.TargetArrow
                else -> AgentoWebGlyph.Play
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(AgentoShapes.PillShape)
                    .background(colors.actionPrimary)
                    .agentoPressScale(
                        pressedScale = 0.975f,
                        onClick = {
                            when {
                                autoContinue -> onPauseAutoContinue()
                                isDirty -> {
                                    onSaveGoal(currentInput.trim())
                                }
                                else -> onStartAutoContinue(currentInput.trim())
                            }
                        },
                    )
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    AgentoWebIcon(
                        glyph = primaryGlyph,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = colors.actionPrimaryContent,
                    )
                    Text(
                        text = primaryLabel,
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.actionPrimaryContent,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clip(AgentoShapes.PillShape)
                    .agentoPressScale(
                        pressedScale = 0.98f,
                        onClick = {
                            onClearGoal()
                        },
                    )
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(if (goalText.isNotBlank()) R.string.goal_clear else R.string.goal_disable),
                    color = if (goalText.isNotBlank()) colors.error else colors.secondaryContent,
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Medium),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
            Spacer(Modifier.height(6.dp))
        }
    }
}
/**
 * Inline Agent & Apps Picker Modal Bottom Sheet (Spec-01 / Web-Parity)
 * Opened from Composer '+' Action Sheet "Agents & Apps" item.
 * Allows quick selection of agent workflows without navigating away from chat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentPanelModalBottomSheet(
    onDismiss: () -> Unit,
    agents: List<WebAgent>,
    selectedAgentId: String? = null,
    onSelectAgent: (WebAgent?) -> Unit,
    onOpenManageAgents: () -> Unit,
    isLoading: Boolean = false,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = AgentoSpacing.ComposerMargin, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Header: Icon + Title + Close (叉号)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(LocalRagentColors.current.accentPrimary.copy(alpha = 0.15f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Agent,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = LocalRagentColors.current.accentPrimary,
                        )
                    }
                    Text(
                        text = "Agents & apps",
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 17.sp,
                        ),
                        color = colors.primaryContent,
                    )
                }

                // 右上角叉号关闭按钮
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onDismiss)
                        .semantics { contentDescription = "Close agent panel" },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Close,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }

            // Agent List
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // 1. Default Agent Item
                val isDefaultSelected = selectedAgentId.isNullOrBlank()
                val defaultPress = remember { MutableInteractionSource() }
                Surface(
                    onClick = {
                        onSelectAgent(null)
                        onDismiss()
                    },
                    interactionSource = defaultPress,
                    shape = AgentoShapes.SquircleS,
                    color = if (isDefaultSelected) LocalRagentColors.current.accentPrimary.copy(alpha = 0.08f) else Ragentolors.SurfaceLevel1,
                    contentColor = colors.primaryContent,
                    border = if (isDefaultSelected) {
                        BorderStroke(1.dp, LocalRagentColors.current.accentPrimary.copy(alpha = 0.35f))
                    } else null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .agentoPressScale(interactionSource = defaultPress)
                        .semantics { contentDescription = "Default Agent" },
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.weight(1f),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(CircleShape)
                                    .background(if (isDefaultSelected) LocalRagentColors.current.accentPrimary.copy(alpha = 0.18f) else Ragentolors.SurfaceLevel2),
                                contentAlignment = Alignment.Center,
                            ) {
                                AgentoWebIcon(
                                    glyph = AgentoWebGlyph.Agent,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                    tint = if (isDefaultSelected) LocalRagentColors.current.accentPrimary else colors.secondaryContent,
                                )
                            }
                            Column {
                                Text(
                                    text = "Ragent Default",
                                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                                    color = colors.primaryContent,
                                )
                                Text(
                                    text = "Use Ragent's default conversation behavior",
                                    style = RagentTextStyles.caption.copy(fontSize = 11.sp),
                                    color = colors.secondaryContent,
                                )
                            }
                        }

                        if (isDefaultSelected) {
                            Box(
                                modifier = Modifier
                                    .size(24.dp)
                                    .clip(CircleShape)
                                    .background(LocalRagentColors.current.actionPrimary),
                                contentAlignment = Alignment.Center,
                            ) {
                                AgentoWebIcon(
                                    glyph = AgentoWebGlyph.Check,
                                    contentDescription = "Selected",
                                    modifier = Modifier.size(14.dp),
                                    tint = colors.actionPrimaryContent,
                                )
                            }
                        }
                    }
                }

                // 2. Custom Agents
                for (agent in agents) {
                    val isSelected = selectedAgentId == agent.id
                    val agentPress = remember(agent.id) { MutableInteractionSource() }
                    Surface(
                        onClick = {
                            onSelectAgent(agent)
                            onDismiss()
                        },
                        interactionSource = agentPress,
                        shape = AgentoShapes.SquircleS,
                        color = if (isSelected) LocalRagentColors.current.accentPrimary.copy(alpha = 0.08f) else Ragentolors.SurfaceLevel1,
                        contentColor = colors.primaryContent,
                        border = if (isSelected) {
                            BorderStroke(1.dp, LocalRagentColors.current.accentPrimary.copy(alpha = 0.35f))
                        } else null,
                        modifier = Modifier
                            .fillMaxWidth()
                            .agentoPressScale(interactionSource = agentPress)
                            .semantics { contentDescription = agent.name },
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                modifier = Modifier.weight(1f),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(36.dp)
                                        .clip(CircleShape)
                                        .background(if (isSelected) LocalRagentColors.current.accentPrimary.copy(alpha = 0.18f) else Ragentolors.SurfaceLevel2),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    AgentoWebIcon(
                                        glyph = if (agent.tool == "claude") AgentoWebGlyph.Terminal else AgentoWebGlyph.Agent,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                        tint = if (isSelected) LocalRagentColors.current.accentPrimary else colors.secondaryContent,
                                    )
                                }
                                Column {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Text(
                                            text = agent.name,
                                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                                            color = colors.primaryContent,
                                        )
                                        if (agent.tool.isNotBlank()) {
                                            Surface(
                                                shape = RoundedCornerShape(4.dp),
                                                color = Ragentolors.SurfaceLevel2,
                                                modifier = Modifier.padding(horizontal = 2.dp),
                                            ) {
                                                Text(
                                                    text = agent.tool,
                                                    style = RagentTextStyles.caption.copy(fontSize = 10.sp, fontWeight = FontWeight.Medium),
                                                    color = colors.secondaryContent,
                                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                                                )
                                            }
                                        }
                                    }
                                    Text(
                                        text = agent.description.ifBlank { "Reusable workflow for the next message" },
                                        style = RagentTextStyles.caption.copy(fontSize = 11.sp),
                                        color = colors.secondaryContent,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }

                            if (isSelected) {
                                Box(
                                    modifier = Modifier
                                        .size(24.dp)
                                        .clip(CircleShape)
                                        .background(LocalRagentColors.current.actionPrimary),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    AgentoWebIcon(
                                        glyph = AgentoWebGlyph.Check,
                                        contentDescription = "Selected",
                                        modifier = Modifier.size(14.dp),
                                        tint = colors.actionPrimaryContent,
                                    )
                                }
                            }
                        }
                    }
                }

                if (agents.isEmpty() && !isLoading) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "No custom agents configured yet.",
                            style = RagentTextStyles.caption.copy(color = colors.disabledContent, fontSize = 12.sp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(4.dp))

            // Footer: Manage agents button
            val manageAgentsPress = remember { MutableInteractionSource() }
            Surface(
                onClick = {
                    onDismiss()
                    onOpenManageAgents()
                },
                interactionSource = manageAgentsPress,
                shape = AgentoShapes.SquircleS,
                color = Ragentolors.SurfaceLevel2,
                contentColor = colors.primaryContent,
                modifier = Modifier
                    .fillMaxWidth()
                    .agentoPressScale(interactionSource = manageAgentsPress),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Settings,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = colors.secondaryContent,
                        )
                        Text(
                            text = "Manage agents…",
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                            color = colors.primaryContent,
                        )
                    }
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.ChevronRight,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}

/**
 * Inline Connector & MCP Tools Picker Modal Bottom Sheet (Spec-01 / Web-Parity)
 * Opened from Composer '+' Action Sheet "Connectors" item.
 * Allows viewing integrations and MCP status without navigating away from chat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectorPanelModalBottomSheet(
    onDismiss: () -> Unit,
    connectors: List<WebConnector>,
    mcpServers: List<WebMcpServer>,
    onOpenManageConnectors: () -> Unit,
    onCopyCalendarFeed: (() -> Unit)? = null,
    isLoading: Boolean = false,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val scrollState = rememberScrollState()

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = AgentoSpacing.ComposerMargin, vertical = 8.dp)
                .verticalScroll(scrollState),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Header: Icon + Title + Close (叉号)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(LocalRagentColors.current.accentPrimary.copy(alpha = 0.15f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Share,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = LocalRagentColors.current.accentPrimary,
                        )
                    }
                    Text(
                        text = "Connectors",
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 17.sp,
                        ),
                        color = colors.primaryContent,
                    )
                }

                // 右上角叉号关闭按钮
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onDismiss)
                        .semantics { contentDescription = "Close connector panel" },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Close,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }

            Text(
                text = "External integrations, calendar feeds, and developer MCP tools.",
                style = RagentTextStyles.caption.copy(
                    fontSize = 12.sp,
                    color = colors.secondaryContent,
                ),
            )

            // Section 1: Integrations & Services
            Text(
                text = "Services & Integrations",
                style = RagentTextStyles.caption.copy(
                    fontWeight = FontWeight.SemiBold,
                    color = colors.secondaryContent,
                ),
            )

            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Built-in cards
                // 1. Google Account (Calendar, Gmail, Drive)
                val googleConnector = connectors.firstOrNull { it.id.contains("google", ignoreCase = true) || it.id.contains("calendar", ignoreCase = true) }
                val isGoogleReady = googleConnector?.ready == true
                ConnectorStatusCard(
                    title = "Google Services",
                    detail = "Calendar, Gmail and Drive access",
                    glyph = AgentoWebGlyph.Home,
                    statusText = if (isGoogleReady) "Connected" else "Not configured",
                    isReady = isGoogleReady,
                )

                // 2. Calendar Feed
                ConnectorStatusCard(
                    title = "Calendar Feed (iCal)",
                    detail = "Instant calendar subscription link",
                    glyph = AgentoWebGlyph.Clock,
                    statusText = "Ready",
                    isReady = true,
                    actionLabel = "Copy Link",
                    onAction = onCopyCalendarFeed,
                )

                // 3. GitHub
                val gitHubConnector = connectors.firstOrNull { it.id.contains("github", ignoreCase = true) }
                val isGitHubReady = gitHubConnector?.ready == true
                ConnectorStatusCard(
                    title = "GitHub",
                    detail = "Repositories, issues, and code PRs",
                    glyph = AgentoWebGlyph.Monitor,
                    statusText = if (isGitHubReady) "Connected" else "Not configured",
                    isReady = isGitHubReady,
                )

                // 4. Mail Relay
                val mailConnector = connectors.firstOrNull { it.id.contains("mail", ignoreCase = true) && !it.id.contains("gmail", ignoreCase = true) }
                val isMailReady = mailConnector?.ready == true
                ConnectorStatusCard(
                    title = "Mail Relay",
                    detail = "Outbound email notifications",
                    glyph = AgentoWebGlyph.ChatBubble,
                    statusText = if (isMailReady) "Connected" else "Not configured",
                    isReady = isMailReady,
                )

                // Additional dynamic connectors from server
                val otherConnectors = connectors.filter {
                    !it.id.contains("google", ignoreCase = true) &&
                    !it.id.contains("calendar", ignoreCase = true) &&
                    !it.id.contains("github", ignoreCase = true) &&
                    !it.id.contains("mail", ignoreCase = true)
                }
                for (connector in otherConnectors) {
                    ConnectorStatusCard(
                        title = connector.name,
                        detail = connector.detail.ifBlank { "Configured connector" },
                        glyph = AgentoWebGlyph.Share,
                        statusText = if (connector.ready) "Connected" else "Not configured",
                        isReady = connector.ready,
                    )
                }
            }

            // Section 2: MCP Servers
            Text(
                text = "MCP Servers (Model Context Protocol)",
                style = RagentTextStyles.caption.copy(
                    fontWeight = FontWeight.SemiBold,
                    color = colors.secondaryContent,
                ),
            )

            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (mcpServers.isNotEmpty()) {
                    for (server in mcpServers) {
                        Surface(
                            shape = AgentoShapes.SquircleS,
                            color = Ragentolors.SurfaceLevel1,
                            contentColor = colors.primaryContent,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 14.dp, vertical = 10.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(32.dp)
                                            .clip(CircleShape)
                                            .background(Ragentolors.SurfaceLevel2),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        AgentoWebIcon(
                                            glyph = AgentoWebGlyph.Terminal,
                                            contentDescription = null,
                                            modifier = Modifier.size(16.dp),
                                            tint = colors.secondaryContent,
                                        )
                                    }
                                    Column {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            Text(
                                                text = server.name,
                                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                                                color = colors.primaryContent,
                                            )
                                            Surface(
                                                shape = RoundedCornerShape(4.dp),
                                                color = Ragentolors.SurfaceLevel2,
                                            ) {
                                                Text(
                                                    text = server.family,
                                                    style = RagentTextStyles.caption.copy(fontSize = 9.sp, fontWeight = FontWeight.Bold),
                                                    color = colors.secondaryContent,
                                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                                                )
                                            }
                                        }
                                        Text(
                                            text = server.detail,
                                            style = RagentTextStyles.caption.copy(fontSize = 11.sp),
                                            color = colors.secondaryContent,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }

                                Surface(
                                    shape = RoundedCornerShape(percent = 50),
                                    color = Ragentolors.Success.copy(alpha = 0.12f),
                                ) {
                                    Text(
                                        text = "Ready",
                                        style = RagentTextStyles.caption.copy(
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.SemiBold,
                                            color = Ragentolors.Success,
                                        ),
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                    )
                                }
                            }
                        }
                    }
                } else if (!isLoading) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "No MCP servers configured yet.",
                            style = RagentTextStyles.caption.copy(color = colors.disabledContent, fontSize = 12.sp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(4.dp))

            // Footer: Manage connectors button
            val manageConnectorsPress = remember { MutableInteractionSource() }
            Surface(
                onClick = {
                    onDismiss()
                    onOpenManageConnectors()
                },
                interactionSource = manageConnectorsPress,
                shape = AgentoShapes.SquircleS,
                color = Ragentolors.SurfaceLevel2,
                contentColor = colors.primaryContent,
                modifier = Modifier
                    .fillMaxWidth()
                    .agentoPressScale(interactionSource = manageConnectorsPress),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Settings,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = colors.secondaryContent,
                        )
                        Text(
                            text = "Manage connectors…",
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                            color = colors.primaryContent,
                        )
                    }
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.ChevronRight,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ConnectorStatusCard(
    title: String,
    detail: String,
    glyph: AgentoWebGlyph,
    statusText: String,
    isReady: Boolean,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    Surface(
        shape = AgentoShapes.SquircleS,
        color = Ragentolors.SurfaceLevel1,
        contentColor = colors.primaryContent,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.weight(1f),
            ) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(if (isReady) LocalRagentColors.current.accentPrimary.copy(alpha = 0.12f) else Ragentolors.SurfaceLevel2),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = glyph,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = if (isReady) LocalRagentColors.current.accentPrimary else colors.secondaryContent,
                    )
                }
                Column {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.primaryContent,
                    )
                    Text(
                        text = detail,
                        style = RagentTextStyles.caption.copy(fontSize = 11.sp),
                        color = colors.secondaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (actionLabel != null && onAction != null) {
                    val actionPress = remember { MutableInteractionSource() }
                    Surface(
                        onClick = onAction,
                        interactionSource = actionPress,
                        shape = RoundedCornerShape(percent = 50),
                        color = LocalRagentColors.current.accentPrimary.copy(alpha = 0.12f),
                        contentColor = LocalRagentColors.current.accentPrimary,
                        modifier = Modifier.agentoPressScale(interactionSource = actionPress),
                    ) {
                        Text(
                            text = actionLabel,
                            style = RagentTextStyles.caption.copy(
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = LocalRagentColors.current.accentPrimary,
                            ),
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                    }
                } else {
                    val pillBg = if (isReady) Ragentolors.Success.copy(alpha = 0.12f) else if (isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)
                    val pillColor = if (isReady) Ragentolors.Success else colors.secondaryContent
                    Surface(
                        shape = RoundedCornerShape(percent = 50),
                        color = pillBg,
                    ) {
                        Text(
                            text = statusText,
                            style = RagentTextStyles.caption.copy(
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = pillColor,
                            ),
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }
    }
}
