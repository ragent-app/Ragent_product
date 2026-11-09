package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.network.ApiException
import kotlinx.coroutines.CancellationException

/**
 * Shared plain-approval resolution used by surfaces outside the session
 * timeline. Every submission re-reads the pending approval from the
 * repository first: a stale FCM payload or an expired row must never drive a
 * side effect. Batch and passkey resolutions stay inside their session's
 * structured card, so this coordinator refuses them instead of building a
 * parallel approval protocol.
 */
class ApprovalResolutionCoordinator(private val repository: SessionRepository) {

    sealed interface Outcome {
        /** The re-validated approval was submitted through the plain path. */
        data object Submitted : Outcome

        /** The approval no longer exists or is not pending anymore. */
        data object Stale : Outcome

        /** The item requires the session's structured card (batch/passkey). */
        data object RequiresSession : Outcome

        /** The submission failed; the message is user-presentable. */
        data class Failed(val message: String) : Outcome
    }

    /** Result of the mandatory re-read that gates every submission. */
    private sealed interface PendingRead {
        data class Found(val approval: Approval) : PendingRead
        data object Missing : PendingRead
        data class Error(val message: String) : PendingRead
    }

    /**
     * Re-reads [approvalId], validates that it is still a pending plain
     * approval, and submits [approve] through the repository path the session
     * card itself uses.
     */
    suspend fun resolvePlainApproval(
        sessionId: String,
        approvalId: String,
        approve: Boolean,
        requestId: String = newRequestId(),
    ): Outcome {
        return when (val read = readPending(sessionId, approvalId)) {
            is PendingRead.Error -> Outcome.Failed(read.message)
            is PendingRead.Missing -> Outcome.Stale
            is PendingRead.Found -> {
                val pending = read.approval
                if (pending.status != "pending") return Outcome.Stale
                if (pending.requiresStructuredResolution()) return Outcome.RequiresSession
                val decision = if (approve) "approve" else "deny"
                try {
                    val runId = pending.runId
                    if (runId != null) {
                        repository.resolveRuntimeApproval(
                            runId = runId,
                            approvalId = approvalId,
                            decision = decision,
                            requestId = requestId,
                        )
                    } else {
                        repository.decideConfirmation(
                            sessionId = sessionId,
                            confirmationId = approvalId,
                            decision = decision,
                            requestId = requestId,
                        )
                    }
                    runCatching { repository.refreshSessionDetail(sessionId) }
                    retireResolvedApproval(sessionId, approvalId)
                    Outcome.Submitted
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (error.isTerminalApprovalFailure()) return retireStaleApproval(sessionId, approvalId, error)
                    Outcome.Failed(error.message ?: "审批提交失败")
                }
            }
        }
    }

    /**
     * Resolves an ask-user approval with an explicit answer: either the tapped
     * [optionIndex] of question [questionIndex], or a typed [customAnswer].
     * The server contract carries per-question selected option indices with
     * -1 for unanswered questions, so the chosen option is positioned and the
     * rest stay explicitly unanswered instead of being dropped. A re-read that
     * shows the target is no longer a pending question fails closed — a tap on
     * the overlay must never submit an unanswerable approval.
     */
    suspend fun resolveQuestionApproval(
        sessionId: String,
        approvalId: String,
        questionIndex: Int,
        optionIndex: Int?,
        customAnswer: String = "",
        requestId: String = newRequestId(),
    ): Outcome {
        return resolveQuestionChoices(
            sessionId = sessionId,
            approvalId = approvalId,
            choices = emptyList(),
            customAnswer = customAnswer,
            singleQuestionIndex = questionIndex,
            singleOptionIndex = optionIndex,
            requestId = requestId,
        )
    }

    /**
     * Resolves every question in one approval response. The list is positional:
     * each entry is an option index, or -1 when that question uses a custom
     * answer. Per-question answers use an explicit server capability decision.
     */
    suspend fun resolveQuestionsApproval(
        sessionId: String,
        approvalId: String,
        choices: List<Int>,
        customAnswer: String = "",
        requestId: String = newRequestId(),
        customAnswers: List<String> = emptyList(),
    ): Outcome {
        return resolveQuestionChoices(
            sessionId = sessionId,
            approvalId = approvalId,
            choices = choices,
            customAnswer = customAnswer,
            customAnswers = customAnswers,
            requestId = requestId,
        )
    }

