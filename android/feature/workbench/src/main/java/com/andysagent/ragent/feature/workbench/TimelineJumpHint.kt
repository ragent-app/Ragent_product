package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

internal enum class TailDistance { Near, Between, Far }
internal data class TimelineReplySignal(val key: String, val sequence: Long)

/** One session's ephemeral affordance, independent of unread data and follow-tail ownership. */
internal class TimelineJumpHint(private val scope: CoroutineScope, private val enterMillis: Int = 120) {
    var visible by mutableStateOf(false)
        private set
    var fastExit by mutableStateOf(false)
        private set
    var gestureRevision by mutableIntStateOf(0)
        private set
    private var expiry: Job? = null
    private var suppressed = true
    private var away = false
    private var moving = false
    private var returning = false
    private var userScrollPending = false
    private var replyBaseline: Long? = null
    private val observedReplies = mutableSetOf<String>()

    fun userScrolled() {
        if (suppressed) return
        returning = false
        if (!userScrollPending) {
            userScrollPending = true
            gestureRevision++
        }
        hide(fast = true)
    }

    fun viewport(distance: TailDistance, scrolling: Boolean, blocked: Boolean) {
        suppressed = blocked
        moving = scrolling
        away = when (distance) {
            TailDistance.Near -> false
            TailDistance.Far -> true
            TailDistance.Between -> away
        }
        when {
            blocked || returning -> dismiss()
            !away -> {
                hide()
                // A gesture starting at the bottom may still travel past the threshold.
                if (!scrolling) userScrollPending = false
            }
            scrolling -> hide(fast = true)
            userScrollPending -> {
                userScrollPending = false
                show()
            }
        }
    }

    fun reply(signal: TimelineReplySignal?, baselineOnly: Boolean) {
        if (signal == null) {
            if (replyBaseline == null) replyBaseline = 0L
            return
        }
        val previous = replyBaseline
        replyBaseline = maxOf(previous ?: Long.MIN_VALUE, signal.sequence)
        val firstForTurn = observedReplies.add(signal.key)
        // Initial/restored history and prepended older pages are not incoming replies.
        // A turn's streaming/durable aliases may advance seq, but only notify once.
        if (previous == null || baselineOnly || signal.sequence <= previous || !firstForTurn) return
        if (!suppressed && !returning && away && !moving && !visible) show()
    }

    fun startReturn() {
        dismiss()
        returning = true
    }

    fun endReturn() { returning = false }

    fun dismiss() {
        userScrollPending = false
        hide()
    }

    fun dispose() = dismiss()

    private fun show() {
        expiry?.cancel()
        fastExit = false
        visible = true
        expiry = scope.launch {
            delay(enterMillis.toLong() + 1_500L)
            visible = false
        }
    }

    private fun hide(fast: Boolean = false) {
        expiry?.cancel()
        expiry = null
        fastExit = fast
        visible = false
    }
}

private data class JumpViewport(
    val distance: TailDistance,
    val scrolling: Boolean,
    val blocked: Boolean,
    val gestureRevision: Int,
)

@Composable
internal fun rememberTimelineJumpHint(
    sessionKey: Any?,
    listState: LazyListState,
    contentItemCount: Int,
    suppressed: Boolean,
    reply: TimelineReplySignal?,
    baselineReplies: Boolean,
    enterMillis: Int,
): TimelineJumpHint {
    val scope = rememberCoroutineScope()
    val hint = remember(sessionKey) { TimelineJumpHint(scope, enterMillis) }
    val currentCount = rememberUpdatedState(contentItemCount)
    val currentSuppressed = rememberUpdatedState(suppressed)
    val density = LocalDensity.current
    val nearPx = with(density) { 24.dp.toPx() }
    val farPx = with(density) { 64.dp.toPx() }

    DisposableEffect(hint) { onDispose { hint.dispose() } }
    LaunchedEffect(hint, listState, nearPx, farPx) {
        snapshotFlow {
            val layout = listState.layoutInfo
            val lastIndex = currentCount.value - 1
            val tail = layout.visibleItemsInfo.firstOrNull { it.index == lastIndex }
            val remaining = when {
                lastIndex < 0 || layout.visibleItemsInfo.isEmpty() -> 0f
                tail != null -> timelineTailScrollDistance(
                    tail.offset, tail.size, layout.viewportEndOffset, layout.afterContentPadding,
                )
                layout.visibleItemsInfo.last().index < lastIndex -> Float.POSITIVE_INFINITY
                else -> 0f // Only the artificial turn-docking runway is below the content.
            }
            JumpViewport(
                distance = when {
                    remaining <= nearPx -> TailDistance.Near
                    remaining > farPx -> TailDistance.Far
                    else -> TailDistance.Between
                },
                scrolling = listState.isScrollInProgress,
                blocked = currentSuppressed.value,
                gestureRevision = hint.gestureRevision,
            )
        }.collectLatest { viewport ->
            // Settle drag -> fling transitions before publishing a stopped gesture.
            if (!viewport.scrolling && !viewport.blocked) withFrameNanos { }
            hint.viewport(viewport.distance, viewport.scrolling, viewport.blocked)
        }
    }
    LaunchedEffect(hint, reply, baselineReplies) {
        hint.reply(reply, baselineOnly = baselineReplies)
    }
    return hint
}
