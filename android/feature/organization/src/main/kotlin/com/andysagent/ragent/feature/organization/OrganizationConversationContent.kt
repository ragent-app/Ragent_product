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
import com.andysagent.ragent.core.network.ApiException
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
@Serializable private data class MemberConversationPage(
    val scope: String = "unavailable", val generation: Long? = null, val revision: Long? = null,
    val entries: List<SessionEventDto> = emptyList(), val nextBeforeSeq: Long? = null,
    val nextAfterSeq: Long? = null, val hasMoreBefore: Boolean = false, val hasMoreAfter: Boolean = false,
    val reset: Boolean = false, val gap: Boolean? = null, val coverage: String? = null,
    val activity: com.andysagent.ragent.feature.organization.data.NodeActivityDto? = null,
)
private class ConversationDenied(val authorizationDenied: Boolean = false) : Exception()
private class BindingChanged : Exception()
private class ConversationReset : Exception()

/** The reader owns validation and rendering; sources only supply authorized routes. */
private interface ConversationSource {
    fun descriptorPath(): String
    fun snapshotPath(sessionId: String): String
    fun olderPath(sessionId: String, before: Long): String
    fun updatesPath(sessionId: String, after: Long, liveCursor: Long, liveStream: String?): String
}

private class OrganizationConversationSource(private val organizationId: String, private val nodeId: String) : ConversationSource {
    private fun enc(value: String) = Uri.encode(value)
    override fun descriptorPath() = "/api/organizations/${enc(organizationId)}/nodes/${enc(nodeId)}/conversation"
    override fun snapshotPath(sessionId: String) = "/api/sessions/${enc(sessionId)}/snapshot?limit=50"
    override fun olderPath(sessionId: String, before: Long) = "/api/sessions/${enc(sessionId)}/events?filter=visible&limit=50&direction=before&beforeSeq=$before"
    override fun updatesPath(sessionId: String, after: Long, liveCursor: Long, liveStream: String?): String {
        val stream = liveStream?.let { "&liveStreamId=${enc(it)}" }.orEmpty()
        return "/api/sessions/${enc(sessionId)}/events/wait?filter=all&limit=200&direction=forward&compact=1&afterSeq=$after&timeoutMs=15000&includeLive=1&liveAfterCursor=$liveCursor$stream"
    }
}

/** Ephemeral, owner-authorized reader. It never mutates the shared chat repository. */
private class MemberConversationSource(rootSessionId: String, memberRef: String) : ConversationSource {
    private val path = "/api/sessions/${Uri.encode(rootSessionId)}/organization/members/${Uri.encode(memberRef)}/conversation"
    override fun descriptorPath() = "$path?limit=50"
    override fun snapshotPath(sessionId: String) = "$path?limit=50"
    override fun olderPath(sessionId: String, before: Long) = "$path?beforeSeq=$before&limit=50"
    override fun updatesPath(sessionId: String, after: Long, liveCursor: Long, liveStream: String?) = "$path?afterSeq=$after&limit=200"
}

