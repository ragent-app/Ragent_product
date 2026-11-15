package com.andysagent.ragent

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.os.Bundle
import android.os.Environment
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.lifecycleScope
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentToolRow
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.AgentStreamingMessage
import com.andysagent.ragent.core.agentui.FloatingTopChrome
import com.andysagent.ragent.core.agentui.UserMessage
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.timeline.FileChangeItem
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.PixelCopy
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import java.io.File
import java.io.FileOutputStream

private const val TAG = "Phase3RActivity"
private const val TOTAL_FRAMES = 210
private const val PROMPT_TEXT = "organize invoices by month and create summary.md"
private const val LIVE_PROMPT_TEXT = "organize my invoices by month"
private const val COMPLETION_TEXT =
    "Organized 6 invoices into January, February, and March. Created summary.md with a total of $1,414.90."

class Phase3RActivity : ComponentActivity() {

    private val frameState = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { reportFullyDrawn() } catch (_: Throwable) {}

        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(
                lightScrim = AndroidColor.TRANSPARENT,
                darkScrim = AndroidColor.TRANSPARENT,
            ),
            navigationBarStyle = SystemBarStyle.auto(
                lightScrim = AndroidColor.TRANSPARENT,
                darkScrim = AndroidColor.TRANSPARENT,
            ),
        )

        val targetFrame = intent.getIntExtra("target_frame", 0)
        frameState.intValue = targetFrame.coerceIn(0, TOTAL_FRAMES - 1)

        if (intent.getBooleanExtra("live_mode", false)) {
            setContent {
                RagentTheme(darkTheme = false, themeVariant = AppTheme.Light.value) {
                    Phase3RLiveScreen()
                }
            }
            return
        }

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val f = intent?.getIntExtra("frame", -1) ?: -1
                if (f in 0 until TOTAL_FRAMES) {
                    frameState.intValue = f
                }
                val export = intent?.getBooleanExtra("export", false) ?: false
                if (export) {
                    startExportThread()
                }
            }
        }
        val filter = IntentFilter("com.andysagent.ragent.SET_FRAME")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            // Pre-T platforms have no receiver-export flag; lint still asks for
            // one because targetSdk 35 enables the check on every overload.
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }

        setContent {
            RagentTheme(darkTheme = false, themeVariant = AppTheme.Light.value) {
                Phase3RInteractiveScreen(frame = frameState.intValue)
            }
        }

        // Capture-QA hook: external drivers step frames via SET_FRAME broadcasts
        // and need the internal walker out of the way.
        if (!intent.getBooleanExtra("disable_export", false)) {
            startExportThread()
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val targetFrame = intent.getIntExtra("target_frame", -1)
        if (targetFrame in 0 until TOTAL_FRAMES) {
            frameState.intValue = targetFrame
        }
    }

    private val pixelCopyThread = HandlerThread("PixelCopyThread").apply { start() }
    private val pixelCopyHandler by lazy { Handler(pixelCopyThread.looper) }

    private fun startExportThread() {
        kotlin.concurrent.thread(start = true, isDaemon = false, name = "FrameExporterThread") {
            Thread.sleep(1200)
            try {
                val outDir = File(filesDir, "frames")
                if (!outDir.exists()) outDir.mkdirs()
                File(filesDir, "START.txt").writeText("STARTED\n")

                Log.e(TAG, "Starting frame export to ${outDir.absolutePath} (0..${TOTAL_FRAMES - 1})")

                val width = 1080
                val height = 2400
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

                for (f in 0 until TOTAL_FRAMES) {
                    runOnUiThread {
                        frameState.intValue = f
                    }
                    Thread.sleep(45)

                    var ok = false
                    var attempt = 0
                    // Cold-boot launches can reach here before the window gains
                    // its surface; retry instead of losing the whole walk.
                    while (!ok && attempt < 12) {
                        attempt += 1
                        val sync = java.util.concurrent.CountDownLatch(1)
                        try {
                            PixelCopy.request(
                                window,
                                bitmap,
                                { result ->
                                    ok = (result == PixelCopy.SUCCESS)
                                    sync.countDown()
                                },
                                pixelCopyHandler
                            )
                            sync.await(1000, java.util.concurrent.TimeUnit.MILLISECONDS)
                        } catch (_: IllegalStateException) {
                        } catch (_: IllegalArgumentException) {
                            // No backing surface yet; back off and retry.
                        }
                        if (!ok) Thread.sleep(250)
                    }

                    val file = File(outDir, String.format("frame_%03d.png", f))
                    FileOutputStream(file).use { out ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    }

                    if (f % 30 == 0 || f == TOTAL_FRAMES - 1) {
                        Log.e(TAG, "Exported frame $f / ${TOTAL_FRAMES - 1} (PixelCopy ok=$ok)")
                    }
                }

                File(filesDir, "DONE.txt").writeText("EXPORT_COMPLETE\n")
                Log.e(TAG, "=== ALL $TOTAL_FRAMES FRAMES EXPORTED SUCCESSFULLY ===")
            } catch (e: Throwable) {
                Log.e(TAG, "Export error: ${e.message}", e)
                try { File(filesDir, "ERROR.txt").writeText(e.stackTraceToString()) } catch (_: Throwable) {}
            }
        }
    }
}

