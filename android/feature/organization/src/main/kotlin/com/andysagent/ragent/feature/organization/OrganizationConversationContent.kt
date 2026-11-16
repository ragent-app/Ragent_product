package com.andysagent.ragent.feature.organization

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.andysagent.ragent.core.agentui.*
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.SwitchingRagentTransport
import com.andysagent.ragent.core.protocol.*
import com.andysagent.ragent.core.timeline.*
import com.andysagent.ragent.core.sync.ProjectedMessage
import com.andysagent.ragent.core.sync.isTimelineMessage
import com.andysagent.ragent.core.sync.messageProjectionId
import com.andysagent.ragent.core.sync.reduceMessage
import com.andysagent.ragent.core.sync.terminalRunState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Serializable private data class ConversationBinding(val sessionId: String? = null, val generation: Long)
@Serializable private data class ConversationDescriptor(val organizationId: String, val nodeId: String, val currentBinding: ConversationBinding, val runtimeState: String = "unknown")
private class ConversationDenied : Exception()
private class BindingChanged : Exception()
private class ConversationReset : Exception()

/** Ephemeral, owner-authorized reader. It never mutates the shared chat repository. */
private class ConversationReader(private val transport: RagentTransport, private val org: String, private val node: String) {
    private val mutex = Mutex()
    private var binding: ConversationBinding? = null
    private var events = emptyList<SessionEventDto>()
    private var live = LiveTimelineProjector()
    private var latest = 0L
    private var before: Long? = null
    private var more = false
    private var liveCursor = 0L
    private var liveStream: String? = null
    private var historyRevision: Long? = null
    private var epoch = 0L
    var browsingHistory by mutableStateOf(false); private set
    var unseen by mutableStateOf(false); private set
    var items by mutableStateOf<List<TimelineItem>>(emptyList()); private set
    var hasOlder by mutableStateOf(false); private set
    var loadingOlder by mutableStateOf(false); private set
    var status by mutableStateOf(ConversationStatus.Loading); private set
    var runtimeState by mutableStateOf("unknown"); private set
    private fun enc(value: String) = Uri.encode(value)
    private suspend fun get(path: String): String {
        val response = transport.execute(ApiRequest("GET", path))
        if (response.statusCode == 401 || response.statusCode == 403 || response.statusCode == 404) throw ConversationDenied()
        if (response.statusCode == 409) throw BindingChanged()
        if (!response.isSuccessful) error("Read failed")
        return response.body
    }
    private suspend fun descriptor(): ConversationBinding {
        val d = RagentProtocol.json.decodeFromString<ConversationDescriptor>(get("/api/organizations/${enc(org)}/nodes/${enc(node)}/conversation"))
        if (d.organizationId != org || d.nodeId != node || d.currentBinding.generation < 0) throw ConversationDenied()
        runtimeState = d.runtimeState
        return d.currentBinding
    }
    private suspend fun check(expected: ConversationBinding) {
        if (descriptor() != expected) throw BindingChanged()
    }
    fun clear() { epoch++; binding = null; events = emptyList(); live = LiveTimelineProjector(); items = emptyList(); runtimeState = "unknown"; latest = 0; before = null; more = false; hasOlder = false; liveCursor = 0; liveStream = null; historyRevision = null; browsingHistory = false; unseen = false }
    private fun reconcileLive() {
        val messages = linkedMapOf<String, ProjectedMessage>()
        events.filter { it.isTimelineMessage() }.forEach { event ->
            val id = event.messageProjectionId()
            messages[id] = reduceMessage(messages[id], event, event.boundarySeq())
        }
        live.reconcileDurableCursor(
            latest,
            messages.mapValues { it.value.text },
            messages.filterValues { it.state != "streaming" }.keys,
            events.filter { it.terminalRunState() != null }.mapNotNull { it.runId }.toSet(),
        )
    }
    private fun render() {
        val durable = LiveTimelineProjector().projectPage(events)
        val base = TimelineProjector.project(emptyList(), durable)
        items = if (browsingHistory) base else mergeTimelineItems(base, TimelineProjector.project(emptyList(), live.snapshotEvents()))
    }
    private fun page(body: String, sid: String): SessionEventsPageDto {
        val page = RagentProtocol.json.decodeFromString<SessionEventsPageDto>(body)
        if (page.sessionId != sid || page.resetRequired) throw ConversationReset()
        return page
    }
    private fun ordered(input: List<SessionEventDto>) = input.filter { it.boundarySeq() > 0 }.distinctBy { it.dedupeKey() ?: it.sessionEventFingerprint() }.sortedBy { it.boundarySeq() }
    private suspend fun latestPage(expected: ConversationBinding, preserve: Boolean) {
        val sid = expected.sessionId ?: return
        check(expected)
        val body = get("/api/sessions/${enc(sid)}/snapshot?limit=50")
        val consistency = RagentProtocol.json.parseToJsonElement(body).jsonObject["consistency"]?.jsonObject ?: throw ConversationReset()
        if (consistency["stable"]?.jsonPrimitive?.booleanOrNull != true) throw ConversationReset()
        val revision = consistency["revision"]?.jsonPrimitive?.longOrNull ?: throw ConversationReset()
        if (historyRevision != null && revision < historyRevision!!) throw ConversationReset()
        val p = page(body, sid)
        check(expected)
        historyRevision = revision
        val fresh = ordered(p.events)
        val newLatest = p.latestSeq ?: fresh.maxOfOrNull { it.boundarySeq() } ?: 0L
        if (preserve && newLatest < latest) throw ConversationReset()
        // Reconnection must catch up from its prior durable cursor. A newest
        // snapshot alone can skip more than 50 events accumulated offline.
        if (preserve && events.isNotEmpty() && newLatest > latest) return
        val first = fresh.minOfOrNull { it.startingSeq() }
        val old = if (preserve) events.filter { first == null || it.boundarySeq() < first } else emptyList()
        events = ordered(old + fresh).takeLast(1000)
        if (!preserve || old.isEmpty()) {
            before = p.pagination?.nextBeforeSeq ?: p.pagination?.oldestSeq
            more = p.pagination?.hasMoreBefore == true && before != null
        }
        hasOlder = more
        latest = newLatest
        reconcileLive()
        render()
    }
    suspend fun open() = mutex.withLock {
        val next = descriptor()
        val observedRuntime = runtimeState
        if (binding != next) clear()
        runtimeState = observedRuntime
        binding = next
        if (next.sessionId == null) { status = ConversationStatus.Unbound; return@withLock }
        latestPage(next, preserve = events.isNotEmpty())
        status = ConversationStatus.Ready
    }
    suspend fun older() = mutex.withLock {
        val expected = binding ?: return@withLock
        val sid = expected.sessionId ?: return@withLock
        val cursor = before ?: return@withLock
        if (!more || loadingOlder) return@withLock
        loadingOlder = true
        try {
            check(expected)
            val p = page(get("/api/sessions/${enc(sid)}/events?filter=visible&limit=50&direction=before&beforeSeq=$cursor"), sid)
            check(expected)
            val combined = ordered(events + p.events)
            if (combined.size > 1000) { browsingHistory = true; unseen = true }
            events = combined.take(1000)
            before = p.pagination?.nextBeforeSeq ?: p.pagination?.oldestSeq
            more = p.pagination?.hasMoreBefore == true && before != null && before!! < cursor
            hasOlder = more
            render()
        } finally { loadingOlder = false }
    }
    suspend fun newest() = mutex.withLock {
        val expected = binding ?: return@withLock
        epoch++
        live = LiveTimelineProjector()
        latestPage(expected, preserve = false)
        browsingHistory = false
        render()
        unseen = false
    }
    suspend fun waitForUpdates() {
        val expected = binding ?: run { delay(3000); return }
        val sid = expected.sessionId ?: run { delay(3000); check(expected); return }
        check(expected)
        val requestEpoch = epoch
        val stream = liveStream?.let { "&liveStreamId=${enc(it)}" }.orEmpty()
        val p = page(get("/api/sessions/${enc(sid)}/events/wait?filter=all&limit=200&direction=forward&compact=1&afterSeq=$latest&timeoutMs=15000&includeLive=1&liveAfterCursor=$liveCursor$stream"), sid)
        check(expected)
        mutex.withLock {
            if (epoch != requestEpoch) return@withLock
            if (binding != expected) throw BindingChanged()
            if (p.liveResetRequired || (liveStream != null && p.liveStreamId != null && liveStream != p.liveStreamId)) throw ConversationReset()
            if (p.liveEvents.isNotEmpty()) {
                val result = live.apply(p.liveEvents)
                if (result.invalidEvent != null || result.gapExpectedSeq != null) throw ConversationReset()
            }
            p.liveStreamId?.let { liveStream = it }
            p.liveCursor?.let { liveCursor = it }
            // Consume every durable page before advancing its cursor; the server may
            // have more than the visible snapshot window after a busy interval.
            val incoming = ordered(p.events)
            var cursor = latest
            for (event in incoming) {
                if (event.boundarySeq() <= cursor) continue
                if (event.startingSeq() > cursor + 1) throw ConversationReset()
                cursor = event.boundarySeq()
            }
            if (cursor > latest) {
                if (browsingHistory) {
                    unseen = true
                } else {
                    val combined = ordered(events + incoming)
                    events = combined.takeLast(1000)
                    if (combined.size > events.size) {
                        before = events.firstOrNull()?.startingSeq()
                        more = before != null && before!! > 1
                        hasOlder = more
                    }
                }
                latest = cursor
                reconcileLive()
            }
            render()
        }
    }
    fun transportChanged() { epoch++; offline() }
    fun offline() { if (status == ConversationStatus.Ready || items.isNotEmpty()) status = ConversationStatus.Offline else status = ConversationStatus.Loading }
    fun denied() { clear(); status = ConversationStatus.Denied }
    fun reset() { clear(); status = ConversationStatus.Loading }
    fun error() { status = ConversationStatus.Error }
}
private enum class ConversationStatus { Loading, Ready, Offline, Denied, Unbound, Error }

