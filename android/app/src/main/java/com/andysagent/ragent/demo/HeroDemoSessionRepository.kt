package com.andysagent.ragent.demo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import java.text.BreakIterator
import java.util.Locale
import com.andysagent.ragent.core.domain.RefreshResult
import com.andysagent.ragent.core.domain.SessionInvalidation
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.domain.TimelinePagingState
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeToolOption
import com.andysagent.ragent.core.model.Message
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole

/**
 * Capture harness for design work (welcome hero, golden references).
 *
 * Serves fabricated-but-realistic data behind the production [SessionRepository]
 * contract so the full UI stack (MainActivity -> AppShell -> WorkbenchScreen ->
 * AgentComposer) runs unmodified: insets, shadows, motion and scroll behaviour are
 * all the shipping implementation. Activated only from a debuggable build launched
 * with the `ragent_hero_demo` extra; production code paths never touch this class.
 *
 * Pacing targets screenshot capture (~2 fps PNG): each agent beat lands on its own
 * beat far enough apart for at least one distinct captured frame.
 */
class HeroDemoSessionRepository : SessionRepository {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var nextSeq = 30L

    private val computersFlow = MutableStateFlow(
        listOf(
            Computer(
                id = "demo-workstation",
                name = "workstation",
                platform = "linux",
                endpoint = "192.168.1.20",
                connected = true,
            ),
        ),
    )

    private val projectsFlow = MutableStateFlow(
        listOf(
            Project(id = "demo-project", name = "finance", folder = "~/work/finance"),
        ),
    )

    private val sessionsFlow = MutableStateFlow(listOf(demoSession(status = SessionStatus.Idle)))

    private val messagesFlow = MutableStateFlow(emptyList<Message>())

    // A deliberately long, finished transcript lets visual review cover
    // scrolling, the header glass, and the docked composer without relying on
    // any real account data.
    private val timelineFlow = MutableStateFlow(buildOlderTimeline() + buildRecentTimeline())
    private val timelinePagingFlow = MutableStateFlow(
        TimelinePagingState(
            initialPageLoaded = true,
            hasOlder = false,
            nextBeforeSeq = null,
            latestSeq = nextSeq,
        ),
    )
    private var olderTimelineLoaded = true

    private val approvalsFlow = MutableStateFlow(emptyList<Approval>())

    override val connectionState: StateFlow<RuntimeConnectionState> =
        MutableStateFlow(RuntimeConnectionState.Connected)

    override val invalidations: Flow<SessionInvalidation> = emptyFlow()

    override fun observeComputers(): Flow<List<Computer>> = computersFlow.asStateFlow()

    override fun observeProjects(): Flow<List<Project>> = projectsFlow.asStateFlow()

    override fun observeSessions(): Flow<List<Session>> = sessionsFlow.asStateFlow()

    override fun observeSession(sessionId: String): Flow<Session?> =
        MutableStateFlow(demoSession())

    override fun observeMessages(sessionId: String): Flow<List<Message>> = messagesFlow.asStateFlow()

    override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = timelineFlow.asStateFlow()

    override fun observeTimelinePaging(sessionId: String): Flow<TimelinePagingState> =
        timelinePagingFlow.asStateFlow()

    override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = approvalsFlow.asStateFlow()

    override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = null

    override suspend fun createSession(name: String, tool: String): Session {
        refreshSessions()
        return demoSession()
    }

    override suspend fun createProject(name: String, rootPath: String): Project =
        Project(id = "demo-project", name = name, folder = rootPath)

    override suspend fun refreshComputers() {}

    override suspend fun refreshProjects() {}

    override suspend fun refreshSessions() {}

    override suspend fun loadRuntimeCatalog(): RuntimeCatalog = RuntimeCatalog(
        tools = listOf(RuntimeToolOption(id = "codex", label = "Codex")),
    )

    override suspend fun refreshEvents(sessionId: String): RefreshResult =
        RefreshResult.Applied(count = 0, latestSeq = nextSeq)

    override suspend fun refreshTimeline(sessionId: String): RefreshResult =
        RefreshResult.Applied(count = timelineFlow.value.size, latestSeq = nextSeq)

