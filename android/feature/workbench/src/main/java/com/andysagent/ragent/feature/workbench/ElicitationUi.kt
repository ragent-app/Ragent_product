package com.andysagent.ragent.feature.workbench

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.ElicitationKind
import com.andysagent.ragent.core.model.ElicitationPayload
import com.andysagent.ragent.core.model.ElicitationSchemaProperty
import com.andysagent.ragent.core.protocol.ElicitationFormValidationResult
import com.andysagent.ragent.core.protocol.isHttpOrHttpsUrl
import com.andysagent.ragent.core.protocol.urlOriginHost
import com.andysagent.ragent.core.protocol.validateAndBuildElicitationContent

@Stable
class ElicitationFormState(
    properties: List<ElicitationSchemaProperty>,
) {
    val textValues = mutableStateMapOf<String, String>()
    val booleanValues = mutableStateMapOf<String, Boolean>()
    val multiSelectValues = mutableStateMapOf<String, Set<String>>()
    val revealedSecrets = mutableStateMapOf<String, Boolean>()
    var hasOpenedExternalLink by mutableStateOf(false)
    var openLinkError by mutableStateOf<String?>(null)

    init {
        properties.forEach { prop ->
            if (prop.type == "boolean") {
                booleanValues[prop.name] = prop.defaultBoolean ?: false
            } else if (!prop.defaultValue.isNullOrEmpty()) {
                textValues[prop.name] = prop.defaultValue!!
            }
        }
    }

    fun validate(properties: List<ElicitationSchemaProperty>): ElicitationFormValidationResult =
        validateAndBuildElicitationContent(properties, textValues, booleanValues, multiSelectValues)
}

