package com.andysagent.ragent.core.timeline

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.Json

/**
 * The small, human-readable sentence shown while a run is active.  This is a
 * presentation projection, not an audit record: [TimelineItem.Operation.detail]
 * remains the source of truth for the expandable operation row.
 */
data class RunActionUiState(
    val kind: String,
    val sentence: String,
    val detail: String = "",
    val operationId: String? = null,
    val groupedCount: Int = 1,
    val sinceMillis: Long? = null,
    /** Set only for deterministic templates; provider prose stays untouched. */
    val presentationVerb: String? = null,
    val presentationSubject: String = "",
)

object RunActionFormatter {
    /** Web-style optimistic tool activity must not wait for a slower HTTP snapshot. */
    fun project(status: RunActionStatus, phase: String?, items: List<TimelineItem>, activity: JsonObject?, runId: String?): RunActionUiState? {
        if (status == RunActionStatus.Other) return null
        if (status == RunActionStatus.WaitingApproval) return forRun(status, phase, items, runId)
        val canonical = fromServer(activity, runId)
        val current = items.drop(items.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User } + 1)
        val active = current.filterIsInstance<TimelineItem.Operation>().lastOrNull {
            (runId.isNullOrBlank() || it.runId.isNullOrBlank() || it.runId == runId) &&
                it.status in setOf(TimelineOperationStatus.Pending, TimelineOperationStatus.InProgress)
        }
        val sourceSeq = (activity?.get("sourceSeq") as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0L
        val liveToolIsNewer = active != null && (sourceSeq == 0L || active.seq == 0L || active.seq > sourceSeq)
        val genericSubject = (activity?.get("subject") as? JsonPrimitive)?.contentOrNull.orEmpty().trim().lowercase()
            .substringAfterLast("__").substringAfterLast('/')
        val genericTool = canonical?.kind in setOf("tool", "mcp", "other") && genericSubject in setOf("execute", "exec", "tool", "other", "unknown")
        if ((liveToolIsNewer || genericTool) && active != null &&
            (canonical == null || genericTool || canonical.kind in setOf("working", "thinking", "think", "responding", "other", "tool"))) {
            return fromOperation(active!!)
        }
        return fromProgressPlan(items, runId) ?: canonical ?: forRun(status, phase, items, runId)
    }