    suspend fun resolveMultiChoiceQuestions(
        sessionId: String, approvalId: String, selections: List<List<Int>>, customAnswers: List<String>,
        requestId: String = newRequestId(),
    ): Outcome {
        val read = readPending(sessionId, approvalId)
        if (read is PendingRead.Error) return Outcome.Failed(read.message)
        if (read !is PendingRead.Found || read.approval.status != "pending") return Outcome.Stale
        val pending = read.approval
        if (pending.requiresStructuredResolution() || !pending.isQuestionApproval()) return Outcome.RequiresSession
        val questions = pending.resolutionQuestions()
        if (questions.isEmpty() || selections.size != questions.size || customAnswers.size != questions.size) return Outcome.Failed("问题回答不完整")
        val answers = customAnswers.map { it.trim().take(MAX_CUSTOM_ANSWER) }
        for (index in questions.indices) {
            val question = questions[index]
            val selected = selections[index]
            if (selected.distinct().size != selected.size || selected.any { it !in question.options.indices } ||
                (!question.isMultiSelect && (selected.size > 1 || (selected.isNotEmpty() && answers[index].isNotEmpty()))) ||
                (selected.isEmpty() && answers[index].isEmpty())) return Outcome.Failed("问题回答无效")
        }
        val runId = pending.runId ?: return Outcome.Failed("当前会话不支持多选回答")
        return try {
            repository.resolveRuntimeApprovalWithMultiChoices(runId, approvalId, selections, answers, requestId)
            runCatching { repository.refreshSessionDetail(sessionId) }
            retireResolvedApproval(sessionId, approvalId)
            Outcome.Submitted
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            if (error.isTerminalApprovalFailure()) return retireStaleApproval(sessionId, approvalId, error)
            Outcome.Failed(error.message ?: "提交回答失败")
        }
    }

    private suspend fun resolveQuestionChoices(
        sessionId: String,
        approvalId: String,
        choices: List<Int>,
        customAnswer: String,
        customAnswers: List<String> = emptyList(),
        singleQuestionIndex: Int? = null,
        singleOptionIndex: Int? = null,
        requestId: String,
    ): Outcome {
        return when (val read = readPending(sessionId, approvalId)) {
            is PendingRead.Error -> Outcome.Failed(read.message)
            is PendingRead.Missing -> Outcome.Stale
            is PendingRead.Found -> {
                val pending = read.approval
                if (pending.status != "pending") return Outcome.Stale
                if (pending.requiresStructuredResolution() || !pending.isQuestionApproval()) {
                    return Outcome.RequiresSession
                }
                val answer = customAnswer.trim().take(MAX_CUSTOM_ANSWER)
                val questions = pending.resolutionQuestions()
                val questionCount = questions.size.coerceAtLeast(1)
                val normalizedChoices = if (singleQuestionIndex != null) {
                    if (singleQuestionIndex !in 0 until questionCount) return Outcome.Failed("问题序号无效")
                    List(questionCount) { index ->
                        if (index == singleQuestionIndex) singleOptionIndex ?: -1 else -1
                    }
                } else {
                    if (choices.size != questionCount) return Outcome.Failed("问题回答不完整")
                    choices
                }
                normalizedChoices.forEachIndexed { index, choice ->
                    if (choice < -1) return Outcome.Failed("所选选项不存在")
                    val options = questions.getOrNull(index)?.options.orEmpty()
                    if (choice >= options.size) return Outcome.Failed("所选选项不存在")
                }
                if (customAnswers.isNotEmpty() && customAnswers.size != questionCount) return Outcome.Failed("问题回答不完整")
                val answers = List(questionCount) { index -> customAnswers.getOrNull(index).orEmpty().trim().take(MAX_CUSTOM_ANSWER) }
                val unanswered = normalizedChoices.indices.filter { normalizedChoices[it] == -1 }
                if (unanswered.size > 1 && customAnswers.isEmpty() && answer.isNotEmpty()) {
                    return Outcome.Failed("自定义回复只能回答一个问题")
                }
                if (unanswered.any { answers[it].isEmpty() && (answer.isEmpty() || unanswered.size != 1) }) {
                    return Outcome.Failed("请回答所有问题")
                }
                val submittedAnswer = unanswered.singleOrNull()?.let { answers[it].ifEmpty { answer } }?.takeIf(String::isNotEmpty)
                try {
                    val runId = pending.runId
                    if (runId != null) {
                        if (unanswered.size > 1) {
                            repository.resolveRuntimeApprovalWithAnswers(runId, approvalId, normalizedChoices.map(Int::toString), answers, requestId)
                        } else {
                            repository.resolveRuntimeApproval(
                                runId = runId, approvalId = approvalId, decision = "approve",
                                choices = normalizedChoices.map(Int::toString), customAnswer = submittedAnswer, requestId = requestId,
                            )
                        }
                    } else {
                        if (unanswered.size > 1) return Outcome.Failed("当前会话不支持逐题自定义回复")
                        // Legacy session confirmations carry no question payload;
                        // the resolution still re-validates before approving.
                        repository.decideConfirmation(
                            sessionId = sessionId,
                            confirmationId = approvalId,
                            decision = "approve",
                            requestId = requestId,
                        )
                    }
                    runCatching { repository.refreshSessionDetail(sessionId) }
                    retireResolvedApproval(sessionId, approvalId)
                    Outcome.Submitted
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (error.isTerminalApprovalFailure()) return retireStaleApproval(sessionId, approvalId, error)
                    Outcome.Failed(error.message ?: "回答提交失败")
                }
            }
        }
    }