@Composable
fun Phase3RInteractiveScreen(frame: Int = 0) {
    val spec = calculateFrameSpec(frame)

    Scaffold(
        topBar = {
            Phase3RTopBar(working = spec.workbenchUiState.runStatus == AgentRunStatus.Working)
        },
        bottomBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFFFFFF))
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                ) {
                    AgentComposer(
                        value = spec.composerText,
                        onValueChange = {},
                        onSend = {},
                        onStop = {},
                        working = spec.workbenchUiState.runStatus == AgentRunStatus.Working,
                        onAddAttachment = {},
                    )
                }

                if (spec.isKeyboardVisible) {
                    GboardSoftKeyboard(
                        activeChar = spec.activeChar,
                        sendPressed = spec.isSendPressed,
                        suggestions = listOf("invoices", "month", "summary"),
                    )
                } else {
                    Spacer(modifier = Modifier.navigationBarsPadding())
                }
            }
        },
        containerColor = Color(0xFFFFFFFF)
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(bottom = 16.dp)
        ) {
            if (spec.promptSubmitted) {
                item {
                    UserMessage(
                        text = PROMPT_TEXT
                    )
                }
            }

            items(spec.workbenchUiState.timelineItems.filterIsInstance<TimelineItem.Operation>()) { op ->
                OperationTimelineCard(op = op, fixtureFrame = frame)
            }

            val streamed = spec.workbenchUiState.timelineItems
                .filterIsInstance<TimelineItem.Message>()
                .find { it.role == TimelineRole.Agent }
                ?.text.orEmpty()

            if (streamed.isNotEmpty()) {
                item {
                    AgentStreamingMessage(
                        text = streamed,
                    )
                }
            }
        }
    }
}

/**
 * Frame-anchored reveal fractions for the fixture: each operation row streams
 * in over ROW_REVEAL_FRAMES exported frames (~1/3 s of video at 30fps), so the
 * token-level entrance is deterministic in the capture pipeline. Live mode and
 * production chat keep the autonomous wall-clock reveal.
 */
private const val READ_ROW_APPEAR_FRAME = 55
private const val GROUP_ROW_APPEAR_FRAME = 97
private const val WRITE_ROW_APPEAR_FRAME = 145
private const val ROW_REVEAL_FRAMES = 10

private fun rowRevealProgress(appearFrame: Int, frame: Int): Float =
    ((frame - appearFrame + 1f) / ROW_REVEAL_FRAMES).coerceIn(0f, 1f)

@Composable
fun OperationTimelineCard(op: TimelineItem.Operation, fixtureFrame: Int? = null) {
    // Row entrance shares AgentToolRow's token-stream reveal (glyph lands,
    // title types in left-to-right, meta trails) instead of a generic fade.
    AgentToolRow(
        title = op.title,
        glyph = when (op.kind) {
            TimelineOperationKind.Command -> AgentoWebGlyph.Terminal
            TimelineOperationKind.FileEdit -> AgentoWebGlyph.File
            else -> AgentoWebGlyph.Folder
        },
        meta = when (op.status) {
            TimelineOperationStatus.Completed -> "Completed"
            TimelineOperationStatus.InProgress -> "Working"
            else -> "Queued"
        },
        revealId = op.id,
        revealProgress = when (op.id) {
            "phase3r-read" -> fixtureFrame?.let { rowRevealProgress(READ_ROW_APPEAR_FRAME, it) }
            "phase3r-group" -> fixtureFrame?.let { rowRevealProgress(GROUP_ROW_APPEAR_FRAME, it) }
            "phase3r-write" -> fixtureFrame?.let { rowRevealProgress(WRITE_ROW_APPEAR_FRAME, it) }
            else -> null
        },
    )
}

/**
 * Quiet session top bar: circular white chrome on white, live blue dot only
 * while the agent is working. Run state lives in the rows and the composer,
 * not in a colored chip.
 */
