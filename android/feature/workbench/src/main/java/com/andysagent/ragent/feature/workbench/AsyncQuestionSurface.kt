package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.AsyncQuestion
import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.protocol.redactSecretText

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AsyncQuestionsCardContent(
    questions: List<AsyncQuestion>,
    submittingIds: Set<String>,
    onSubmitReplies: (List<AsyncQuestionReply>, String) -> Unit,
    modifier: Modifier = Modifier,
    collapsibleWhenAnswered: Boolean = true,
) {
    val colors = LocalRagentColors.current
    val allAnswered = questions.isNotEmpty() && questions.all { it.isAnswered }
    var answeredExpanded by rememberSaveable(questions.map { it.id }.joinToString("|")) { mutableStateOf(false) }

    if (collapsibleWhenAnswered && allAnswered) {
        val summaryLine = questions.joinToString(" · ") { q ->
            val rawAns = q.answeredText.orEmpty().trim()
            val safeAns = if (q.isSecret) redactSecretText(rawAns) else rawAns
            if (safeAns.isNotBlank()) "${q.promptText}: $safeAns" else q.promptText
        }
        Surface(
            modifier = modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .clickable { answeredExpanded = !answeredExpanded }
                .testTag("async-question-answered-chip"),
            shape = RoundedCornerShape(14.dp),
            color = colors.surfaceLow,
            border = BorderStroke(0.75.dp, colors.secondaryContent.copy(alpha = 0.14f)),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Check,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                        tint = colors.success,
                    )
                    Text(
                        text = "${stringResource(R.string.async_question_answered_prefix)} · $summaryLine",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.secondaryContent,
                        maxLines = if (answeredExpanded) Int.MAX_VALUE else 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
                AnimatedVisibility(visible = answeredExpanded) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        questions.forEach { q ->
                            val rawAns = q.answeredText.orEmpty().trim()
                            val safeAns = if (q.isSecret) redactSecretText(rawAns) else rawAns
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(q.promptText, style = MaterialTheme.typography.labelMedium, color = colors.primaryContent)
                                if (safeAns.isNotBlank()) {
                                    Text(safeAns, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                                }
                            }
                        }
                    }
                }
            }
        }
        return
    }

    val pendingQuestions = questions.filterNot { it.isAnswered }
    val selectedOptionById = remember(pendingQuestions.map { it.id }) { mutableStateMapOf<String, String>() }
    val customTextById = remember(pendingQuestions.map { it.id }) { mutableStateMapOf<String, String>() }
    val revealedSecrets = remember(pendingQuestions.map { it.id }) { mutableStateMapOf<String, Boolean>() }
    var trailingNote by remember(pendingQuestions.map { it.id }) { mutableStateOf("") }

    val isSubmitting = pendingQuestions.any { it.id in submittingIds }
    val readyReplies = pendingQuestions.mapNotNull { q ->
        val custom = customTextById[q.id].orEmpty().trim()
        val picked = selectedOptionById[q.id].orEmpty().trim()
        val answer = custom.ifBlank { picked }
        if (answer.isNotEmpty()) AsyncQuestionReply(q.id, q.promptText, answer) else null
    }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .testTag("async-question-pending-card"),
        shape = RoundedCornerShape(18.dp),
        color = colors.surfaceLow,
        border = BorderStroke(0.75.dp, colors.accentPrimary.copy(alpha = 0.28f)),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(50),
                color = colors.accentPrimary.copy(alpha = 0.12f),
            ) {
                Text(
                    text = stringResource(R.string.async_question_badge),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.accentPrimary,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }

            pendingQuestions.forEachIndexed { idx, q ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = q.promptText,
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.primaryContent,
                    )
                    if (q.options.isNotEmpty()) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            q.options.forEachIndexed { optIdx, opt ->
                                val selected = selectedOptionById[q.id] == opt.value && customTextById[q.id].isNullOrBlank()
                                FilterChip(
                                    selected = selected,
                                    onClick = {
                                        if (!isSubmitting) {
                                            if (selected) {
                                                selectedOptionById.remove(q.id)
                                            } else {
                                                selectedOptionById[q.id] = opt.value
                                                customTextById.remove(q.id)
                                            }
                                        }
                                    },
                                    enabled = !isSubmitting,
                                    label = { Text(opt.label) },
                                    modifier = Modifier.testTag("async-q-${idx}-opt-$optIdx"),
                                )
                            }
                        }
                    }
                    val showFreeText = q.allowFreeText || q.isOther == true || q.options.isEmpty()
                    if (showFreeText) {
                        val isRevealed = revealedSecrets[q.id] == true
                        OutlinedTextField(
                            value = customTextById[q.id].orEmpty(),
                            onValueChange = { value ->
                                customTextById[q.id] = value
                                if (value.isNotBlank()) selectedOptionById.remove(q.id)
                            },
                            enabled = !isSubmitting,
                            singleLine = q.isSecret,
                            visualTransformation = if (q.isSecret && !isRevealed) PasswordVisualTransformation() else VisualTransformation.None,
                            placeholder = { Text(stringResource(R.string.async_question_free_text_hint)) },
                            trailingIcon = if (q.isSecret) {
                                {
                                    IconButton(onClick = { revealedSecrets[q.id] = !isRevealed }) {
                                        Icon(
                                            imageVector = if (isRevealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                            contentDescription = stringResource(
                                                if (isRevealed) R.string.decision_secret_hide else R.string.decision_secret_reveal,
                                            ),
                                        )
                                    }
                                }
                            } else null,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("async-q-$idx-input"),
                        )
                    }
                }
            }

            if (pendingQuestions.size > 1) {
                OutlinedTextField(
                    value = trailingNote,
                    onValueChange = { trailingNote = it },
                    enabled = !isSubmitting,
                    placeholder = { Text(stringResource(R.string.async_question_note_hint)) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = {
                        if (readyReplies.isNotEmpty()) {
                            onSubmitReplies(readyReplies, trailingNote.trim())
                        }
                    },
                    enabled = !isSubmitting && readyReplies.isNotEmpty(),
                    shape = RoundedCornerShape(50),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.actionPrimary,
                        contentColor = colors.actionPrimaryContent,
                    ),
                    modifier = Modifier.heightIn(min = 44.dp).testTag("async-questions-send"),
                ) {
                    if (isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(15.dp).padding(end = 6.dp),
                            strokeWidth = 2.dp,
                            color = colors.actionPrimaryContent,
                        )
                    }
                    Text(
                        stringResource(
                            if (isSubmitting) R.string.async_question_sending else R.string.async_question_send_reply,
                        ),
                    )
                }
            }
        }
    }
}