    /** Same canonical activity and subject/lifecycle rules as Web run-activity. */
    fun fromServer(activity: JsonObject?, expectedRunId: String? = null): RunActionUiState? {
        activity ?: return null
        fun value(key: String) = (activity[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
        if (value("state") in setOf("", "idle")) return null
        if (!expectedRunId.isNullOrBlank() && value("runId").isNotBlank() && value("runId") != expectedRunId) return null
        val kind = value("labelKind").ifBlank { value("kind") }.ifBlank { "working" }
        val detail = value("detail")
        val rawSubject = when {
            value("subject").isNotBlank() -> clipSubject(value("subject"), 48)
            kind in setOf("read", "file_edit", "edit", "delete") -> basename(detail)
            kind == "search" -> clipSubject(detail.substringBefore(" · "), 48)
            kind in setOf("web", "fetch", "click", "input", "scroll", "capture", "generate", "mcp", "subagent",
                "task_create", "task_update", "task_read", "task_list", "task_stop", "message", "wait", "question",
                "other", "command", "execute", "move", "switch_mode") -> clipSubject(detail, 80)
            else -> ""
        }
        val subject = when {
            kind in setOf("command", "execute", "execute_composite") && rawSubject.lowercase() in setOf("execute", "exec", "bash", "shell", "command") -> "command"
            kind == "read" && rawSubject.lowercase() in setOf("read", "readfile") -> "file"
            kind == "question" && rawSubject.equals("question", ignoreCase = true) -> ""
            else -> rawSubject
        }
        val lifecycle = value("operationState").ifBlank { value("state") }
        val group = activity["group"] as? JsonObject
        val count = (group?.get("count") as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 1
        val verb = when (kind) {
            "read" -> "Reading"; "list" -> "Listing"; "inspect" -> "Inspecting"; "search" -> "Searching"
            "file_edit", "edit" -> "Editing"; "delete" -> "Deleting"; "move" -> "Moving"
            "command", "execute", "execute_composite" -> "Running"
            "web" -> "Browsing"; "fetch" -> "Fetching"; "click" -> "Clicking"; "input" -> "Entering"
            "scroll" -> "Scrolling"; "capture" -> "Capturing"; "generate" -> "Generating"
            "mcp" -> "Using"; "subagent" -> "Delegating to"; "message" -> "Sending a message to"
            "task_create" -> "Creating task"; "task_update" -> "Updating task"; "task_read" -> "Reading task"
            "task_list" -> "Listing tasks"; "task_stop" -> "Stopping task"; "switch_mode" -> "Switching mode"
            "question" -> "Asking a question"
            "planning" -> "Planning"; "responding" -> "Responding"; "think", "thinking" -> "Thinking"
            "wait", "waiting" -> "Waiting"; else -> value("label").ifBlank { "Working" }
        }
        val action = when {
            lifecycle in setOf("pending", "waiting_user", "waiting_approval", "approval_requested") || kind == "approval" -> "Waiting for approval"
            lifecycle in setOf("failed", "error") -> "Failed"
            lifecycle in setOf("declined", "denied") -> "Declined"
            lifecycle in setOf("interrupted", "cancelled", "canceled") -> "Interrupted"
            lifecycle in setOf("completed", "complete", "done", "success", "succeeded") -> "Completed"
            (group?.get("kind") as? JsonPrimitive)?.contentOrNull == "exploring" && count > 1 -> "Exploring $count items"
            else -> verb
        }
        val liveness = activity["providerLiveness"] as? JsonObject
        val waiting = (liveness?.get("phase") as? JsonPrimitive)?.contentOrNull == "awaiting_provider_output"
            && kind !in setOf("approval", "responding", "waiting")
        val groupedExploration = (group?.get("kind") as? JsonPrimitive)?.contentOrNull == "exploring" && count > 1
        val modelDescription = value("activityDescription").takeIf {
            lifecycle in setOf("running", "working", "started", "in_progress") && it.isNotBlank()
        }
        val genericName = subject.lowercase().substringAfterLast("__").substringAfterLast('/')
        val isGenericTool = kind in setOf("tool", "mcp", "other") && genericName in setOf("execute", "exec", "tool", "other", "unknown")
        val sentence = (modelDescription ?: if (isGenericTool && lifecycle in setOf("running", "working", "started", "in_progress")) {
            "Working on the task"
        } else listOf(action, subject.takeUnless { groupedExploration }.orEmpty()).filter { it.isNotBlank() }.joinToString(" ")) +
            if (waiting) " · waiting for provider output" else ""
        val localizable = modelDescription == null && !waiting && !groupedExploration &&
            lifecycle in setOf("running", "working", "started", "in_progress")
        val presentationVerb = if (!localizable) null else if (isGenericTool) "working" else if (subject.isBlank() && kind !in setOf("command", "execute", "execute_composite", "question")) null else when (kind) {
            "command", "execute", "execute_composite" -> "execute"
            "question" -> "question"
            "file_edit", "edit" -> "edit"
            "read", "list", "inspect", "search", "delete" -> kind
            else -> null
        }
        return RunActionUiState(kind, sentence.safeDisplay(), detail.safeDisplay(), value("operationId").takeIf { it.isNotBlank() }, count,
            value("since").toLongOrNull()?.takeIf { it > 0 }, presentationVerb, subject.safeDisplay())
    }

    fun fromProgressPlan(items: List<TimelineItem>, runId: String?): RunActionUiState? {
        val currentTurn = items.drop(items.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User } + 1)
        val plan = currentTurn.filterIsInstance<TimelineItem.Plan>().lastOrNull {
            (runId.isNullOrBlank() || it.runId == runId) &&
                (it.planIntent == "progress" || (it.planIntent.isNullOrBlank() && it.interactionMode == "agent"))
        } ?: return null
        if (plan.items.isEmpty()) return null
        val completed = plan.items.count { it.status in setOf("completed", "complete", "done", "success", "succeeded") }
        if (completed == plan.items.size) return null
        val current = plan.items.firstOrNull { it.status in setOf("in_progress", "active", "current", "running", "started") }
            ?: plan.items.firstOrNull { it.status !in setOf("completed", "complete", "done", "success", "succeeded") }
        return RunActionUiState("planning", "$completed/${plan.items.size} · ${current?.text.orEmpty()}", operationId = plan.id)
    }

    fun forRun(
        status: RunActionStatus,
        phase: String?,
        items: List<TimelineItem>,
        runId: String? = null,
    ): RunActionUiState? {
        if (status !in setOf(RunActionStatus.Working, RunActionStatus.WaitingApproval)) return null
        val operations = items.drop(items.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User } + 1)
            .filterIsInstance<TimelineItem.Operation>()
            .filter { runId.isNullOrBlank() || it.runId.isNullOrBlank() || it.runId == runId }
        val active = operations.asReversed().firstOrNull {
            it.status == TimelineOperationStatus.InProgress || it.status == TimelineOperationStatus.Pending
        }
        val action = active?.let(::fromOperation)
        if (status == RunActionStatus.WaitingApproval) {
            return RunActionUiState(
                kind = "approval",
                sentence = "Waiting for approval",
                detail = action?.sentence.orEmpty(),
                operationId = action?.operationId,
                presentationVerb = "approval",
            )
        }
        if (action != null) {
            val groupedCount = if (isGroupable(action.kind)) {
                operations.asReversed().take(12).takeWhile { fromOperation(it)?.kind == action.kind }.size.coerceAtLeast(1)
            } else 1
            return action.copy(groupedCount = groupedCount)
        }
        return RunActionUiState(
            kind = "working",
            sentence = phaseSentence(phase),
            presentationVerb = when (phase?.lowercase()) {
                "planning", "plan" -> "planning"
                "awaiting_provider_output", "thinking", "reasoning" -> "thinking"
                "starting", "booting" -> "starting"
                else -> "working"
            },
        )
    }

    /** Kept separate from the protocol model so tests can exercise this pure projection. */
    enum class RunActionStatus { Working, WaitingApproval, Other }

    /** Historical rows describe their own operation regardless of lifecycle. */
    fun forOperation(operation: TimelineItem.Operation): RunActionUiState = fromOperation(operation)

    private fun fromOperation(operation: TimelineItem.Operation): RunActionUiState {
        if (operation.isReasoning) return RunActionUiState("thinking", "Thinking through the task", operationId = operation.id, presentationVerb = "thinking")
        val command = operation.commandText()
        val semantic = command?.let(::parseCommand)
        val tool = operation.toolName.orEmpty().trim().lowercase().substringAfterLast("__")
        val kind = semantic?.first ?: when (operation.kind) {
            TimelineOperationKind.FileEdit -> "edit"
            TimelineOperationKind.Diff -> "inspect"
            TimelineOperationKind.SubAgent -> "delegate"
            TimelineOperationKind.Tool -> when (tool) {
                "read" -> "read"; "glob", "ls" -> "list"; "grep", "search" -> "search"
                "edit", "write", "multiedit", "notebookedit" -> "edit"
                "bash", "shell", "execute", "exec" -> "execute"
                "thinking", "think", "reasoning" -> "thinking"
                else -> "tool"
            }
            TimelineOperationKind.Command -> "execute"
            TimelineOperationKind.Unknown -> "working"
        }
        val subject = semantic?.second ?: operation.subject()
        if (kind == "tool" && operation.detail.trim().equals("AskUserQuestion", ignoreCase = true)) {
            return RunActionUiState("question", "Asking a question", operation.detail.compact().safeDisplay(), operation.id,
                presentationVerb = "question")
        }
        if (kind == "tool" && subject.lowercase() in setOf("other", "unknown", "tool", "execute", "exec")) {
            return RunActionUiState("working", "Working on the task", operation.detail.compact().safeDisplay(), operation.id,
                presentationVerb = "working")
        }
        val sentence = when (kind) {
            "read" -> "Reading $subject"
            "list" -> "Listing $subject"
            "search" -> "Searching $subject"
            "inspect" -> "Inspecting $subject"
            "edit" -> "Editing $subject"
            "delete" -> "Deleting $subject"
            "delegate" -> "Delegating $subject"
            "tool" -> "Using $subject"
            "execute" -> "Running $subject"
            "thinking" -> "Thinking through the task"
            else -> "Working on $subject"
        }
        return RunActionUiState(kind, sentence.safeDisplay(), operation.detail.compact().safeDisplay(), operation.id,
            presentationVerb = kind, presentationSubject = subject.safeDisplay())
    }

    private fun TimelineItem.Operation.commandText(): String? {
        inputField("command", "cmd", "script", "shell")?.let { return it }
        val candidates = listOf(inputJson, detail, title, toolName)
        candidates.firstNotNullOfOrNull { value ->
            val text = value.orEmpty()
            Regex("(?:^|[\\\"' ])(?:command|cmd|script|shell|program|executable)[\\\"' ]*[:=][\\\"']?([^\\\"'}\\n]+)", RegexOption.IGNORE_CASE)
                .find(text)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotBlank() }
        }?.let { return it }
        return if (operationKindIsCommand() && detail.isNotBlank() && detail.trim().lowercase() !in setOf("bash", "shell", "execute", "exec", "command")) detail else null
    }