@Composable
private fun Phase3RTopBar(working: Boolean) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .statusBarsPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                modifier = Modifier.size(48.dp),
                shape = CircleShape,
                color = Color.White,
                shadowElevation = 3.dp,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    AgentoWebIcon(AgentoWebGlyph.Back, "Back", Modifier.size(19.dp), Color(0xFF27272A))
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Organize invoices",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFF18181B),
                        maxLines = 1,
                    )
                    if (working) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(Color(0xFF3B82F6)))
                    }
                }
                Text("ragent-dev · Office PC", fontSize = 12.sp, color = Color(0xFF878D95), maxLines = 1)
            }
            Spacer(Modifier.width(8.dp))
            Surface(
                modifier = Modifier.size(48.dp),
                shape = CircleShape,
                color = Color.White,
                shadowElevation = 3.dp,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    AgentoWebIcon(AgentoWebGlyph.More, "Session actions", Modifier.size(18.dp), Color(0xFF27272A))
                }
            }
        }
    }
}

/**
 * Wall-clock run state for the LIVE capture mode.
 *
 * The phone side of the hero is captured from the real emulator UI: the real
 * system Gboard types into the real AgentComposer, and this state replays the
 * invoice-organizing run with the same pacing as the Codex CLI track on the
 * laptop surface (read → group → write → streaming summary).
 */
private class LiveRunState {
    var composer by mutableStateOf("")
    var promptSubmitted by mutableStateOf(false)
    var runStatus by mutableStateOf(AgentRunStatus.Idle)

    var readStatus by mutableStateOf(TimelineOperationStatus.Pending)
    var readElapsed by mutableLongStateOf(0L)
    var groupStatus by mutableStateOf(TimelineOperationStatus.Pending)
    var groupElapsed by mutableLongStateOf(0L)
    var writeStatus by mutableStateOf(TimelineOperationStatus.Pending)
    var writeElapsed by mutableLongStateOf(0L)
    var streamedLen by mutableIntStateOf(0)

    val streamedText: String
        get() = COMPLETION_TEXT.take(streamedLen)

    fun timelineItems(): List<TimelineItem> {
        if (!promptSubmitted) return emptyList()
        return buildList {
            add(
                TimelineItem.Message(
                    id = "phase3r-live-user",
                    seq = 1,
                    role = TimelineRole.User,
                    text = LIVE_PROMPT_TEXT,
                    completed = true,
                ),
            )
            if (readStatus != TimelineOperationStatus.Pending) {
                add(readOperation())
            }
            if (groupStatus != TimelineOperationStatus.Pending) {
                add(groupOperation())
            }
            if (writeStatus != TimelineOperationStatus.Pending) {
                add(writeOperation())
            }
            if (streamedLen > 0) {
                add(
                    TimelineItem.Message(
                        id = "phase3r-live-agent",
                        seq = 5,
                        role = TimelineRole.Agent,
                        text = streamedText,
                        completed = runStatus == AgentRunStatus.Completed,
                    ),
                )
            }
        }
    }

    private fun readOperation() = TimelineItem.Operation(
        id = "phase3r-live-read",
        seq = 2,
        kind = TimelineOperationKind.Command,
        title = "Read 6 invoice files",
        detail = "Inspecting /tmp/agc-welcome-demo/invoices/*.pdf",
        status = readStatus,
        toolName = "filesystem",
        durationMs = if (readStatus == TimelineOperationStatus.Completed) 412L else readElapsed,
    )

    private fun groupOperation() = TimelineItem.Operation(
        id = "phase3r-live-group",
        seq = 3,
        kind = TimelineOperationKind.Tool,
        title = "Group invoices by month",
        detail = "January · February · March",
        status = groupStatus,
        toolName = "organize",
        durationMs = if (groupStatus == TimelineOperationStatus.Completed) 638L else groupElapsed,
    )

    private fun writeOperation() = TimelineItem.Operation(
        id = "phase3r-live-write",
        seq = 4,
        kind = TimelineOperationKind.FileEdit,
        title = "Write summary.md",
        detail = "6 invoices · total $1,414.90",
        status = writeStatus,
        toolName = "write",
        fileChanges = listOf(FileChangeItem(path = "summary.md", type = "create", additions = 8)),
        durationMs = if (writeStatus == TimelineOperationStatus.Completed) 522L else writeElapsed,
    )
}