@Composable
fun OrganizationConversationContent(transport: RagentTransport, organizationId: String, nodeId: String, targetId: String?, identityScope: String, modifier: Modifier = Modifier, onRuntimeState: (String?) -> Unit = {}) {
    val delegate = (transport as? SwitchingRagentTransport)?.delegate?.collectAsState()?.value
    val reader = remember(transport, targetId, identityScope, organizationId, nodeId) { ConversationReader(transport, organizationId, nodeId) }
    val connection by transport.connectionState.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val currentCallback by rememberUpdatedState(onRuntimeState)
    LaunchedEffect(reader, reader.runtimeState, reader.status) {
        currentCallback(reader.runtimeState.takeIf { reader.status == ConversationStatus.Ready && it != "unknown" })
    }
    DisposableEffect(reader) { onDispose { currentCallback(null) } }
    val list = rememberLazyListState()
    var newContent by remember(reader) { mutableStateOf(false) }
    var previousTail by remember(reader) { mutableStateOf<String?>(null) }
    var restart by remember(reader) { mutableIntStateOf(0) }
    LaunchedEffect(reader, lifecycle, connection, restart, delegate) {
        reader.transportChanged()
        if (connection == RuntimeConnectionState.AuthenticationRequired) { reader.denied(); return@LaunchedEffect }
        if (connection != RuntimeConnectionState.Connected) { reader.offline(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try { reader.open(); while (true) reader.waitForUpdates() }
                catch (e: CancellationException) { throw e }
                catch (_: ConversationDenied) { reader.denied(); break }
                catch (_: BindingChanged) { reader.reset(); delay(250) }
                catch (_: ConversationReset) { reader.reset(); delay(250) }
                catch (_: Exception) { reader.offline(); delay(2000) }
            }
        }
    }
    val tail = reader.items.lastOrNull()?.let { "${it.id}:${it.hashCode()}" }
    LaunchedEffect(reader, tail) {
        if (tail != null && tail != previousTail) {
            val atBottom = list.layoutInfo.totalItemsCount == 0 || list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == list.layoutInfo.totalItemsCount - 1
            if (!reader.browsingHistory && (previousTail == null || atBottom)) {
                val expectedCount = reader.items.size + if (reader.hasOlder) 1 else 0
                if (expectedCount > 0) {
                    withFrameNanos { }
                    snapshotFlow { list.layoutInfo.totalItemsCount }.first { it >= expectedCount }
                    list.scrollToItem(expectedCount - 1)
                }
                newContent = false
            } else if (!reader.browsingHistory) newContent = true
            previousTail = tail
        }
    }
    Column(modifier.fillMaxWidth()) {
        when (reader.status) {
            ConversationStatus.Loading -> ConversationLabel(R.string.org_conversation_loading)
            ConversationStatus.Unbound -> ConversationLabel(R.string.org_conversation_unbound)
            ConversationStatus.Denied -> ConversationLabel(R.string.org_conversation_denied)
            ConversationStatus.Offline -> ConversationLabel(R.string.org_conversation_offline)
            ConversationStatus.Error -> ConversationLabel(R.string.org_conversation_error)
            ConversationStatus.Ready -> if (reader.items.isEmpty()) ConversationLabel(R.string.org_conversation_empty)
        }
        if (newContent || reader.unseen) TextButton(onClick = { scope.launch { try { if (reader.browsingHistory) reader.newest(); val count = reader.items.size + if (reader.hasOlder) 1 else 0; if (count > 0) { withFrameNanos { }; snapshotFlow { list.layoutInfo.totalItemsCount }.first { it >= count }; list.scrollToItem(count - 1) }; newContent = false } catch (_: ConversationDenied) { reader.denied(); restart++ } catch (e: CancellationException) { throw e } catch (_: Exception) { reader.reset(); restart++ } } }) { Text(androidx.compose.ui.res.stringResource(if (reader.browsingHistory) R.string.org_conversation_latest else R.string.org_conversation_new)) }
        LazyColumn(state = list, modifier = Modifier.fillMaxWidth().weight(1f, fill = false), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (reader.hasOlder) item(key = "older") { TextButton(enabled = !reader.loadingOlder, onClick = { scope.launch { try { reader.older() } catch (_: ConversationDenied) { reader.denied(); restart++ } catch (_: BindingChanged) { reader.reset(); restart++ } catch (_: ConversationReset) { reader.reset(); restart++ } catch (e: CancellationException) { throw e } catch (_: Exception) { reader.offline() } } }) { Text(androidx.compose.ui.res.stringResource(R.string.org_conversation_older)) } }
            items(reader.items, key = { it.id }) { ConversationItem(it) }
        }
    }
}
@Composable private fun ConversationLabel(id: Int) { Text(androidx.compose.ui.res.stringResource(id), modifier = Modifier.fillMaxWidth().padding(20.dp), textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium) }
@Composable private fun ConversationItem(item: TimelineItem) {
    val colors = LocalRagentColors.current
    when (item) {
        is TimelineItem.Message -> if (item.text.isNotBlank()) {
            if (item.role == TimelineRole.User) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Text(item.text, modifier = Modifier.fillMaxWidth(.82f).background(colors.quietSurface, RoundedCornerShape(18.dp)).padding(horizontal = 12.dp, vertical = 10.dp), color = colors.primaryContent, fontSize = 15.sp, lineHeight = 24.sp)
                }
            } else if (item.role == TimelineRole.System) Text(item.text, color = colors.secondaryContent, fontSize = 15.sp, lineHeight = 24.sp)
            else AgentMarkdown(markdown = item.text, isStreaming = !item.completed)
        }
        is TimelineItem.Notice -> if (item.text.isNotBlank()) Text(item.text, fontSize = 15.sp, lineHeight = 24.sp)
        is TimelineItem.Plan -> Column { if (item.title.isNotBlank()) Text(item.title, fontSize = 15.sp, lineHeight = 24.sp); if (item.bodyMarkdown.isNotBlank()) AgentMarkdown(item.bodyMarkdown); item.items.forEach { Text(it.text, fontSize = 15.sp, lineHeight = 24.sp) } }
        is TimelineItem.Operation -> {
            val input = androidx.compose.ui.res.stringResource(R.string.org_conversation_input)
            val output = androidx.compose.ui.res.stringResource(R.string.org_conversation_output)
            val exit = androidx.compose.ui.res.stringResource(R.string.org_conversation_exit)
            val detail = buildList {
                if (item.detail.isNotBlank()) add(item.detail)
                item.inputJson?.let(::readableToolValue)?.takeIf { it.isNotBlank() && it != item.detail }?.let { add("$input\n$it") }
                item.outputJson?.let(::readableToolValue)?.takeIf { it.isNotBlank() && it != item.detail }?.let { add("$output\n$it") }
                item.exitCode?.let { add("$exit: $it") }
            }.joinToString("\n\n")
            ToolCallCard(ToolCallUiState(item.id, AgentOperationKind.valueOf(item.kind.name), item.title, detail, AgentOperationStatus.valueOf(item.status.name), false))
        }
    }
}

/** Extract values for reading without presenting a raw protocol object. */
private fun readableToolValue(raw: String): String {
    fun value(element: JsonElement): String = when (element) {
        is JsonPrimitive -> element.contentOrNull.orEmpty()
        is JsonArray -> element.joinToString("\n") { value(it) }
        is JsonObject -> element.entries.joinToString("\n") { (key, item) ->
            val text = value(item)
            if (text.isBlank()) "" else "$key: $text"
        }
        else -> ""
    }
    return runCatching { value(RagentProtocol.json.parseToJsonElement(raw)) }.getOrElse { raw }
}