@Composable
internal fun rememberElicitationFormState(elicitation: ElicitationPayload): ElicitationFormState =
    remember(elicitation.elicitationId, elicitation.requestedSchemaJson, elicitation.url, elicitation.mode) {
        ElicitationFormState(elicitation.schemaProperties)
    }

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ElicitationContent(
    elicitation: ElicitationPayload,
    formState: ElicitationFormState,
    resolving: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val server = elicitation.serverName?.takeIf { it.isNotBlank() }
        if (server != null || elicitation.resolvedKind == ElicitationKind.ExternalUrl) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (server != null) {
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = colors.accentPrimary.copy(alpha = 0.12f),
                    ) {
                        Text(
                            text = server,
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.accentPrimary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
                if (elicitation.resolvedKind == ElicitationKind.ExternalUrl) {
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = colors.secondaryContent.copy(alpha = 0.12f),
                    ) {
                        Text(
                            text = stringResource(R.string.elicitation_external_auth),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }

        val promptMessage = elicitation.message?.takeIf { it.isNotBlank() }
            ?: elicitation.description?.takeIf { it.isNotBlank() }
            ?: elicitation.title?.takeIf { it.isNotBlank() }
        if (promptMessage != null) {
            Text(
                text = promptMessage,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.primaryContent,
            )
        }

        when (elicitation.resolvedKind) {
            ElicitationKind.CompactToolApproval -> Unit
            ElicitationKind.DynamicForm -> {
                val validation = formState.validate(elicitation.schemaProperties)
                elicitation.schemaProperties.forEach { prop ->
                    ElicitationSchemaField(
                        prop = prop,
                        formState = formState,
                        errorText = validation.fieldErrors[prop.name],
                        enabled = !resolving,
                    )
                }
            }
            ElicitationKind.ExternalUrl -> {
                val rawUrl = elicitation.url.orEmpty()
                val validUrl = isHttpOrHttpsUrl(rawUrl)
                val originHost = urlOriginHost(rawUrl)
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = colors.surfaceHigh,
                    border = BorderStroke(0.75.dp, colors.secondaryContent.copy(alpha = 0.16f)),
                    modifier = Modifier.fillMaxWidth().testTag("elicitation-url-card"),
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (originHost != null) {
                            Text(
                                text = originHost,
                                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                                color = colors.accentPrimary,
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = rawUrl,
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.secondaryContent,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(
                                onClick = { if (rawUrl.isNotBlank()) clipboard.setText(AnnotatedString(rawUrl)) },
                                enabled = rawUrl.isNotBlank(),
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.ContentCopy,
                                    contentDescription = stringResource(R.string.elicitation_copy_url),
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                        if (!validUrl) {
                            Text(
                                text = stringResource(R.string.elicitation_invalid_url),
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.error,
                            )
                        } else {
                            val failedMessage = stringResource(R.string.elicitation_open_link_failed)
                            OutlinedButton(
                                onClick = {
                                    formState.openLinkError = null
                                    runCatching {
                                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl))
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        context.startActivity(intent)
                                        formState.hasOpenedExternalLink = true
                                    }.onFailure {
                                        formState.openLinkError = failedMessage
                                    }
                                },
                                enabled = !resolving,
                                modifier = Modifier.testTag("elicitation-open-link"),
                            ) {
                                Icon(Icons.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(stringResource(R.string.elicitation_open_link))
                            }
                        }
                        formState.openLinkError?.let { err ->
                            Text(text = err, style = MaterialTheme.typography.bodySmall, color = colors.error)
                        }
                    }
                }
            }
            ElicitationKind.Unsupported -> {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = colors.error.copy(alpha = 0.08f),
                    border = BorderStroke(0.75.dp, colors.error.copy(alpha = 0.25f)),
                    modifier = Modifier.fillMaxWidth().testTag("elicitation-unsupported-banner"),
                ) {
                    Text(
                        text = stringResource(
                            R.string.elicitation_unsupported_mode,
                            elicitation.mode?.takeIf { it.isNotBlank() } ?: "unknown",
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.primaryContent,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ElicitationSchemaField(
    prop: ElicitationSchemaProperty,
    formState: ElicitationFormState,
    errorText: String?,
    enabled: Boolean,
) {
    val colors = LocalRagentColors.current
    val baseLabel = prop.title?.takeIf { it.isNotBlank() } ?: prop.name
    val label = if (prop.required) "$baseLabel *" else baseLabel

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            prop.type == "boolean" -> {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent)
                        prop.description?.takeIf { it.isNotBlank() }?.let { desc ->
                            Text(desc, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                        }
                    }
                    Switch(
                        checked = formState.booleanValues[prop.name] ?: prop.defaultBoolean ?: false,
                        onCheckedChange = { formState.booleanValues[prop.name] = it },
                        enabled = enabled,
                        modifier = Modifier.testTag("elicitation-field-${prop.name}"),
                    )
                }
            }
            prop.enumValues.isNotEmpty() -> {
                Text(label, style = MaterialTheme.typography.labelMedium, color = colors.primaryContent)
                prop.description?.takeIf { it.isNotBlank() }?.let { desc ->
                    Text(desc, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                }
                val currentValue = formState.textValues[prop.name] ?: prop.defaultValue.orEmpty()
                if (prop.enumValues.size <= 4) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        prop.enumValues.forEach { choice ->
                            FilterChip(
                                selected = currentValue == choice,
                                onClick = { formState.textValues[prop.name] = choice },
                                enabled = enabled,
                                label = { Text(choice) },
                                modifier = Modifier.testTag("elicitation-field-${prop.name}-$choice"),
                            )
                        }
                    }
                } else {
                    var menuOpen by remember { mutableStateOf(false) }
                    Box {
                        OutlinedButton(
                            onClick = { menuOpen = true },
                            enabled = enabled,
                            modifier = Modifier.fillMaxWidth().testTag("elicitation-field-${prop.name}"),
                        ) {
                            Text(currentValue.ifBlank { label }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            prop.enumValues.forEach { choice ->
                                DropdownMenuItem(
                                    text = { Text(choice) },
                                    onClick = {
                                        formState.textValues[prop.name] = choice
                                        menuOpen = false
                                    },
                                )
                            }
                        }
                    }
                }
            }
            prop.type == "array" && prop.arrayItemEnumValues.isNotEmpty() -> {
                Text(label, style = MaterialTheme.typography.labelMedium, color = colors.primaryContent)
                val selected = formState.multiSelectValues[prop.name].orEmpty()
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    prop.arrayItemEnumValues.forEach { choice ->
                        val isChosen = choice in selected
                        FilterChip(
                            selected = isChosen,
                            onClick = {
                                formState.multiSelectValues[prop.name] =
                                    if (isChosen) selected - choice else selected + choice
                            },
                            enabled = enabled,
                            label = { Text(choice) },
                        )
                    }
                }
            }
            else -> {
                val isRevealed = formState.revealedSecrets[prop.name] == true
                val keyboardType = when {
                    prop.type == "integer" -> KeyboardType.Number
                    prop.type == "number" -> KeyboardType.Decimal
                    prop.format.equals("uri", ignoreCase = true) -> KeyboardType.Uri
                    prop.format.equals("email", ignoreCase = true) -> KeyboardType.Email
                    prop.isSecretField -> KeyboardType.Password
                    else -> KeyboardType.Text
                }
                val isMultiline = prop.type == "object" || ((prop.maxLength ?: 0) > 120)
                val placeholderText = when (prop.type) {
                    "object" -> stringResource(R.string.elicitation_json_object_hint)
                    "array" -> stringResource(R.string.elicitation_array_hint)
                    else -> prop.description
                }
                OutlinedTextField(
                    value = formState.textValues[prop.name] ?: prop.defaultValue.orEmpty(),
                    onValueChange = { formState.textValues[prop.name] = it },
                    enabled = enabled,
                    label = { Text(label) },
                    placeholder = placeholderText?.let { hint -> { Text(hint) } },
                    isError = errorText != null,
                    singleLine = !isMultiline,
                    minLines = if (prop.type == "object") 3 else 1,
                    keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                    visualTransformation = if (prop.isSecretField && !isRevealed) PasswordVisualTransformation() else VisualTransformation.None,
                    trailingIcon = if (prop.isSecretField) {
                        {
                            IconButton(onClick = { formState.revealedSecrets[prop.name] = !isRevealed }) {
                                Icon(
                                    imageVector = if (isRevealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                    contentDescription = stringResource(
                                        if (isRevealed) R.string.decision_secret_hide else R.string.decision_secret_reveal,
                                    ),
                                )
                            }
                        }
                    } else null,
                    modifier = Modifier.fillMaxWidth().testTag("elicitation-field-${prop.name}"),
                )
            }
        }
        if (errorText != null) {
            Text(text = errorText, style = MaterialTheme.typography.bodySmall, color = colors.error)
        }
    }
}

@Composable
internal fun ElicitationActionBar(
    elicitation: ElicitationPayload,
    formState: ElicitationFormState,
    resolving: Boolean,
    onSubmitAction: (action: String, contentJson: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val kind = elicitation.resolvedKind
    val validation = if (kind == ElicitationKind.DynamicForm) formState.validate(elicitation.schemaProperties) else null
    val acceptEnabled = when (kind) {
        ElicitationKind.DynamicForm -> validation?.isValid == true
        ElicitationKind.ExternalUrl -> isHttpOrHttpsUrl(elicitation.url)
        ElicitationKind.Unsupported -> false
        ElicitationKind.CompactToolApproval -> true
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { onSubmitAction("decline", null) },
                enabled = !resolving,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("elicitation-decline"),
            ) {
                Text(stringResource(R.string.elicitation_decline), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (kind != ElicitationKind.Unsupported) {
                Button(
                    onClick = {
                        val contentJson = if (kind == ElicitationKind.DynamicForm) validation?.contentJson else "{}"
                        onSubmitAction("accept", contentJson)
                    },
                    enabled = !resolving && acceptEnabled,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.actionPrimary,
                        contentColor = colors.actionPrimaryContent,
                    ),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("elicitation-accept"),
                ) {
                    Text(stringResource(R.string.elicitation_accept), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        TextButton(
            onClick = { onSubmitAction("cancel", null) },
            enabled = !resolving,
            modifier = Modifier.align(Alignment.End).testTag("elicitation-cancel"),
        ) {
            Text(stringResource(R.string.elicitation_cancel), color = colors.secondaryContent)
        }
    }
}
