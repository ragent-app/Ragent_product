package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.AttentionItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal data class ApprovalPresentation(val headline: String, val consequence: String?)

/** Suppress descriptions that merely instruct the user to choose the label itself. */
internal fun questionOptionDetail(label: String, description: String?): String? {
    val detail = description?.trim()?.takeIf(String::isNotEmpty) ?: return null
    fun normalized(value: String) = value.trim().trim('.', '!', '。', '"', '\'', '“', '”', '`').trim().lowercase()
    if (normalized(detail) == normalized(label)) return null
    val instruction = Regex("^(?:choose|select|pick)\\s+(.+?)\\s+as\\s+(?:the|your)\\s+answer[.!。]?$", RegexOption.IGNORE_CASE)
        .matchEntire(detail)?.groupValues?.get(1)
    return detail.takeUnless { instruction != null && normalized(instruction) == normalized(label) }
}

/** Display actual operation and consequence once; never infer safety or effects. */
internal fun approvalPresentation(item: AttentionItem): ApprovalPresentation {
    fun String?.value() = this?.trim()?.takeIf(String::isNotEmpty)
    val approval = item.approval
    val singleAction = approval?.actions?.singleOrNull()
    val headline = sequenceOf(
        approval?.explanation?.summary?.takeIf { approval.explanation?.operation != null },
        singleAction?.explanation?.summary?.takeIf { singleAction.explanation?.operation != null },
        singleAction?.summary,
        singleAction?.description,
        approval?.reason, approval?.explanation?.summary, item.summary, approval?.title, item.title,
    ).mapNotNull { it.value() }.firstOrNull().orEmpty()
    val consequence = sequenceOf(approval?.explanation?.reason, approval?.reason, item.reason, item.summary)
        .mapNotNull { it.value() }.firstOrNull { it != headline }
    return ApprovalPresentation(headline, consequence)
}

internal fun attentionDisclosureHeight(fullHeight: Int, progress: Float): Int =
    (fullHeight.coerceAtLeast(0) * progress.coerceIn(0f, 1f)).toInt()

internal data class ApprovalDetail(val label: Int?, val value: String)

internal fun approvalPermissionDetails(value: String?): List<ApprovalDetail> {
    val permissions = runCatching { Json.parseToJsonElement(value.orEmpty()) as? JsonObject }.getOrNull() ?: return emptyList()
    return buildList {
        val network = permissions["network"] as? JsonObject
        if ((network?.get("enabled") as? JsonPrimitive)?.booleanOrNull == true) {
            add(ApprovalDetail(R.string.approval_scope_network, ""))
        }
        val files = permissions["fileSystem"] as? JsonObject
        listOf("read" to R.string.approval_scope_read, "write" to R.string.approval_scope_write,
            "entries" to R.string.approval_scope_entry).forEach { (key, label) ->
            (files?.get(key) as? JsonArray)?.forEach { entry ->
                val text = when (entry) {
                    is JsonPrimitive -> entry.contentOrNull
                    is JsonObject -> if (entry.size == 1) (entry["path"] as? JsonPrimitive)?.contentOrNull ?: entry.toString() else entry.toString()
                    else -> entry.toString()
                }
                text?.takeIf(String::isNotBlank)?.let { add(ApprovalDetail(label, it)) }
            }
        }
        // Claude's suggestions describe optional future permission updates, not
        // the scope of a one-time approval. They are only applied by the
        // separate approve-for-session decision, which this card does not offer.
        val additional = permissions.filterKeys { it != "network" && it != "fileSystem" && it != "suggestions" }
        if (additional.isNotEmpty()) add(ApprovalDetail(R.string.approval_scope_other, JsonObject(additional).toString()))
        val networkExtra = network?.filterKeys { it != "enabled" }.orEmpty()
        if (networkExtra.isNotEmpty()) add(ApprovalDetail(R.string.approval_scope_other, JsonObject(mapOf("network" to JsonObject(networkExtra))).toString()))
        val filesExtra = files?.filterKeys { it !in setOf("read", "write", "entries") }.orEmpty()
        if (filesExtra.isNotEmpty()) add(ApprovalDetail(R.string.approval_scope_other, JsonObject(mapOf("fileSystem" to JsonObject(filesExtra))).toString()))
    }
}

internal fun approvalDetails(item: AttentionItem, skipActionList: Boolean): List<ApprovalDetail> {
    val approval = item.approval ?: return emptyList()
    return buildList {
        fun addValue(label: Int?, value: String?) {
            value?.trim()?.takeIf(String::isNotEmpty)?.let { add(ApprovalDetail(label, it)) }
        }
        // Complete values remain available when the two-line overview truncates.
        addValue(R.string.attention_operation, approval.title)
        addValue(R.string.attention_batch, approval.batchId)
        addValue(R.string.approval_provider_description, approval.reason)
        addValue(R.string.attention_command, approval.command)
        addValue(R.string.attention_directory, approval.cwd)
        approval.filePaths.forEach { addValue(null, it) }
        addValue(null, approval.grantRoot)
        addAll(approvalPermissionDetails(approval.permissionsJson))
        if (!skipActionList) approval.actions.forEach { action ->
            val operation = action.summary?.takeIf(String::isNotBlank)
                ?: action.description.takeIf(String::isNotBlank) ?: action.command
            addValue(R.string.attention_operation, operation)
            if (action.command != operation) addValue(R.string.attention_command, action.command)
            addValue(R.string.attention_directory, action.cwd)
        }
        addValue(R.string.attention_alternative, approval.saferAlternative)
        addValue(R.string.attention_risk, approval.riskLevel)
        addValue(R.string.attention_permission, approval.permissionMode)
        addValue(R.string.attention_expiry, approval.expiresAt)
    }.distinct()
}
