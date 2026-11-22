package com.andysagent.ragent.core.protocol

import com.andysagent.ragent.core.model.AsyncQuestion
import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.model.Message
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class MessageMetadataSnapshot(
    val messageDelivery: String? = null,
    val asyncQuestionMessageId: String? = null,
    val asyncQuestions: List<AsyncQuestionDto> = emptyList(),
    val asyncQuestionsState: String? = null,
    val asyncQuestionReplies: List<AsyncQuestionReplyDto> = emptyList(),
    val answeredQuestionItemIds: List<String> = emptyList(),
)

fun SessionEventDto.resolvedMessageDelivery(): String? =
    messageDelivery?.takeIf { it.isNotBlank() } ?: delivery?.takeIf { it.isNotBlank() }

fun SessionEventDto.toMessageMetadataSnapshot(): MessageMetadataSnapshot? {
    val resolvedDelivery = resolvedMessageDelivery()
    val hasQuestions = asyncQuestions.isNotEmpty()
    val hasReplies = asyncQuestionReplies.isNotEmpty()
    val hasAnsweredIds = answeredQuestionItemIds.isNotEmpty()
    if (resolvedDelivery == null && asyncQuestionMessageId == null && !hasQuestions && asyncQuestionsState == null && !hasReplies && !hasAnsweredIds) {
        return null
    }
    return MessageMetadataSnapshot(
        messageDelivery = resolvedDelivery,
        asyncQuestionMessageId = asyncQuestionMessageId,
        asyncQuestions = asyncQuestions,
        asyncQuestionsState = asyncQuestionsState,
        asyncQuestionReplies = asyncQuestionReplies,
        answeredQuestionItemIds = answeredQuestionItemIds,
    )
}

fun SessionEventDto.encodeMessageMetadataJson(): String? =
    toMessageMetadataSnapshot()?.let { RagentProtocol.json.encodeToString(MessageMetadataSnapshot.serializer(), it) }

fun decodeMessageMetadataJson(metadataJson: String?): MessageMetadataSnapshot? {
    val raw = metadataJson?.trim().orEmpty()
    if (raw.isEmpty()) return null
    return runCatching { RagentProtocol.json.decodeFromString(MessageMetadataSnapshot.serializer(), raw) }.getOrNull()
}

fun encodeMessageMetadataSnapshot(snapshot: MessageMetadataSnapshot?): String? {
    if (snapshot == null) return null
    if (snapshot.messageDelivery == null &&
        snapshot.asyncQuestionMessageId == null &&
        snapshot.asyncQuestions.isEmpty() &&
        snapshot.asyncQuestionsState == null &&
        snapshot.asyncQuestionReplies.isEmpty() &&
        snapshot.answeredQuestionItemIds.isEmpty()
    ) {
        return null
    }
    return RagentProtocol.json.encodeToString(MessageMetadataSnapshot.serializer(), snapshot)
}

fun mergeMessageMetadataJson(existingJson: String?, incomingJson: String?): String? {
    val existing = decodeMessageMetadataJson(existingJson)
    val incoming = decodeMessageMetadataJson(incomingJson)
    if (existing == null && incoming == null) return null
    if (existing == null) return incomingJson
    if (incoming == null) return existingJson
    val mergedQuestions = if (incoming.asyncQuestions.isNotEmpty()) incoming.asyncQuestions else existing.asyncQuestions
    val mergedReplies = if (incoming.asyncQuestionReplies.isNotEmpty()) incoming.asyncQuestionReplies else existing.asyncQuestionReplies
    val mergedAnsweredIds = (existing.answeredQuestionItemIds + incoming.answeredQuestionItemIds).distinct()
    val merged = MessageMetadataSnapshot(
        messageDelivery = incoming.messageDelivery ?: existing.messageDelivery,
        asyncQuestionMessageId = incoming.asyncQuestionMessageId ?: existing.asyncQuestionMessageId,
        asyncQuestions = mergedQuestions,
        asyncQuestionsState = incoming.asyncQuestionsState ?: existing.asyncQuestionsState,
        asyncQuestionReplies = mergedReplies,
        answeredQuestionItemIds = mergedAnsweredIds,
    )
    return encodeMessageMetadataSnapshot(merged)
}

fun Message.withDecodedMetadata(metadataJson: String? = this.metadataJson): Message {
    val snapshot = decodeMessageMetadataJson(metadataJson)
    if (snapshot == null) return if (this.metadataJson == metadataJson) this else copy(metadataJson = metadataJson)
    return copy(
        metadataJson = metadataJson,
        messageDelivery = messageDelivery ?: snapshot.messageDelivery,
        asyncQuestionMessageId = asyncQuestionMessageId ?: snapshot.asyncQuestionMessageId,
        asyncQuestions = if (asyncQuestions.isNotEmpty()) asyncQuestions else snapshot.asyncQuestions.map { it.toDomain() },
        asyncQuestionsState = asyncQuestionsState ?: snapshot.asyncQuestionsState,
        asyncQuestionReplies = if (asyncQuestionReplies.isNotEmpty()) asyncQuestionReplies else snapshot.asyncQuestionReplies.map { it.toDomain() },
        answeredQuestionItemIds = if (answeredQuestionItemIds.isNotEmpty()) answeredQuestionItemIds else snapshot.answeredQuestionItemIds,
    )
}