    override suspend fun loadOlderTimeline(sessionId: String): RefreshResult {
        val current = timelinePagingFlow.value
        if (current.loadingOlder || !current.hasOlder) {
            return RefreshResult.Applied(0, current.latestSeq)
        }
        timelinePagingFlow.value = current.copy(loadingOlder = true, error = null)
        // Long enough for the production loading row and anchor-restoration
        // path to be visible in a device capture, while still feeling like a
        // normal paginated response.
        delay(650)
        val older = if (olderTimelineLoaded) emptyList() else buildOlderTimeline()
        if (older.isNotEmpty()) {
            timelineFlow.value = older + timelineFlow.value
            olderTimelineLoaded = true
        }
        timelinePagingFlow.value = current.copy(
            loadingOlder = false,
            hasOlder = false,
            nextBeforeSeq = null,
            latestSeq = nextSeq,
            error = null,
        )
        return RefreshResult.Applied(older.size, nextSeq)
    }

    override suspend fun applyLiveEvents(
        sessionId: String,
        events: List<com.andysagent.ragent.core.protocol.SessionEventDto>,
    ): RefreshResult = RefreshResult.Applied(count = 0, latestSeq = nextSeq)

    override suspend fun sendMessage(sessionId: String, text: String, requestId: String) {
        require(text.isNotBlank())
        scope.launch { runAgentScript(text.trim()) }
    }

    override suspend fun cancelSession(sessionId: String) {
        sessionStatus.value = SessionStatus.Idle
    }

