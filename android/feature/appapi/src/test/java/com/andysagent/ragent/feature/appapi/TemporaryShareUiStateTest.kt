package com.andysagent.ragent.feature.appapi

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TemporaryShareUiStateTest {
    private val runtimes = listOf(TemporaryShareRuntime("claude-bidi", "Claude Code", ready = true))

    @Test fun `files can be confirmed when temporary target and instruction are ready`() {
        assertTrue(canSubmitTemporaryShare(TemporaryShareUiState(
            selectedInstanceId = "pc-a", runtimes = runtimes, selectedRuntimeId = "claude-bidi",
            filesPresent = true, ready = true, instruction = "Inspect these files")))
    }

    @Test fun `text can be confirmed with existing target requirements`() {
        assertTrue(canSubmitTemporaryShare(TemporaryShareUiState(
            selectedInstanceId = "pc-a", runtimes = runtimes, selectedRuntimeId = "claude-bidi",
            sharedText = "hello", ready = true, instruction = "Summarize")))
    }

    @Test fun `empty shares and missing instructions cannot be submitted`() {
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a", ready = true, instruction = "Do it")))
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a", filesPresent = true, ready = true)))
    }

    @Test fun `multiple recoverable computers require an explicit choice`() {
        val targets = listOf(
            TemporaryShareTarget("pc-a", "Computer A", "10:30", ready = true),
            TemporaryShareTarget("pc-b", "Computer B", "10:31", ready = true),
        )
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(
            targets = targets, sharedText = "hello", instruction = "Summarize", ready = false)))
        assertTrue(canSubmitTemporaryShare(TemporaryShareUiState(
            targets = targets, runtimes = runtimes, selectedRuntimeId = "claude-bidi",
            selectedInstanceId = "pc-b", sharedText = "hello", instruction = "Summarize", ready = true)))
    }

    @Test fun `runtime must be explicitly selected and configured before a new share`() {
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a",
            runtimes = listOf(TemporaryShareRuntime("codex", "CodeX", ready = false)),
            sharedText = "hello", instruction = "Summarize", ready = true)))
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a",
            runtimes = runtimes, sharedText = "hello", instruction = "Summarize", ready = true)))
    }

    @Test fun `busy disconnected and already accepted shares are disabled`() {
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a", filesPresent = true, ready = false, instruction = "Inspect")))
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a", filesPresent = true, ready = true,
            busy = true, instruction = "Inspect")))
        assertFalse(canSubmitTemporaryShare(TemporaryShareUiState(selectedInstanceId = "pc-a", filesPresent = true, ready = true,
            instruction = "Inspect", runId = "run-1")))
    }
}