@Composable
private fun Phase3RLiveScreen(state: LiveRunState = remember { LiveRunState() }) {
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val listState = rememberLazyListState()
    val items = state.timelineItems()

    // Auto-scroll as the run produces timeline entries.
    LaunchedEffect(items.size, state.streamedLen) {
        if (items.isNotEmpty()) {
            listState.animateScrollToItem(items.lastIndex)
        }
    }

    fun startRun() {
        if (state.promptSubmitted || state.composer.isBlank()) return
        state.composer = ""
        state.promptSubmitted = true
        state.runStatus = AgentRunStatus.Working
        keyboard?.hide()
        scope.launch {
            delay(150)
            state.readStatus = TimelineOperationStatus.InProgress
            val readTicker = launch {
                while (state.readStatus == TimelineOperationStatus.InProgress) {
                    delay(33)
                    state.readElapsed += 33
                }
            }
            delay(430)
            state.readStatus = TimelineOperationStatus.Completed
            readTicker.cancel()

            delay(220)
            state.groupStatus = TimelineOperationStatus.InProgress
            val groupTicker = launch {
                while (state.groupStatus == TimelineOperationStatus.InProgress) {
                    delay(33)
                    state.groupElapsed += 33
                }
            }
            delay(660)
            state.groupStatus = TimelineOperationStatus.Completed
            groupTicker.cancel()

            delay(220)
            state.writeStatus = TimelineOperationStatus.InProgress
            val writeTicker = launch {
                while (state.writeStatus == TimelineOperationStatus.InProgress) {
                    delay(33)
                    state.writeElapsed += 33
                }
            }
            delay(540)
            state.writeStatus = TimelineOperationStatus.Completed
            writeTicker.cancel()

            // Stream the summary in word-sized chunks, like a real response.
            delay(260)
            val tokens = COMPLETION_TEXT.split(" ").filter { it.isNotBlank() }
            val buffer = StringBuilder()
            for (token in tokens) {
                buffer.append(if (buffer.isEmpty()) token else " $token")
                state.streamedLen = buffer.length
                delay(85)
            }
            state.streamedLen = COMPLETION_TEXT.length
            state.runStatus = AgentRunStatus.Completed
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.White),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(
                top = 84.dp,
                bottom = 132.dp,
            ),
        ) {
            if (state.promptSubmitted) {
                item {
                    UserMessage(
                        text = LIVE_PROMPT_TEXT,
                        modifier = Modifier.padding(bottom = 12.dp)
                    )
                }
            }

            items(items.filterIsInstance<TimelineItem.Operation>()) { op ->
                OperationTimelineCard(op = op)
            }

            if (state.streamedLen > 0) {
                item {
                    AgentStreamingMessage(text = state.streamedText, streaming = state.runStatus == AgentRunStatus.Working)
                }
            }
        }

        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .zIndex(2f),
        ) {
            Phase3RTopBar(working = state.runStatus == AgentRunStatus.Working)
        }

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color.White)
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .zIndex(3f),
        ) {
            AgentComposer(
                value = state.composer,
                onValueChange = { state.composer = it },
                onSend = { startRun() },
                onStop = {},
                working = state.runStatus == AgentRunStatus.Working,
                onAddAttachment = {},
            )
        }
    }
}

data class FrameSpec(
    val frame: Int,
    val composerText: String,
    val activeChar: Char?,
    val isSendPressed: Boolean,
    val isKeyboardVisible: Boolean,
    val promptSubmitted: Boolean,
    val workbenchUiState: WorkbenchUiState,
)