    private fun TimelineItem.Operation.operationKindIsCommand() =
        kind == TimelineOperationKind.Command || toolName.orEmpty().contains("exec", true) || toolName.orEmpty().contains("shell", true)

    private fun TimelineItem.Operation.subject(): String = when {
        isReasoning -> "the task"
        toolName.orEmpty().lowercase() in setOf("read", "write", "edit", "multiedit", "notebookedit") || kind == TimelineOperationKind.FileEdit ->
            basename(inputField("file_path", "path", "notebook_path") ?: detail.takeIf {
                it.isNotBlank() && !it.contains('\n') && (it.contains('/') || it.contains('\\') || Regex("^[^\\s]+\\.[A-Za-z0-9]{1,12}$").matches(it))
            } ?: title.takeUnless {
                it.trim().lowercase() in setOf("read", "reading file", "edit", "editing file", "write", "writing file")
            }.orEmpty().ifBlank { "file" })
        toolName.orEmpty().lowercase() in setOf("grep", "glob", "search") -> inputField("pattern", "query", "glob")?.let { clipSubject(it, 48) } ?: "workspace"
        toolName.orEmpty().lowercase().substringAfterLast("__") in setOf("bash", "shell", "execute", "exec") -> "command"
        kind == TimelineOperationKind.Command -> "command"
        kind == TimelineOperationKind.Diff -> "workspace changes"
        kind == TimelineOperationKind.SubAgent -> title.ifBlank { "sub-agent" }.compact()
        else -> (toolName ?: title).ifBlank { "next step" }.compact()
    }