    private suspend fun readPending(sessionId: String, approvalId: String): PendingRead = try {
        repository.findPendingApproval(sessionId, approvalId)
            ?.let { PendingRead.Found(it) }
            ?: PendingRead.Missing
    } catch (error: Throwable) {
        PendingRead.Error(error.message ?: "审批状态读取失败")
    }

    private suspend fun retireStaleApproval(sessionId: String, approvalId: String, cause: Throwable): Outcome = try {
        repository.retireStaleApproval(sessionId, approvalId)
        runCatching { repository.refreshSessionDetail(sessionId) }
        Outcome.Stale
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        Outcome.Failed(error.message ?: cause.message ?: "过期审批无法清理")
    }

    /** A successful server response owns the decision; clear its pending local projection too. */
    private suspend fun retireResolvedApproval(sessionId: String, approvalId: String) {
        try {
            repository.retireStaleApproval(sessionId, approvalId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The server has already accepted the decision. A local cache cleanup
            // failure must not turn that success into a retryable submission error.
        }
    }

    private fun Approval.requiresStructuredResolution(): Boolean = batchId != null ||
        actions.any { it.needsPasskey } ||
        (passkeyRequired && !isQuestionApproval())

    private fun Approval.isQuestionApproval(): Boolean = kind.equals("question", ignoreCase = true) || questions.isNotEmpty()

    private fun Approval.resolutionQuestions(): List<ApprovalQuestion> {
        if (questions.isNotEmpty()) return questions
        val prompt = reason?.trim()?.takeIf { it.isNotEmpty() } ?: title.trim()
        if (options.isEmpty() && prompt.isEmpty()) return emptyList()
        return listOf(
            ApprovalQuestion(
                question = prompt,
                options = options.map { ApprovalOption(it) },
                isMultiSelect = isMultiSelect,
            ),
        )
    }

    private companion object {
        const val MAX_CUSTOM_ANSWER = 8_000
    }
}

/** Server-confirmed terminal approval failures should remove stale UI, not offer retry. */
fun Throwable.isTerminalApprovalFailure(): Boolean {
    val code = when (this) {
        is ApiException -> code
        is SessionRepositoryException -> code
        else -> null
    }
    return code in TERMINAL_APPROVAL_FAILURE_CODES
}

private val TERMINAL_APPROVAL_FAILURE_CODES = setOf(
    "RUN_TERMINAL",
    "RUN_NOT_FOUND",
    "APPROVAL_NOT_FOUND",
    "APPROVED_ACTION_RUN_TERMINAL",
    "APPROVED_ACTION_RUN_NOT_FOUND",
    "BROKER_RUN_NOT_ACTIVE",
    "BROKER_RUN_NOT_FOUND",
)