fun calculateFrameSpec(frame: Int): FrameSpec {
    val f = frame.coerceIn(0, TOTAL_FRAMES - 1)

    val isKeyboardVisible = (f < 55)
    val isSendPressed = (f in 49..54)
    val promptSubmitted = (f >= 55)

    val charCount = when {
        f < 48 -> ((f / 48.0) * PROMPT_TEXT.length).toInt().coerceIn(0, PROMPT_TEXT.length)
        f < 55 -> PROMPT_TEXT.length
        else -> 0
    }

    val composerText = if (promptSubmitted) "" else PROMPT_TEXT.substring(0, charCount)
    val activeChar = if (f < 48 && charCount > 0) PROMPT_TEXT[charCount - 1] else null

    val opPhase = when {
        f < 55 -> 0
        f < 97 -> 1  // Read in progress
        f < 145 -> 2 // Group in progress
        f < 175 -> 3 // Write in progress
        else -> 4    // Response streaming
    }

    val streamedText = when {
        f < 175 -> ""
        f < 208 -> {
            val progress = ((f - 175) / 33.0).coerceIn(0.0, 1.0)
            val charLen = (progress * COMPLETION_TEXT.length).toInt().coerceIn(1, COMPLETION_TEXT.length)
            COMPLETION_TEXT.substring(0, charLen)
        }
        else -> COMPLETION_TEXT
    }

    val readElapsed = if (opPhase == 1) (((f - 55) / 41.0) * 412L).toLong().coerceIn(10L, 412L) else 412L
    val read = TimelineItem.Operation(
        id = "phase3r-read",
        seq = 2,
        kind = TimelineOperationKind.Command,
        title = "Read 6 invoice files",
        detail = "Inspecting /tmp/agc-welcome-demo/invoices/*.pdf",
        status = if (opPhase < 2) TimelineOperationStatus.InProgress else TimelineOperationStatus.Completed,
        toolName = "filesystem",
        durationMs = readElapsed,
    )

    val groupElapsed = if (opPhase == 2) (((f - 97) / 47.0) * 638L).toLong().coerceIn(10L, 638L) else 638L
    val group = TimelineItem.Operation(
        id = "phase3r-group",
        seq = 3,
        kind = TimelineOperationKind.Tool,
        title = "Group invoices by month",
        detail = "January · February · March",
        status = when {
            opPhase < 2 -> TimelineOperationStatus.Pending
            opPhase == 2 -> TimelineOperationStatus.InProgress
            else -> TimelineOperationStatus.Completed
        },
        toolName = "organize",
        durationMs = groupElapsed,
    )

    val writeElapsed = if (opPhase == 3) (((f - 145) / 29.0) * 522L).toLong().coerceIn(10L, 522L) else 522L
    val write = TimelineItem.Operation(
        id = "phase3r-write",
        seq = 4,
        kind = TimelineOperationKind.FileEdit,
        title = "Write summary.md",
        detail = "6 invoices · total $1,414.90",
        status = when {
            opPhase < 3 -> TimelineOperationStatus.Pending
            opPhase == 3 -> TimelineOperationStatus.InProgress
            else -> TimelineOperationStatus.Completed
        },
        toolName = "write",
        fileChanges = listOf(
            FileChangeItem(
                path = "summary.md",
                type = "create",
                additions = 8,
            ),
        ),
        durationMs = writeElapsed,
    )

    val items = buildList {
        if (promptSubmitted) {
            add(
                TimelineItem.Message(
                    id = "phase3r-user",
                    seq = 1,
                    role = TimelineRole.User,
                    text = PROMPT_TEXT,
                    completed = true,
                ),
            )
            add(read)
        }
        if (promptSubmitted && opPhase >= 2) add(group)
        if (promptSubmitted && opPhase >= 3) add(write)
        if (promptSubmitted && opPhase >= 4 && streamedText.isNotEmpty()) {
            add(
                TimelineItem.Message(
                    id = "phase3r-agent",
                    seq = 5,
                    role = TimelineRole.Agent,
                    text = streamedText,
                    completed = streamedText == COMPLETION_TEXT,
                ),
            )
        }
    }

    val runStatus = when {
        !promptSubmitted -> AgentRunStatus.Idle
        f >= 208 -> AgentRunStatus.Completed
        else -> AgentRunStatus.Working
    }

    val state = WorkbenchUiState(
        destination = AgentoDestination.Sessions,
        chatOpen = true,
        connection = AgentConnectionStatus.Connected,
        runStatus = runStatus,
        sessionTitle = "Organize invoices",
        composerText = composerText,
        timelineItems = items,
        messageCount = items.size,
        sessionId = "phase3r-invoice-demo",
        runtimeTool = "codex",
        computers = listOf(
            Computer(
                id = "phase3r-host",
                name = "Office PC",
                platform = "Windows host",
                connected = true,
            ),
        ),
        appTheme = AppTheme.Light,
    )

    return FrameSpec(
        frame = f,
        composerText = composerText,
        activeChar = activeChar,
        isSendPressed = isSendPressed,
        isKeyboardVisible = isKeyboardVisible,
        promptSubmitted = promptSubmitted,
        workbenchUiState = state,
    )
}

/**
 * Authentic Android Material 3 Gboard Soft Keyboard Composable.
 * Implements genuine Material You MD3 Gboard specification:
 * - Top suggestion/action strip with Google 4-color G, Mic, Settings, Clipboard and predictive chips
 * - Authentic 8dp rounded keycaps with subtle elevation shadows and Roboto/Google Sans typography
 * - Floating Key Preview Bubble popups upon touch feedback
 * - Material You Send action pill button
 */
