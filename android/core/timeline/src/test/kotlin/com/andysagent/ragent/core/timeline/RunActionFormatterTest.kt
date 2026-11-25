package com.andysagent.ragent.core.timeline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunActionFormatterTest {
    @Test fun powershellRemovalIsPresentedAsDeletion() {
        val operation = TimelineItem.Operation("remove", 1, TimelineOperationKind.Command, "Command",
            "Remove-Item -LiteralPath G:/test/example -Recurse -Force", TimelineOperationStatus.Failed)
        val result = RunActionFormatter.forOperation(operation)
        assertEquals("delete", result.presentationVerb)
        assertEquals("example", result.presentationSubject)
        val activity = kotlinx.serialization.json.Json.parseToJsonElement("""{"state":"running","kind":"delete","detail":"G:/test/example"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("delete", RunActionFormatter.fromServer(activity)?.presentationVerb)
    }
    @Test fun genericCommandAndReadSubjectsUseHumanReadableFallbacks() {
        val json = kotlinx.serialization.json.Json
        val command = json.parseToJsonElement("""{"state":"working","kind":"execute","labelKind":"execute","subject":"execute","detail":"Bash"}""") as kotlinx.serialization.json.JsonObject
        val read = json.parseToJsonElement("""{"state":"working","kind":"read","subject":"read"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Running command", RunActionFormatter.fromServer(command)?.sentence)
        assertEquals("command", RunActionFormatter.fromServer(command)?.presentationSubject)
        assertEquals("Reading file", RunActionFormatter.fromServer(read)?.sentence)
        val operation = TimelineItem.Operation("o", 1, TimelineOperationKind.Command, "Running command", "Bash", TimelineOperationStatus.InProgress)
        assertEquals("Running command", RunActionFormatter.forOperation(operation).sentence)
        val projectedRead = TimelineItem.Operation("r", 2, TimelineOperationKind.Tool, "Reading file", "Read", TimelineOperationStatus.Completed, toolName = "read")
        assertEquals("Reading file", RunActionFormatter.forOperation(projectedRead).sentence)
        assertEquals("Reading acceptance.txt", RunActionFormatter.forOperation(projectedRead.copy(detail = "G:\\qa\\acceptance.txt")).sentence)
        val other = json.parseToJsonElement("""{"state":"working","kind":"other","subject":"other"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Working on the task", RunActionFormatter.fromServer(other)?.sentence)
        val projectedOther = TimelineItem.Operation("x", 3, TimelineOperationKind.Tool, "Using tool", "", TimelineOperationStatus.InProgress, toolName = "other")
        assertEquals("Working on the task", RunActionFormatter.forOperation(projectedOther).sentence)
        assertEquals("Asking a question", RunActionFormatter.forOperation(projectedOther.copy(detail = "AskUserQuestion")).sentence)
        val question = json.parseToJsonElement("""{"state":"working","labelKind":"question","subject":"question"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Asking a question", RunActionFormatter.fromServer(question)?.sentence)
    }
    @Test fun completedOperationDoesNotLookLikeAnActiveAction() {
        val operation = TimelineItem.Operation("done", 1, TimelineOperationKind.Command, "Search", "rg pattern .",
            TimelineOperationStatus.Completed)
        val state = RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, "thinking", listOf(operation))!!
        assertEquals("thinking", state.presentationVerb)
        assertEquals(null, state.operationId)
        assertEquals("search", RunActionFormatter.forOperation(operation).presentationVerb)
    }

    @Test fun activeOperationFromAnotherRunIsNotShownForCurrentRun() {
        val operation = TimelineItem.Operation("old", 1, TimelineOperationKind.Command, "Search", "rg pattern .",
            TimelineOperationStatus.InProgress, runId = "old-run")
        val state = RunActionFormatter.project(RunActionFormatter.RunActionStatus.Working, "thinking", listOf(operation), null, "current-run")!!
        assertEquals("thinking", state.presentationVerb)
        assertEquals(null, state.operationId)
    }

    @Test fun localActionDoesNotExposeCommonCredentialAssignments() {
        val operation = TimelineItem.Operation("search", 1, TimelineOperationKind.Command, "Search", "rg API_TOKEN=secretvalue .",
            TimelineOperationStatus.InProgress)
        val sentence = RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(operation))!!.sentence
        assertTrue(!sentence.contains("secretvalue"))
    }
    @Test fun modelProvidedActivityDescriptionIsShownOnlyWhileRunning() {
        val json = kotlinx.serialization.json.Json
        val running = json.parseToJsonElement("""{"state":"working","kind":"execute","activityDescription":"Checking project instructions"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Checking project instructions", RunActionFormatter.fromServer(running)?.sentence)
        val finished = json.parseToJsonElement("""{"state":"completed","kind":"execute","activityDescription":"Checking project instructions"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Completed", RunActionFormatter.fromServer(finished)?.sentence)
    }
    @Test fun genericExecuteSnapshotUsesStructuredLiveCommand() {
        val activity = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"state":"working","kind":"mcp","subject":"execute","sourceSeq":20,"runId":"run-a"}"""
        ) as kotlinx.serialization.json.JsonObject
        val tool = TimelineItem.Operation("tool", 20, TimelineOperationKind.Tool, "execute", "",
            TimelineOperationStatus.InProgress, toolName = "mcp__shell__execute",
            inputJson = """{"command":"cat README.md"}""", runId = "run-a")
        assertEquals("Reading README.md", RunActionFormatter.project(
            RunActionFormatter.RunActionStatus.Working, null, listOf(tool), activity, "run-a")?.sentence)
        assertEquals("Working on the task", RunActionFormatter.project(
            RunActionFormatter.RunActionStatus.Working, null, emptyList(), activity, "run-a")?.sentence)
    }
    @Test fun claudeToolsUseTheirStructuredInputsInsteadOfRawToolNames() {
        fun action(name: String, input: String, reasoning: Boolean = false): String? {
            val op = TimelineItem.Operation("op", 1, TimelineOperationKind.Tool, name, "", TimelineOperationStatus.InProgress,
                toolName = name, inputJson = input, isReasoning = reasoning)
            return RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(op))?.sentence
        }
        assertEquals("Editing internet-and-web.md", action("Write", """{"file_path":"/work/internet-and-web.md","content":"private body"}"""))
        assertEquals("Reading README.md", action("Read", """{"file_path":"/work/README.md"}"""))
        assertEquals("Listing workspace", action("Bash", """{"command":"ls -l"}"""))
        assertEquals("Thinking through the task", action("thinking", "{}", reasoning = true))
    }
    @Test fun realToolSupersedesStaleRespondingSnapshotButNotANewerCanonicalUpdate() {
        val activity = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"state":"working","kind":"responding","sourceSeq":10,"runId":"run-a"}"""
        ) as kotlinx.serialization.json.JsonObject
        val tool = TimelineItem.Operation("read", 11, TimelineOperationKind.Command, "Read", "cat README.md",
            TimelineOperationStatus.InProgress, runId = "run-a", durableStartSeq = 11)
        fun project(status: RunActionFormatter.RunActionStatus, event: TimelineItem.Operation) =
            RunActionFormatter.project(status, null, listOf(event), activity, "run-a")
        assertEquals("Reading README.md", project(RunActionFormatter.RunActionStatus.Working, tool)?.sentence)
        assertEquals("Responding", project(RunActionFormatter.RunActionStatus.Working, tool.copy(seq = 9, durableStartSeq = 9))?.sentence)
        assertEquals("Waiting for approval", project(RunActionFormatter.RunActionStatus.WaitingApproval, tool)?.sentence)
        assertEquals(null, project(RunActionFormatter.RunActionStatus.Other, tool))
    }

    @Test fun canonicalActivityKeepsTheConcreteToolSubjectAndProviderWait() {
        val json = kotlinx.serialization.json.Json
        val activity = json.parseToJsonElement("""{"state":"working","kind":"read","subject":"README.md","detail":"/work/README.md","runId":"run-a","providerLiveness":{"phase":"awaiting_provider_output"}}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Reading README.md · waiting for provider output", RunActionFormatter.fromServer(activity, "run-a")?.sentence)
        assertEquals(null, RunActionFormatter.fromServer(activity, "other-run"))
        val approval = json.parseToJsonElement("""{"state":"waiting_user","kind":"approval","subject":"git push","operationId":"approval-op"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Waiting for approval git push", RunActionFormatter.fromServer(approval)?.sentence)
        assertEquals("approval-op", RunActionFormatter.fromServer(approval)?.operationId)
        val response = json.parseToJsonElement("""{"state":"working","kind":"responding","detail":"Actual assistant response text"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Responding", RunActionFormatter.fromServer(response)?.sentence)
    }

    @Test fun progressPlansMatchTheirRunAndDisappearAfterTheLastStep() {
        val plan = TimelineItem.Plan("plan", 1, "plan", "Task", "running", 1,
            items = listOf(PlanStepItem("Read files", "completed"), PlanStepItem("Run checks", "in_progress")),
            planIntent = "progress", runId = "run-a")
        assertEquals("1/2 · Run checks", RunActionFormatter.fromProgressPlan(listOf(plan), "run-a")?.sentence)
        assertEquals(null, RunActionFormatter.fromProgressPlan(listOf(plan), "other-run"))
        assertEquals(null, RunActionFormatter.fromProgressPlan(listOf(plan.copy(items = plan.items.map { it.copy(status = "completed") })), "run-a"))
    }

    @Test
    fun posixReadUsesFileNameAndKeepsDetail() {
        val result = format("cat src/main/App.kt")
        assertEquals("read", result?.kind)
        assertEquals("Reading App.kt", result?.sentence)
        assertEquals("cat src/main/App.kt", result?.detail)
    }

    @Test
    fun powershellReadUsesWindowsBasename() {
        val result = format("Get-Content C:\\work\\report.csv")
        assertEquals("read", result?.kind)
        assertEquals("Reading report.csv", result?.sentence)
    }

    @Test
    fun cmdSearchIsHumanReadable() {
        val result = format("findstr invoice C:\\work")
        assertEquals("search", result?.kind)
        assertTrue(result?.sentence?.startsWith("Searching invoice in") == true)
    }

    @Test
    fun gitStatusAndFileEditAreSemantic() {
        assertEquals("Inspecting workspace status", format("git status")?.sentence)
        val edit = TimelineItem.Operation(
            id = "edit-1",
            seq = 2,
            kind = TimelineOperationKind.FileEdit,
            title = "src/main/App.kt",
            detail = "-old\n+new",
            status = TimelineOperationStatus.InProgress,
        )
        assertEquals("Editing App.kt", RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(edit))?.sentence)
    }

    @Test
    fun workingWithoutOperationFallsBackToPhaseAndTerminalClears() {
        assertEquals(
            "Planning the next step",
            RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, "planning", emptyList())?.sentence,
        )
        assertEquals(null, RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Other, null, emptyList()))
    }

    @Test
    fun groupedExploringActivityEmitsExploringVerbAndRespectsLifecycle() {
        val json = kotlinx.serialization.json.Json
        val active = json.parseToJsonElement(
            """{"state":"working","kind":"read","group":{"kind":"exploring","count":3}}""",
        ) as kotlinx.serialization.json.JsonObject
        val formatted = RunActionFormatter.fromServer(active)
        assertEquals("Exploring 3 items", formatted?.sentence)
        assertEquals(3, formatted?.groupedCount)
        assertEquals("exploring", formatted?.presentationVerb)

        val waiting = json.parseToJsonElement(
            """{"state":"working","kind":"read","group":{"kind":"exploring","count":3},"providerLiveness":{"phase":"awaiting_provider_output"}}""",
        ) as kotlinx.serialization.json.JsonObject
        val waitingFormatted = RunActionFormatter.fromServer(waiting)
        assertEquals("Exploring 3 items · waiting for provider output", waitingFormatted?.sentence)
        assertEquals(null, waitingFormatted?.presentationVerb)

        val completed = json.parseToJsonElement(
            """{"state":"completed","kind":"read","group":{"kind":"exploring","count":3}}""",
        ) as kotlinx.serialization.json.JsonObject
        val completedFormatted = RunActionFormatter.fromServer(completed)
        assertEquals("Completed", completedFormatted?.sentence)
        assertEquals(null, completedFormatted?.presentationVerb)
    }

    private fun format(command: String): RunActionUiState? = RunActionFormatter.forRun(
        status = RunActionFormatter.RunActionStatus.Working,
        phase = null,
        items = listOf(
            TimelineItem.Operation(
                id = "op-1",
                seq = 1,
                kind = TimelineOperationKind.Command,
                title = "Run command",
                detail = command,
                status = TimelineOperationStatus.InProgress,
            ),
        ),
    )
}