private class ConversationReader(private val transport: RagentTransport, private val org: String, private val node: String,
    rootSessionId: String? = null, private val memberRef: String? = null) {
    private val source: ConversationSource = if (rootSessionId != null && memberRef != null)
        MemberConversationSource(rootSessionId, memberRef) else OrganizationConversationSource(org, node)
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
    var memberScope by mutableStateOf<String?>(null); private set
    var memberGap by mutableStateOf<Boolean?>(null); private set
    var memberCoverage by mutableStateOf<String?>(null); private set
    var memberActivity by mutableStateOf<String?>(null); private set
    private suspend fun get(path: String): String {
        val response = try {
            transport.execute(ApiRequest("GET", path))
        } catch (e: ApiException) {
            if (e.statusCode == 401 || e.statusCode == 403) throw ConversationDenied(authorizationDenied = true)
            if (e.statusCode == 404) throw ConversationDenied()
            if (e.statusCode == 409) throw BindingChanged()
            throw e
        }
        if (response.statusCode == 401 || response.statusCode == 403) throw ConversationDenied(authorizationDenied = true)
        if (response.statusCode == 404) throw ConversationDenied()
        if (response.statusCode == 409) throw BindingChanged()
        if (!response.isSuccessful) error("Read failed")
        return response.body
    }
    private suspend fun descriptor(): ConversationBinding {
        if (memberRef != null) {
            val page = memberPage(get(source.descriptorPath()))
            memberScope = page.scope
            memberActivity = page.activity?.state
            return ConversationBinding(if (page.scope == "unavailable") null else memberRef, page.generation ?: throw ConversationReset())
        }
        val d = RagentProtocol.json.decodeFromString<ConversationDescriptor>(get(source.descriptorPath()))
        if (d.organizationId != org || d.nodeId != node || d.currentBinding.generation < 0) throw ConversationDenied()
        runtimeState = d.runtimeState
        return d.currentBinding
    }
    private suspend fun check(expected: ConversationBinding) {
        if (descriptor() != expected) throw BindingChanged()
    }
    fun clear() { epoch++; binding = null; events = emptyList(); live = LiveTimelineProjector(); items = emptyList(); runtimeState = "unknown"; memberScope = null; memberGap = null; memberCoverage = null; memberActivity = null; latest = 0; before = null; more = false; hasOlder = false; liveCursor = 0; liveStream = null; historyRevision = null; browsingHistory = false; unseen = false }
    private fun memberPage(body: String): MemberConversationPage =
        RagentProtocol.json.decodeFromString<MemberConversationPage>(body).also {
            if (it.reset || it.generation == null || it.generation < 0 || it.scope !in setOf("full", "captured_only", "activity_only", "unavailable")) throw ConversationReset()
        }
    private fun checkedMemberPage(body: String, expected: ConversationBinding): MemberConversationPage {
        val page = memberPage(body)
        if (page.generation != expected.generation || page.scope != memberScope) throw BindingChanged()
        if (historyRevision != null && page.revision != null && page.revision < historyRevision!!) throw ConversationReset()
        return page
    }
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
        if (memberRef != null) {
            val p = checkedMemberPage(get(source.snapshotPath(sid)), expected)
            memberGap = p.gap
            memberCoverage = p.coverage
            memberActivity = p.activity?.state
            historyRevision = p.revision
            val fresh = ordered(p.entries)
            val newLatest = p.nextAfterSeq ?: fresh.maxOfOrNull { it.boundarySeq() } ?: 0L
            if (preserve && newLatest < latest) throw ConversationReset()
            if (preserve && events.isNotEmpty() && newLatest > latest) return
            events = fresh.takeLast(1000); latest = newLatest
            before = p.nextBeforeSeq; more = p.hasMoreBefore && before != null; hasOlder = more
            reconcileLive(); render(); return
        }
        check(expected)
        val body = get(source.snapshotPath(sid))
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
        val previousScope = memberScope
        val next = descriptor()
        val observedRuntime = runtimeState
        val observedScope = memberScope
        val observedActivity = memberActivity
        if (binding != next || (memberRef != null && previousScope != null && previousScope != observedScope)) clear()
        runtimeState = observedRuntime
        memberScope = observedScope
        memberActivity = observedActivity
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
            if (memberRef != null) {
                val p = checkedMemberPage(get(source.olderPath(sid, cursor)), expected)
                memberGap = p.gap
                memberCoverage = p.coverage
                memberActivity = p.activity?.state
                historyRevision = p.revision ?: historyRevision
                val combined = ordered(events + p.entries)
                if (combined.size > 1000) { browsingHistory = true; unseen = true }
                events = combined.take(1000)
                before = p.nextBeforeSeq; more = p.hasMoreBefore && before != null && before!! < cursor
                hasOlder = more; render(); return@withLock
            }
            check(expected)
            val p = page(get(source.olderPath(sid, cursor)), sid)
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
        if (memberRef != null) {
            delay(3_000)
            val requestEpoch = epoch
            val responseBody = get(source.updatesPath(sid, latest, 0L, null))
            mutex.withLock {
                if (epoch != requestEpoch) return@withLock
                if (binding != expected) throw BindingChanged()
                val p = checkedMemberPage(responseBody, expected)
                memberGap = p.gap
                memberCoverage = p.coverage
                memberActivity = p.activity?.state
                historyRevision = p.revision ?: historyRevision
                val incoming = ordered(p.entries)
                val next = p.nextAfterSeq ?: incoming.maxOfOrNull { it.boundarySeq() } ?: latest
                if (next < latest || (p.hasMoreAfter && next <= latest)) throw ConversationReset()
                if (browsingHistory && incoming.isNotEmpty()) unseen = true else events = ordered(events + incoming).takeLast(1000)
                latest = next; reconcileLive(); render()
            }
            return
        }
        check(expected)
        val requestEpoch = epoch
        val p = page(get(source.updatesPath(sid, latest, liveCursor, liveStream)), sid)
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
    fun offline() { status = ConversationStatus.Offline }
    fun denied() { clear(); status = ConversationStatus.Denied }
    fun reset() { clear(); status = ConversationStatus.Loading }
    fun readFailed() { status = if (transport.connectionState.value == RuntimeConnectionState.Connected) ConversationStatus.Error else ConversationStatus.Offline }
}
private enum class ConversationStatus { Loading, Ready, Offline, Denied, Unbound, Error }