@Composable
fun GboardSoftKeyboard(
    activeChar: Char?,
    sendPressed: Boolean,
    suggestions: List<String>,
    modifier: Modifier = Modifier,
) {
    val bgColor = Color(0xFFECEEF2)
    val keyBg = Color(0xFFFFFFFF)
    val keyFunctionBg = Color(0xFFD8DBDF)
    val textColor = Color(0xFF1F1F1F)
    val subTextColor = Color(0xFF747775)
    val actionPillColor = if (sendPressed) Color(0xFF0842A0) else Color(0xFF0B57D0)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(bgColor)
            .navigationBarsPadding()
            .padding(bottom = 6.dp)
            .shadow(elevation = 12.dp)
    ) {
        // 1. Suggestion & Tool Strip (Height 44dp)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(44.dp)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                // 4-Color Google G Icon
                GoogleGIcon(modifier = Modifier.size(20.dp))

                // Microphone Icon
                MaterialMicIcon(modifier = Modifier.size(19.dp), tint = subTextColor)

                // Settings Gear
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Settings,
                    contentDescription = "Settings",
                    modifier = Modifier.size(18.dp),
                    tint = subTextColor
                )

                // Clipboard
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Copy,
                    contentDescription = "Clipboard",
                    modifier = Modifier.size(18.dp),
                    tint = subTextColor
                )
            }

            // Predictive Word Chips
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                suggestions.forEach { chip ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(16.dp))
                            .background(keyBg)
                            .border(1.dp, Color(0xFFDFE2E6), RoundedCornerShape(16.dp))
                            .padding(horizontal = 14.dp, vertical = 6.dp)
                    ) {
                        Text(
                            text = chip,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = textColor
                        )
                    }
                }
            }
        }

        // 2. QWERTY Key Rows
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 5.dp, vertical = 2.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp)
        ) {
            // Row 1: Q W E R T Y U I O P
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(5.dp)
            ) {
                val r1 = listOf(
                    "q" to "1", "w" to "2", "e" to "3", "r" to "4", "t" to "5",
                    "y" to "6", "u" to "7", "i" to "8", "o" to "9", "p" to "0"
                )
                r1.forEach { (char, num) ->
                    val isPressed = activeChar?.lowercaseChar() == char[0]
                    GboardKeyButton(
                        label = char,
                        subLabel = num,
                        isPressed = isPressed,
                        bgColor = keyBg,
                        textColor = textColor,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            // Row 2: A S D F G H J K L (Indented)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp)
            ) {
                val r2 = listOf("a", "s", "d", "f", "g", "h", "j", "k", "l")
                r2.forEach { char ->
                    val isPressed = activeChar?.lowercaseChar() == char[0]
                    GboardKeyButton(
                        label = char,
                        subLabel = null,
                        isPressed = isPressed,
                        bgColor = keyBg,
                        textColor = textColor,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            // Row 3: Shift · Z X C V B N M · Backspace
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Material Shift Key
                Box(
                    modifier = Modifier
                        .width(46.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(keyFunctionBg)
                        .shadow(elevation = 1.dp, shape = RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    MaterialShiftIcon(
                        modifier = Modifier.size(20.dp),
                        isCaps = false,
                        tint = textColor
                    )
                }

                val r3 = listOf("z", "x", "c", "v", "b", "n", "m")
                r3.forEach { char ->
                    val isPressed = activeChar?.lowercaseChar() == char[0]
                    GboardKeyButton(
                        label = char,
                        subLabel = null,
                        isPressed = isPressed,
                        bgColor = keyBg,
                        textColor = textColor,
                        modifier = Modifier.weight(1f)
                    )
                }

                // Material Backspace Key
                val isBackspacePressed = activeChar == '\b'
                Box(
                    modifier = Modifier
                        .width(46.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isBackspacePressed) Color(0xFFC7CDD4) else keyFunctionBg)
                        .shadow(elevation = 1.dp, shape = RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    MaterialBackspaceIcon(
                        modifier = Modifier.size(22.dp),
                        tint = textColor
                    )
                }
            }

            // Row 4: ?123 · , · Emoji · Spacebar · . · Send Action
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // ?123 Key
                Box(
                    modifier = Modifier
                        .width(50.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(keyFunctionBg)
                        .shadow(elevation = 1.dp, shape = RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "?123",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        color = textColor
                    )
                }

                // Comma Key
                GboardKeyButton(
                    label = ",",
                    subLabel = null,
                    isPressed = activeChar == ',',
                    bgColor = keyFunctionBg,
                    textColor = textColor,
                    modifier = Modifier.width(36.dp)
                )

                // Emoji Key
                Box(
                    modifier = Modifier
                        .width(36.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(keyFunctionBg)
                        .shadow(elevation = 1.dp, shape = RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    MaterialEmojiIcon(
                        modifier = Modifier.size(20.dp),
                        tint = textColor
                    )
                }

                // Spacebar
                val isSpacePressed = activeChar == ' '
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isSpacePressed) Color(0xFFC7CDD4) else keyBg)
                        .shadow(elevation = 1.dp, shape = RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "English",
                        fontSize = 13.sp,
                        color = subTextColor,
                        fontWeight = FontWeight.Normal
                    )
                }

                // Period Key
                GboardKeyButton(
                    label = ".",
                    subLabel = null,
                    isPressed = activeChar == '.',
                    bgColor = keyFunctionBg,
                    textColor = textColor,
                    modifier = Modifier.width(36.dp)
                )

                // Send Action Key (Google Blue Pill)
                Box(
                    modifier = Modifier
                        .width(56.dp)
                        .height(46.dp)
                        .scale(if (sendPressed) 0.90f else 1.0f)
                        .clip(RoundedCornerShape(23.dp))
                        .background(actionPillColor)
                        .shadow(elevation = if (sendPressed) 0.dp else 2.dp, shape = RoundedCornerShape(23.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Send,
                        contentDescription = "Send",
                        modifier = Modifier.size(20.dp),
                        tint = Color.White
                    )
                }
            }
        }
    }
}

@Composable
private fun GboardKeyButton(
    label: String,
    subLabel: String?,
    isPressed: Boolean,
    bgColor: Color,
    textColor: Color,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.height(46.dp),
        contentAlignment = Alignment.Center
    ) {
        // Keycap Surface
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(8.dp))
                .background(if (isPressed) Color(0xFFC7CDD4) else bgColor)
                .shadow(elevation = if (isPressed) 0.dp else 1.dp, shape = RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center
        ) {
            if (subLabel != null) {
                Text(
                    text = subLabel,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Normal,
                    color = Color(0xFF747775),
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 2.5.dp, end = 3.5.dp)
                )
            }
            Text(
                text = label,
                fontSize = 19.5.sp,
                fontWeight = FontWeight.Medium,
                color = textColor,
                textAlign = TextAlign.Center
            )
        }

        // Floating Key Preview Popup Bubble (when active character is typed)
        if (isPressed) {
            Box(
                modifier = Modifier
                    .offset(y = (-52).dp)
                    .size(width = 50.dp, height = 54.dp)
                    .zIndex(15f)
                    .shadow(elevation = 6.dp, shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomStart = 6.dp, bottomEnd = 6.dp))
                    .clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomStart = 6.dp, bottomEnd = 6.dp))
                    .background(Color.White)
                    .border(1.dp, Color(0xFFE0E2E6), RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomStart = 6.dp, bottomEnd = 6.dp)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = label,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF1F1F1F)
                )
            }
        }
    }
}

