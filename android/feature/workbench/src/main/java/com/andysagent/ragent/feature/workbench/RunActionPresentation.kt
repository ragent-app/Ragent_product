package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.andysagent.ragent.core.timeline.RunActionUiState

/** Provider-written prose remains verbatim; only our own templates are localized. */
@Composable
internal fun presentRunAction(action: RunActionUiState): String {
    val subject = presentActionSubject(action.presentationSubject.ifBlank { if (action.presentationVerb == "execute") "command" else "" })
    val text = when (action.presentationVerb) {
        "read" -> stringResource(R.string.run_action_read, subject)
        "list" -> stringResource(R.string.run_action_list, subject)
        "search" -> stringResource(R.string.run_action_search, subject)
        "inspect" -> stringResource(R.string.run_action_inspect, subject)
        "edit" -> stringResource(R.string.run_action_edit, subject)
        "delete" -> stringResource(R.string.run_action_delete, subject)
        "execute" -> stringResource(R.string.run_action_execute, subject)
        "delegate" -> stringResource(R.string.run_action_delegate, subject)
        "tool" -> stringResource(R.string.run_action_tool, subject)
        "exploring" -> pluralStringResource(R.plurals.run_action_exploring_items, action.groupedCount, action.groupedCount)
        "working" -> stringResource(R.string.run_action_working)
        "question" -> stringResource(R.string.run_action_question)
        "thinking" -> stringResource(R.string.run_action_thinking)
        "planning" -> stringResource(R.string.run_action_planning)
        "starting" -> stringResource(R.string.run_action_starting)
        "approval" -> stringResource(R.string.run_action_approval)
        "web_search" -> stringResource(R.string.run_web_search)
        "web_open" -> stringResource(R.string.run_web_open)
        "web_find" -> stringResource(R.string.run_web_find)
        "web_mixed" -> stringResource(R.string.run_web_mixed)
        "web_generic" -> stringResource(R.string.run_web_generic)
        else -> action.sentence
    }
    return action.turnProgressText?.takeIf { it.isNotBlank() }
        ?.let { stringResource(R.string.run_turn_progress, text, it) } ?: text
}

@Composable
internal fun presentCompletedAction(action: RunActionUiState): String {
    val subject = presentActionSubject(action.presentationSubject.ifBlank { if (action.presentationVerb == "execute") "command" else "" })
    return when (action.presentationVerb) {
        "read" -> stringResource(R.string.run_action_done_read, subject)
        "list" -> stringResource(R.string.run_action_done_list, subject)
        "search" -> stringResource(R.string.run_action_done_search, subject)
        "inspect" -> stringResource(R.string.run_action_done_inspect, subject)
        "edit" -> stringResource(R.string.run_action_done_edit, subject)
        "delete" -> stringResource(R.string.run_action_done_delete, subject)
        "execute" -> stringResource(R.string.run_action_done_execute, subject)
        "question" -> stringResource(R.string.run_action_done_question)
        "delegate" -> stringResource(R.string.run_action_done_delegate, subject)
        "tool" -> stringResource(R.string.run_action_done_tool, subject)
        else -> stringResource(R.string.run_action_done_generic)
    }
}

@Composable
internal fun presentFailedAction(action: RunActionUiState): String {
    val subject = presentActionSubject(action.presentationSubject.ifBlank { if (action.presentationVerb == "execute") "command" else "" })
    return when (action.presentationVerb) {
        "delete" -> stringResource(R.string.run_action_failed_delete, subject)
        "execute" -> stringResource(R.string.run_action_failed_execute, subject)
        else -> stringResource(R.string.run_action_failed_generic)
    }
}

@Composable
private fun presentActionSubject(subject: String): String = when (subject.lowercase()) {
    "command" -> stringResource(R.string.run_subject_command)
    "workspace" -> stringResource(R.string.run_subject_workspace)
    "file" -> stringResource(R.string.run_subject_file)
    "the task" -> stringResource(R.string.run_subject_task)
    "workspace changes" -> stringResource(R.string.run_subject_changes)
    "current location" -> stringResource(R.string.run_subject_current_location)
    else -> subject
}