@Composable
fun OrganizationConversationContent(transport: RagentTransport, organizationId: String, nodeId: String, targetId: String?, identityScope: String, modifier: Modifier = Modifier, onRuntimeState: (String?) -> Unit = {}, onAuthorizationDenied: () -> Unit = {}, rootSessionId: String? = null, memberRef: String? = null) {
    val delegate = (transport as? SwitchingRagentTransport)?.delegate?.collectAsState()?.value
    val reader = remember(transport, targetId, identityScope, organizationId, nodeId, rootSessionId, memberRef) { ConversationReader(transport, organizationId, nodeId, rootSessionId, memberRef) }
    val connection by transport.connectionState.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val currentCallback by rememberUpdatedState(onRuntimeState)
    val authorizationDeniedCallback by rememberUpdatedState(onAuthorizationDenied)
    LaunchedEffect(reader, reader.runtimeState, reader.memberActivity, reader.status) {
        val state = if (memberRef != null) reader.memberActivity else reader.runtimeState
        currentCallback(state?.takeIf { reader.status == ConversationStatus.Ready && it != "unknown" })
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
                catch (e: ConversationDenied) { reader.denied(); if (e.authorizationDenied) authorizationDeniedCallback(); break }
                catch (_: BindingChanged) { reader.reset(); delay(250) }
                catch (_: ConversationReset) { reader.reset(); delay(250) }
                catch (_: Exception) { reader.readFailed(); delay(2000) }
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
        if (reader.memberScope == "activity_only") ConversationLabel(R.string.org_conversation_activity_only)
        if (reader.memberScope == "activity_only" && reader.status == ConversationStatus.Ready && reader.memberGap == false) {
            val activityLabel = when (reader.memberActivity) {
                "working" -> R.string.org_member_state_working
                "waiting" -> R.string.org_member_state_waiting
                "failed" -> R.string.org_member_state_failed
                "blocked" -> R.string.org_member_state_blocked
                "idle" -> R.string.org_member_state_idle
                else -> R.string.org_member_state_unknown
            }
            if (activityLabel != null) ConversationLabel(activityLabel)
        }
        if (reader.memberScope == "captured_only" || reader.memberCoverage == "partial") ConversationLabel(R.string.org_conversation_captured_only)
        if (reader.memberScope == "full" && reader.memberCoverage in setOf(null, "unknown")) ConversationLabel(R.string.org_conversation_coverage_unknown)
        if (reader.memberGap == true) ConversationLabel(R.string.org_conversation_gap)
        when (reader.status) {
            ConversationStatus.Loading -> ConversationLabel(R.string.org_conversation_loading)
            ConversationStatus.Unbound -> ConversationLabel(if (reader.memberScope == "unavailable") R.string.org_conversation_member_unavailable else R.string.org_conversation_unbound)
            ConversationStatus.Denied -> ConversationLabel(R.string.org_conversation_denied)
            ConversationStatus.Offline -> ConversationLabel(if (reader.items.isEmpty()) R.string.org_conversation_offline_empty else R.string.org_conversation_offline)
            ConversationStatus.Error -> ConversationLabel(if (reader.items.isEmpty()) R.string.org_conversation_error else R.string.org_conversation_error_retained)
            ConversationStatus.Ready -> if (reader.items.isEmpty() && reader.memberScope != "activity_only") ConversationLabel(R.string.org_conversation_empty)
        }
        if (newContent || reader.unseen) TextButton(onClick = { scope.launch { try { if (reader.browsingHistory) reader.newest(); val count = reader.items.size + if (reader.hasOlder) 1 else 0; if (count > 0) { withFrameNanos { }; snapshotFlow { list.layoutInfo.totalItemsCount }.first { it >= count }; list.scrollToItem(count - 1) }; newContent = false } catch (e: ConversationDenied) { reader.denied(); if (e.authorizationDenied) authorizationDeniedCallback(); restart++ } catch (_: BindingChanged) { reader.reset(); restart++ } catch (_: ConversationReset) { reader.reset(); restart++ } catch (e: CancellationException) { throw e } catch (_: Exception) { reader.readFailed() } } }) { Text(androidx.compose.ui.res.stringResource(if (reader.browsingHistory) R.string.org_conversation_latest else R.string.org_conversation_new)) }
        LazyColumn(state = list, modifier = Modifier.fillMaxWidth().weight(1f, fill = false), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (reader.hasOlder) item(key = "older") { TextButton(enabled = !reader.loadingOlder, onClick = { scope.launch { try { reader.older() } catch (e: ConversationDenied) { reader.denied(); if (e.authorizationDenied) authorizationDeniedCallback(); restart++ } catch (_: BindingChanged) { reader.reset(); restart++ } catch (_: ConversationReset) { reader.reset(); restart++ } catch (e: CancellationException) { throw e } catch (_: Exception) { reader.readFailed() } } }) { Text(androidx.compose.ui.res.stringResource(R.string.org_conversation_older)) } }
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