/**
 * Index of answered async question items collected from user turns, used by both
 * durable `Message` lists and live `TimelineItem` projections without duplication.
 */
data class AsyncAnswerMatchSource(
    val text: String,
    val replies: List<AsyncQuestionReply> = emptyList(),
    val answeredIds: List<String> = emptyList(),
)

class AnsweredQuestionIndex internal constructor(
    private val answersById: Map<String, String>,
    private val answersByQuestionText: Map<String, String>,
    private val answeredIdsOnly: Set<String>,
) {
    val isEmpty: Boolean
        get() = answersById.isEmpty() && answersByQuestionText.isEmpty() && answeredIdsOnly.isEmpty()

    fun resolve(questions: List<AsyncQuestion>): Pair<List<AsyncQuestion>, Boolean> {
        if (questions.isEmpty() || isEmpty) return questions to false
        var changed = false
        val updated = questions.map { q ->
            val matchedById = answersById[q.id]
            val idMatchedOnly = q.id in answeredIdsOnly
            val matchedByText = if (matchedById == null && !idMatchedOnly) {
                answersByQuestionText[normalizeQuestionLookupKey(q.promptText)]
            } else {
                null
            }
            val resolvedAnswer = matchedById ?: matchedByText ?: q.answeredText
            val shouldBeAnswered = q.isAnswered || matchedById != null || idMatchedOnly || matchedByText != null
            if (shouldBeAnswered != q.isAnswered || resolvedAnswer != q.answeredText) {
                changed = true
                q.copy(
                    status = if (shouldBeAnswered) "answered" else q.status,
                    answeredText = resolvedAnswer,
                )
            } else {
                q
            }
        }
        return updated to changed
    }

    fun resolvedState(questions: List<AsyncQuestion>, fallbackState: String?): String? {
        if (questions.isEmpty()) return fallbackState
        val answeredCount = questions.count { it.isAnswered }
        return when {
            answeredCount == questions.size -> "answered"
            answeredCount > 0 -> "partial"
            else -> fallbackState ?: "pending"
        }
    }
}

fun buildAnsweredQuestionIndex(sources: List<AsyncAnswerMatchSource>): AnsweredQuestionIndex {
    val answersById = linkedMapOf<String, String>()
    val answersByQuestionText = linkedMapOf<String, String>()
    val answeredIdsOnly = linkedSetOf<String>()

    sources.forEach { src ->
        answeredIdsOnly.addAll(src.answeredIds.filter { it.isNotBlank() })
        src.replies.forEach { reply ->
            if (reply.questionItemId.isNotBlank()) {
                answersById[reply.questionItemId] = reply.answer
                answeredIdsOnly.add(reply.questionItemId)
            }
            if (reply.question.isNotBlank() && reply.answer.isNotBlank()) {
                answersByQuestionText[normalizeQuestionLookupKey(reply.question)] = reply.answer
            }
        }
        val parsed = QuestionReplyEnvelopeCodec.parse(src.text)
        parsed.replies.forEach { reply ->
            if (reply.questionItemId.isNotBlank()) {
                answersById[reply.questionItemId] = reply.answer
                answeredIdsOnly.add(reply.questionItemId)
            }
            if (reply.question.isNotBlank() && reply.answer.isNotBlank()) {
                answersByQuestionText[normalizeQuestionLookupKey(reply.question)] = reply.answer
            }
        }
    }
    return AnsweredQuestionIndex(answersById, answersByQuestionText, answeredIdsOnly)
}

/**
 * Deterministic cross-client reconciliation: resolves answered status for persisted
 * assistant async questions using structured user replies, `answeredQuestionItemIds`,
 * and `<send_user_message_question_reply>` envelopes carried on any user message.
 */
fun reconcileAsyncQuestionStatuses(messages: List<Message>): List<Message> {
    if (messages.none { it.asyncQuestions.isNotEmpty() }) return messages
    val index = buildAnsweredQuestionIndex(
        messages.filter { it.role.equals("user", ignoreCase = true) }.map {
            AsyncAnswerMatchSource(it.content, it.asyncQuestionReplies, it.answeredQuestionItemIds)
        },
    )
    if (index.isEmpty) return messages
    return messages.map { message ->
        if (message.asyncQuestions.isEmpty()) return@map message
        val (updated, changed) = index.resolve(message.asyncQuestions)
        if (!changed) message
        else message.copy(
            asyncQuestions = updated,
            asyncQuestionsState = index.resolvedState(updated, message.asyncQuestionsState),
        )
    }
}

private fun normalizeQuestionLookupKey(text: String): String =
    text.trim().lowercase().replace(Regex("\\s+"), " ")