/**
 * 4-Color Google G Logo Canvas Vector.
 */
@Composable
fun GoogleGIcon(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cx = w / 2f
        val cy = h / 2f
        val r = minOf(w, h) / 2f
        val stroke = r * 0.40f
        val insetR = r - stroke / 2f
        val rect = androidx.compose.ui.geometry.Rect(cx - insetR, cy - insetR, cx + insetR, cy + insetR)

        // Red (top-left)
        drawArc(
            color = Color(0xFFEA4335),
            startAngle = 180f,
            sweepAngle = 105f,
            useCenter = false,
            topLeft = rect.topLeft,
            size = rect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Butt)
        )
        // Yellow (bottom-left)
        drawArc(
            color = Color(0xFFFBBC05),
            startAngle = 105f,
            sweepAngle = 75f,
            useCenter = false,
            topLeft = rect.topLeft,
            size = rect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Butt)
        )
        // Green (bottom-right)
        drawArc(
            color = Color(0xFF34A853),
            startAngle = 0f,
            sweepAngle = 105f,
            useCenter = false,
            topLeft = rect.topLeft,
            size = rect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Butt)
        )
        // Blue (right)
        drawArc(
            color = Color(0xFF4285F4),
            startAngle = 285f,
            sweepAngle = 75f,
            useCenter = false,
            topLeft = rect.topLeft,
            size = rect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Butt)
        )
        // Center horizontal bar for G
        drawLine(
            color = Color(0xFF4285F4),
            start = androidx.compose.ui.geometry.Offset(cx - 1f, cy),
            end = androidx.compose.ui.geometry.Offset(cx + r, cy),
            strokeWidth = stroke,
            cap = androidx.compose.ui.graphics.StrokeCap.Butt
        )
    }
}

/**
 * Material Microphone Vector.
 */