    override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) {}

    override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) {}

    override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) {}

    override suspend fun resolveRuntimeApproval(
        runId: String,
        approvalId: String,
        decision: String,
        choices: List<String>,
        customAnswer: String?,
        requestId: String,
    ) {}

    override suspend fun resumePendingOperations(): Int = 0

    // ------------------------------------------------------------------
    // Scripted run choreography
    // ------------------------------------------------------------------

    private val sessionStatus = MutableStateFlow(SessionStatus.Idle)

    private fun demoSession(status: SessionStatus = sessionStatus.value): Session = Session(
        id = DEMO_SESSION_ID,
        title = SESSION_TITLE,
        projectId = null,
        status = status,
        latestSeq = nextSeq,
        updatedAt = System.currentTimeMillis(),
    )

    private fun push(item: TimelineItem) {
        nextSeq += 1
        timelineFlow.value = timelineFlow.value + item
        sessionsFlow.value = listOf(demoSession())
    }

    private suspend fun runAgentScript(prompt: String) {
        messagesFlow.value += Message(
            id = "demo-user-msg",
            sessionId = DEMO_SESSION_ID,
            role = "user",
            content = prompt,
            seq = ++nextSeq,
            completed = true,
            timestamp = System.currentTimeMillis(),
            requestId = "demo-run-001",
        )
        push(
            TimelineItem.Message(
                id = "demo-user-msg",
                seq = nextSeq,
                role = TimelineRole.User,
                text = prompt,
                completed = true,
                timestamp = System.currentTimeMillis(),
                requestId = "demo-run-001",
            ),
        )
        delay(170)
        sessionStatus.value = SessionStatus.Working
        sessionsFlow.value = listOf(demoSession())

        suspend fun beat(millis: Long) = delay(millis)

        beat(380)
        push(operation("plan", TimelineOperationKind.Tool, "梳理处理步骤", "按月归档，并保留对账备注", TimelineOperationStatus.InProgress))
        beat(420)
        timelineFlow.value = timelineFlow.value.dropLast(1) + operation("plan", TimelineOperationKind.Tool, "梳理处理步骤", "读取发票，按月份重新归档", TimelineOperationStatus.Completed)

        beat(300)
        push(operation("scan", TimelineOperationKind.Tool, "检查发票导出文件", "~/work/finance/inbox/*.csv", TimelineOperationStatus.InProgress))
        beat(500)
        timelineFlow.value = timelineFlow.value.dropLast(1) + operation("scan", TimelineOperationKind.Tool, "检查发票导出文件", "找到 48 个发票文件", TimelineOperationStatus.Completed)

        beat(340)
        push(
            TimelineItem.Operation(
                id = "edit",
                seq = ++nextSeq,
                kind = TimelineOperationKind.FileEdit,
                title = "按月份重新归档",
                detail = "finance/archive/2026",
                status = TimelineOperationStatus.InProgress,
                fileChanges = listOf(
                    com.andysagent.ragent.core.timeline.FileChangeItem(path = "archive/2026/05/invoices-may.csv", additions = 24, deletions = 0),
                    com.andysagent.ragent.core.timeline.FileChangeItem(path = "archive/2026/06/invoices-jun.csv", additions = 31, deletions = 0),
                ),
            ),
        )
        beat(590)
        timelineFlow.value = timelineFlow.value.dropLast(1)

        beat(170)
        push(operation("run", TimelineOperationKind.Command, "运行归档脚本", "python3 scripts/organize_invoices.py --by month", TimelineOperationStatus.InProgress))
        beat(550)
        timelineFlow.value = timelineFlow.value.dropLast(1) + operation("run", TimelineOperationKind.Command, "运行归档脚本", "已整理 79 条记录", TimelineOperationStatus.Completed)

        beat(380)
        streamAssistantMessage(
            "已将 79 份发票按月份整理到 finance/archive/2026，并写入对账索引。",
        )
        sessionStatus.value = SessionStatus.Idle
        sessionsFlow.value = listOf(demoSession())
    }

    /**
     * Streams the assistant reply word-by-word like the real runtime: every
     * emission replaces the same timeline item with a longer partial text and
     * `completed = false` (rendered by the production AgentStreamingMessage),
     * and a final emission promotes it to the completed message card.
     */
    private suspend fun streamAssistantMessage(text: String) {
        val graphemes = text.graphemes()
        var end = 0
        for (grapheme in graphemes) {
            end += grapheme.length
            upsertMessage(
                TimelineItem.Message(
                    id = ASSISTANT_MESSAGE_ID,
                    seq = ++nextSeq,
                    role = TimelineRole.Agent,
                    text = text.substring(0, end),
                    completed = false,
                    timestamp = System.currentTimeMillis(),
                    requestId = "demo-run-001",
                ),
            )
            delay(STREAM_TOKEN_DELAY_MS)
        }
        upsertMessage(
            TimelineItem.Message(
                id = ASSISTANT_MESSAGE_ID,
                seq = ++nextSeq,
                role = TimelineRole.Agent,
                text = text,
                completed = true,
                timestamp = System.currentTimeMillis(),
                requestId = "demo-run-001",
            ),
        )
    }

    private fun upsertMessage(item: TimelineItem.Message) {
        val existing = timelineFlow.value.indexOfFirst { it.id == item.id }
        timelineFlow.value = if (existing >= 0) {
            timelineFlow.value.toMutableList().apply { this[existing] = item }
        } else {
            timelineFlow.value + item
        }
        sessionsFlow.value = listOf(demoSession())
    }

    private fun operation(
        id: String,
        kind: TimelineOperationKind,
        title: String,
        detail: String,
        status: TimelineOperationStatus,
    ): TimelineItem.Operation = TimelineItem.Operation(
        id = id,
        seq = ++nextSeq,
        kind = kind,
        title = title,
        detail = detail,
        status = status,
    )

    /**
     * The first viewport is deliberately one complete turn: intent, compact
     * activity summary, then the answer. This is the visual reference for the
     * actual conversation surface, not a synthetic event log.
     */
    private fun buildRecentTimeline(): List<TimelineItem> = listOf(
        historyMessage(
            seq = 26L,
            role = TimelineRole.User,
            text = "请把 2026 年的发票按月份整理，并保留对账备注。",
        ),
        historyOperation(
            seq = 27L,
            id = "history-check",
            kind = TimelineOperationKind.Tool,
            title = "检查发票文件",
            detail = "找到 48 个待整理文件",
        ),
        historyOperation(
            seq = 28L,
            id = "history-sort",
            kind = TimelineOperationKind.FileEdit,
            title = "按月份整理发票",
            detail = "finance/archive/2026",
        ),
        historyOperation(
            seq = 29L,
            id = "history-index",
            kind = TimelineOperationKind.Command,
            title = "更新对账索引",
            detail = "79 条记录已写入索引",
        ),
        historyMessage(
            seq = 30L,
            role = TimelineRole.Agent,
            text = "已整理完成：79 份发票已按月份归档，对账备注和索引均已保留。",
        ),
    )

    private fun buildOlderTimeline(): List<TimelineItem> = listOf(
        historyMessage(
            seq = 1L,
            role = TimelineRole.User,
            text = "请审查当前的磨砂玻璃材质与高斯模糊在 Android 上的渲染表现。",
        ),
        historyOperation(
            seq = 2L,
            id = "history-eval-1",
            kind = TimelineOperationKind.Tool,
            title = "检查 RenderEffect 硬件模糊管线",
            detail = "确认 API 31+ RenderEffect.createBlurEffect 正常调用",
        ),
        historyMessage(
            seq = 3L,
            role = TimelineRole.Agent,
            text = "材质审查结果：\n\n- **高斯模糊层**：已通过底层 `GraphicsLayer.record` 与 `RenderEffect` 建立 24dp 硬件级模糊，下层图文流动时呈现真实物理色散。\n- **菲涅尔边缘**：顶部 0.65dp 微米级高光配合 3.5dp 柔和内斜角，完全去除塑料感厚涂，符合 Apple HIG 液体材质规范。\n- **沉浸式视口**：聊天内容采用 Edge-to-Edge 穿透式布局，顶部导航栏与底部输入框均为通透悬浮层。",
        ),
        historyMessage(
            seq = 4L,
            role = TimelineRole.User,
            text = "能否提供一段 Kotlin Compose 下实现 BackdropBlur 的标准示例？",
        ),
        historyOperation(
            seq = 5L,
            id = "history-eval-2",
            kind = TimelineOperationKind.Command,
            title = "生成 Compose 玻璃材质代码",
            detail = "kotlin/designsystem/AgentoFrostedGlassBox.kt",
        ),
        historyMessage(
            seq = 6L,
            role = TimelineRole.Agent,
            text = "以下是 Compose 中基于 `GraphicsLayer` 的双层背景采样核心代码：\n\n```kotlin\nval backdrop = rememberGraphicsLayer()\nBox(\n    modifier = Modifier\n        .fillMaxSize()\n        .drawWithContent {\n            backdrop.record(this, layoutDirection, size.toIntSize()) {\n                drawContent()\n            }\n            drawLayer(backdrop)\n        }\n)\n```\n\n悬浮栏通过 `translate` 对齐根坐标并施加 RenderEffect 模糊，完美保持 60fps 丝滑交互。",
        ),
        historyMessage(
            seq = 7L,
            role = TimelineRole.User,
            text = "我想实际检查长会话滚动时，顶部胶囊、底部 composer 和正文之间的层次关系。滚到中间位置时不要让正文穿透玻璃后还能读清。",
        ),
        historyMessage(
            seq = 8L,
            role = TimelineRole.Agent,
            text = "可以按三个位置检查：\n\n1. 顶部标题下方有高对比正文时，标题胶囊应只保留颜色和轮廓的朦胧感。\n2. 底部 composer 覆盖正文时，正文笔画不能透过玻璃干扰输入提示。\n3. 快速上滑和下滑后，玻璃采样应持续跟随当前画面，不应闪成纯色。\n\n这份示例会话会保留不同长度的段落、列表和代码块，便于反复拖动检查。",
        ),
        historyMessage(
            seq = 9L,
            role = TimelineRole.User,
            text = "输入框在折叠态和展开态的宽度变化也要看。折叠态应该像一个独立的胶囊，展开后才接近内容区域宽度。",
        ),
        historyMessage(
            seq = 10L,
            role = TimelineRole.Agent,
            text = "滚动检查建议：\n\n- 从底部缓慢向上拖，观察 composer 周围是否始终有一圈柔和扩散阴影。\n- 让一段粗体标题或代码块经过 composer 下方，确认它只会变成柔和色块。\n- 再回到会话底部，确认折叠 composer 仍保持较窄宽度，且左右留白对称。\n\n前景控件本身不参与 backdrop 模糊，因此按钮、光标和输入文字都应保持锐利。",
        ),
        historyOperation(
            seq = 11L,
            id = "history-scroll-baseline",
            kind = TimelineOperationKind.Tool,
            title = "准备滚动视觉基线",
            detail = "已加入长段落、清单与代码块作为背景采样内容",
        ),
        historyMessage(
            seq = 12L,
            role = TimelineRole.User,
            text = "顶部的返回和更多按钮我也会在文字背景上检查，不希望它们变成两块没有质感的白色圆片。",
        ),
        historyMessage(
            seq = 13L,
            role = TimelineRole.Agent,
            text = "顶部两个圆形操作会对齐各自位置采样会话画面；因此经过密集文本时，内部应出现被打散的明暗变化，而不是始终引用页面左上角的空白。材质基底会再加一层低对比雾化，保证图标仍有足够可读性。",
        ),
        historyMessage(
            seq = 14L,
            role = TimelineRole.User,
            text = "暗色模式下也请保持同样的层级：不要是普通深灰卡片，而是有一点哑光、能感受到背景变化的深色玻璃。",
        ),
        historyMessage(
            seq = 15L,
            role = TimelineRole.Agent,
            text = "暗色材质会使用深色半透明基底和微亮颗粒。背景仍然被扩散，但不会抹掉前景内容；当亮色消息经过玻璃下方时，只能看到低频的光影起伏，不能分辨出具体字形。",
        ),
        historyOperation(
            seq = 16L,
            id = "history-matte-pass",
            kind = TimelineOperationKind.FileEdit,
            title = "调整磨砂扩散层",
            detail = "提高局部散焦并加入细密的低对比哑光颗粒",
        ),
        historyMessage(
            seq = 17L,
            role = TimelineRole.User,
            text = "如果我在会话中间停住，继续输入一段很长的文字，composer 展开时应该向上生长，底边不能跟着跳。",
        ),
        historyMessage(
            seq = 18L,
            role = TimelineRole.Agent,
            text = "composer 的底部锚点保持固定，内容增长只向上扩展。核心约束类似：\n\n```kotlin\n.animateContentSize(\n    animationSpec = spring(dampingRatio = 0.88f),\n    alignment = Alignment.BottomCenter,\n)\n```\n\n因此键盘打开、文本换行和折叠/展开切换时，发送按钮会始终停留在稳定的底部动作区。",
        ),
        historyMessage(
            seq = 19L,
            role = TimelineRole.User,
            text = "这个会话再多放几段不同密度的内容。我会连续快速上滑、反向拖动，并观察玻璃背景有没有滞后或闪烁。",
        ),
        historyMessage(
            seq = 20L,
            role = TimelineRole.Agent,
            text = "快速滚动时请特别留意两点：第一，顶部玻璃内的背景应与正文保持同向移动，不应出现残留的旧帧；第二，底部 composer 下方的文字应连续地失焦，而不是在每个列表项之间突然变清晰。\n\n这类长文本比空白页面更适合作为检验样本，因为不同字重、中文笔画与英文等宽代码会同时经过玻璃区域。",
        ),
        historyOperation(
            seq = 21L,
            id = "history-motion-pass",
            kind = TimelineOperationKind.Command,
            title = "检查局部背景采样",
            detail = "以连续文本滚动验证 GraphicsLayer 记录与坐标偏移",
        ),
        historyMessage(
            seq = 22L,
            role = TimelineRole.User,
            text = "我还会检查卡片底部的展开提示。它只能是一个清晰的 chevron，不能把整张卡片都做成会展开的点击区。",
        ),
        historyMessage(
            seq = 23L,
            role = TimelineRole.Agent,
            text = "展开入口保持为独立、可见的向下 chevron 按钮；指标、状态和卡片空白处都不会触发展开。这样用户能先理解卡片信息，再主动选择查看完整详情。",
        ),
        historyMessage(
            seq = 24L,
            role = TimelineRole.User,
            text = "好的。请保留这个样例，不要把它和我真实的本地会话混在一起。",
        ),
        historyMessage(
            seq = 25L,
            role = TimelineRole.Agent,
            text = "已保留为仅限 Debug 演示入口的静态会话。它不会写入或修改真实的会话、项目和运行记录；你可以直接用它反复检查长列表滚动、玻璃散焦和 composer 的过渡。",
        ),
    )

    private fun historyMessage(
        seq: Long,
        role: TimelineRole,
        text: String,
    ): TimelineItem.Message = TimelineItem.Message(
        id = "history-message-$seq",
        seq = seq,
        role = role,
        text = text,
        completed = true,
        timestamp = seq * 1_000L,
        requestId = "history-request-$seq",
    )

    private fun historyOperation(
        seq: Long,
        id: String,
        kind: TimelineOperationKind,
        title: String,
        detail: String,
    ): TimelineItem.Operation = TimelineItem.Operation(
        id = id,
        seq = seq,
        kind = kind,
        title = title,
        detail = detail,
        status = TimelineOperationStatus.Completed,
    )

    companion object {
        const val DEMO_SESSION_ID = "hero-demo-session"
        const val SESSION_TITLE = "玻璃材质滚动检查"
        const val ASSISTANT_MESSAGE_ID = "demo-assistant-msg"

        /** Grapheme-by-grapheme cadence, matching the native streaming treatment. */
        const val STREAM_TOKEN_DELAY_MS = 78L
    }
}

private fun String.graphemes(): List<String> {
    if (isEmpty()) return emptyList()
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
    iterator.setText(this)
    val result = mutableListOf<String>()
    var start = iterator.first()
    while (start != BreakIterator.DONE) {
        val end = iterator.next()
        if (end == BreakIterator.DONE) break
        result += substring(start, end)
        start = end
    }
    return result
}