    private fun TimelineItem.Operation.inputField(vararg keys: String): String? {
        val input = runCatching { Json.parseToJsonElement(inputJson.orEmpty()) as? JsonObject }.getOrNull() ?: return null
        return keys.firstNotNullOfOrNull { key -> (input[key] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }
    }

    private fun parseCommand(raw: String): Pair<String, String> {
        val command = raw.trim().compact()
        val tokens = Regex("(?:\\\"([^\\\"]+)\\\"|'([^']+)'|([^\\s]+))").findAll(command)
            .map { it.groups[1]?.value ?: it.groups[2]?.value ?: it.groups[3]?.value.orEmpty() }
            .toList()
        if (tokens.isEmpty()) return "execute" to "command"
        var index = 0
        val executable = tokens[index].substringAfterLast('/').substringAfterLast('\\').lowercase().removeSuffix(".exe")
        if (executable == "cmd" || executable == "powershell" || executable == "pwsh") {
            index = tokens.indexOfFirst { it.equals("/c", true) || it.equals("-c", true) || it.equals("-command", true) }
            if (index >= 0 && index + 1 < tokens.size) return parseCommand(tokens[index + 1])
            index = 1
        }
        val name = (tokens.getOrNull(index)?.substringAfterLast('/')?.substringAfterLast('\\').orEmpty())
            .lowercase()
            .removeSuffix(".exe")
        if (name in SHELL_WRAPPERS) {
            val commandFlag = tokens.indexOfFirst { it.equals("-c", true) || it.equals("-lc", true) || it.equals("-ic", true) }
            if (commandFlag >= 0 && commandFlag + 1 < tokens.size) return parseCommand(tokens[commandFlag + 1])
        }
        val args = tokens.drop(index + 1).filter { it.isNotBlank() && !it.startsWith('-') && !it.startsWith('/') }
        val path = args.lastOrNull().orEmpty()
        val subject = when {
            name in READ -> basename(path.ifBlank { "file" })
            name in LIST -> path.ifBlank { "workspace" }
            name in SEARCH -> args.take(2).joinToString(" in ").ifBlank { "workspace" }
            name == "git" -> when (args.firstOrNull()?.lowercase()) {
                "status" -> "workspace status"
                "diff" -> "workspace changes"
                "log" -> "commit history"
                "branch" -> "branches"
                else -> args.firstOrNull() ?: "git"
            }
            name in INSPECT -> if (name == "pwd" || name == "get-location") "current location" else name
            name in EDIT || name in DELETE -> basename(path.ifBlank { "file" })
            else -> name.ifBlank { "command" }
        }
        val kind = when {
            name in READ -> "read"
            name in LIST -> "list"
            name in SEARCH -> "search"
            name == "git" && args.firstOrNull()?.lowercase() in setOf("status", "diff", "log", "branch") -> "inspect"
            name in INSPECT -> "inspect"
            name in DELETE -> "delete"
            name in EDIT -> "edit"
            else -> "execute"
        }
        return kind to subject.compact()
    }

    private fun phaseSentence(phase: String?): String = when (phase?.lowercase()) {
        "planning", "plan" -> "Planning the next step"
        "awaiting_provider_output", "thinking", "reasoning" -> "Thinking through the task"
        "starting", "booting" -> "Starting the run"
        else -> "Working on the task"
    }

    private fun isGroupable(kind: String) = kind in setOf("read", "list", "search", "inspect")
    private fun clipSubject(value: String, maximum: Int): String = value.compact().let {
        if (it.length <= maximum) it else it.take(maximum - 1).trimEnd() + "…"
    }
    private fun basename(value: String) = value.trim().trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifBlank { value.trim() }
    private fun String.compact() = replace(Regex("\\s+"), " ").trim().take(160)
    private fun String.safeDisplay() = replace(
        Regex("(?i)(\\b(?:[a-z0-9_-]*)(?:token|password|passwd|secret|api[_-]?key)\\s*(?:=|:)\\s*)[^\\s,;]+"),
        "$1[redacted]",
    ).replace(Regex("(?i)(\\bBearer\\s+)\\S+"), "$1[redacted]")

    private val READ = setOf("cat", "head", "tail", "sed", "awk", "less", "more", "bat", "type", "get-content", "gc")
    private val LIST = setOf("ls", "dir", "tree", "exa", "eza", "get-childitem", "gci")
    private val SEARCH = setOf("rg", "ripgrep", "grep", "egrep", "fgrep", "find", "findstr", "select-string", "sls")
    private val INSPECT = setOf("pwd", "whoami", "where", "ver", "get-location", "test-path", "get-command", "get-service", "get-process")
    private val EDIT = setOf("set-content", "add-content", "new-item", "copy-item", "move-item")
    private val DELETE = setOf("remove-item", "rm", "del", "erase", "rmdir", "rd")
    private val SHELL_WRAPPERS = setOf("bash", "sh", "zsh", "fish", "env", "command", "xargs")
}