@Composable
fun MaterialMicIcon(modifier: Modifier = Modifier, tint: Color = Color(0xFF747775)) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cx = w / 2f

        // Body
        val bodyW = w * 0.38f
        val bodyH = h * 0.50f
        drawRoundRect(
            color = tint,
            topLeft = androidx.compose.ui.geometry.Offset(cx - bodyW / 2f, h * 0.08f),
            size = androidx.compose.ui.geometry.Size(bodyW, bodyH),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(bodyW / 2f, bodyW / 2f)
        )
        // Cradle arc
        val cradleR = w * 0.32f
        val cradleRect = androidx.compose.ui.geometry.Rect(cx - cradleR, h * 0.22f, cx + cradleR, h * 0.66f)
        drawArc(
            color = tint,
            startAngle = 0f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = cradleRect.topLeft,
            size = cradleRect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = w * 0.09f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        )
        // Stem
        drawLine(
            color = tint,
            start = androidx.compose.ui.geometry.Offset(cx, h * 0.66f),
            end = androidx.compose.ui.geometry.Offset(cx, h * 0.84f),
            strokeWidth = w * 0.09f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round
        )
        // Base
        drawLine(
            color = tint,
            start = androidx.compose.ui.geometry.Offset(cx - w * 0.20f, h * 0.84f),
            end = androidx.compose.ui.geometry.Offset(cx + w * 0.20f, h * 0.84f),
            strokeWidth = w * 0.09f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round
        )
    }
}

/**
 * Material Shift Hollow Outline Vector.
 */
@Composable
fun MaterialShiftIcon(modifier: Modifier = Modifier, isCaps: Boolean = false, tint: Color = Color(0xFF1F1F1F)) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.5f, h * 0.16f)
            lineTo(w * 0.84f, h * 0.52f)
            lineTo(w * 0.66f, h * 0.52f)
            lineTo(w * 0.66f, h * 0.84f)
            lineTo(w * 0.34f, h * 0.84f)
            lineTo(w * 0.34f, h * 0.52f)
            lineTo(w * 0.16f, h * 0.52f)
            close()
        }
        if (isCaps) {
            drawPath(path, color = tint, style = androidx.compose.ui.graphics.drawscope.Fill)
        } else {
            drawPath(
                path,
                color = tint,
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = w * 0.09f,
                    join = androidx.compose.ui.graphics.StrokeJoin.Round,
                    cap = androidx.compose.ui.graphics.StrokeCap.Round
                )
            )
        }
    }
}

/**
 * Material Backspace Vector.
 */
@Composable
fun MaterialBackspaceIcon(modifier: Modifier = Modifier, tint: Color = Color(0xFF1F1F1F)) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.30f, h * 0.20f)
            lineTo(w * 0.85f, h * 0.20f)
            quadraticBezierTo(w * 0.92f, h * 0.20f, w * 0.92f, h * 0.28f)
            lineTo(w * 0.92f, h * 0.72f)
            quadraticBezierTo(w * 0.92f, h * 0.80f, w * 0.85f, h * 0.80f)
            lineTo(w * 0.30f, h * 0.80f)
            lineTo(w * 0.08f, h * 0.50f)
            close()
        }
        drawPath(
            path,
            color = tint,
            style = androidx.compose.ui.graphics.drawscope.Stroke(
                width = w * 0.08f,
                join = androidx.compose.ui.graphics.StrokeJoin.Round
            )
        )
        // Center 'X'
        val xMin = w * 0.44f
        val xMax = w * 0.74f
        val yMin = h * 0.36f
        val yMax = h * 0.64f
        drawLine(
            color = tint,
            start = androidx.compose.ui.geometry.Offset(xMin, yMin),
            end = androidx.compose.ui.geometry.Offset(xMax, yMax),
            strokeWidth = w * 0.08f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round
        )
        drawLine(
            color = tint,
            start = androidx.compose.ui.geometry.Offset(xMax, yMin),
            end = androidx.compose.ui.geometry.Offset(xMin, yMax),
            strokeWidth = w * 0.08f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round
        )
    }
}

/**
 * Material Emoji Vector.
 */
@Composable
fun MaterialEmojiIcon(modifier: Modifier = Modifier, tint: Color = Color(0xFF1F1F1F)) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cx = w / 2f
        val cy = h / 2f
        val r = minOf(w, h) * 0.42f
        // Outer face circle
        drawCircle(
            color = tint,
            radius = r,
            center = androidx.compose.ui.geometry.Offset(cx, cy),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = w * 0.08f)
        )
        // Left eye
        drawCircle(
            color = tint,
            radius = r * 0.15f,
            center = androidx.compose.ui.geometry.Offset(cx - r * 0.38f, cy - r * 0.22f)
        )
        // Right eye
        drawCircle(
            color = tint,
            radius = r * 0.15f,
            center = androidx.compose.ui.geometry.Offset(cx + r * 0.38f, cy - r * 0.22f)
        )
        // Smile curve
        val smileRect = androidx.compose.ui.geometry.Rect(cx - r * 0.52f, cy - r * 0.45f, cx + r * 0.52f, cy + r * 0.55f)
        drawArc(
            color = tint,
            startAngle = 25f,
            sweepAngle = 130f,
            useCenter = false,
            topLeft = smileRect.topLeft,
            size = smileRect.size,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = w * 0.08f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        )
    }
}