@Composable
internal fun AsyncFollowupMessageCard(
    text: String,
    onQuickReply: (String) -> Unit,
    modifier: Modifier = Modifier,
    bodyContent: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .testTag("async-followup-card"),
        shape = RoundedCornerShape(16.dp),
        color = colors.surfaceLow,
        border = BorderStroke(0.75.dp, colors.accentPrimary.copy(alpha = 0.24f)),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = colors.accentPrimary.copy(alpha = 0.12f),
                ) {
                    Text(
                        text = stringResource(R.string.async_question_followup_badge),
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.accentPrimary,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
                TextButton(
                    onClick = { onQuickReply(text) },
                    modifier = Modifier.testTag("async-followup-quick-reply"),
                ) {
                    Text(stringResource(R.string.async_question_quick_reply))
                }
            }
            bodyContent()
        }
    }
}

@Composable
internal fun ReplyEnvelopeChips(
    replies: List<AsyncQuestionReply>,
    malformed: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(50),
            color = colors.accentPrimary.copy(alpha = 0.14f),
        ) {
            Text(
                text = stringResource(R.string.async_question_reply_badge),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = colors.accentPrimary,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
        if (replies.isNotEmpty()) {
            replies.forEach { reply ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.canvas.copy(alpha = 0.5f))
                        .border(0.5.dp, colors.secondaryContent.copy(alpha = 0.16f), RoundedCornerShape(10.dp))
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    if (reply.question.isNotBlank()) {
                        Text(
                            text = reply.question,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = reply.answer,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                        color = colors.primaryContent,
                    )
                }
            }
        } else if (malformed) {
            Text(
                text = stringResource(R.string.async_question_answered_prefix),
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryContent,
            )
        }
    }
}
