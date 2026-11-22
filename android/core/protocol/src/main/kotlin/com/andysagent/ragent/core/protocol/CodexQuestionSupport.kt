package com.andysagent.ragent.core.protocol

import com.andysagent.ragent.core.model.ApprovalOption
import com.andysagent.ragent.core.model.AsyncQuestion
import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.model.ElicitationPayload
import com.andysagent.ragent.core.model.ElicitationSchemaProperty
import com.andysagent.ragent.core.model.ParsedQuestionReplyEnvelope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.net.URI
import kotlin.text.Charsets.UTF_8

object QuestionReplyEnvelopeCodec {
    const val OPEN_TAG = "<send_user_message_question_reply>"
    const val CLOSE_TAG = "</send_user_message_question_reply>"
    const val MAX_ID_UTF8_BYTES = 512

    fun parse(text: String): ParsedQuestionReplyEnvelope {
        if (text.isEmpty()) return ParsedQuestionReplyEnvelope()
        val extracted = mutableListOf<AsyncQuestionReply>()
        var remaining = text
        var foundTag = false
        var malformed = false

        while (true) {
            val openIdx = remaining.indexOf(OPEN_TAG, ignoreCase = true)
            if (openIdx < 0) break
            foundTag = true
            val contentStart = openIdx + OPEN_TAG.length
            val closeIdx = remaining.indexOf(CLOSE_TAG, contentStart, ignoreCase = true)
            if (closeIdx < 0) {
                malformed = true
                remaining = remaining.substring(0, openIdx)
                break
            }
            val rawInner = remaining.substring(contentStart, closeIdx).trim()
            val parsedChunk = runCatching {
                RagentProtocol.json.decodeFromString<List<AsyncQuestionReplyDto>>(rawInner)
            }.getOrNull()
            if (parsedChunk == null) {
                malformed = true
            } else {
                parsedChunk.mapTo(extracted) { it.toDomain() }
            }
            remaining = remaining.removeRange(openIdx, closeIdx + CLOSE_TAG.length)
        }

        // Remove orphan closing tags if any.
        if (remaining.contains(CLOSE_TAG, ignoreCase = true)) {
            foundTag = true
            remaining = remaining.replace(CLOSE_TAG, "", ignoreCase = true)
        }

        // Strip streaming partial start marker such as "<send_user_".
        val lastOpen = remaining.lastIndexOf('<')
        if (lastOpen >= 0) {
            val tail = remaining.substring(lastOpen)
            if (tail.length >= 2 && OPEN_TAG.startsWith(tail, ignoreCase = true)) {
                foundTag = true
                remaining = remaining.substring(0, lastOpen)
            }
        }

        return ParsedQuestionReplyEnvelope(
            replies = extracted,
            trailingText = remaining.trim(),
            hasEnvelope = foundTag,
            isMalformed = malformed,
        )
    }

    fun buildText(
        replies: List<AsyncQuestionReply>,
        trailingText: String = "",
    ): String {
        val cleanReplies = replies.filter { it.questionItemId.isNotBlank() || it.answer.isNotBlank() }
        val cleanTrailing = trailingText.trim()
        if (cleanReplies.isEmpty()) return cleanTrailing

        val fitsEnvelope = cleanReplies.all { reply ->
            reply.questionItemId.isNotBlank() && reply.questionItemId.toByteArray(UTF_8).size <= MAX_ID_UTF8_BYTES
        }
        val header = if (fitsEnvelope) {
            val jsonBody = RagentProtocol.json
                .encodeToString(cleanReplies.map { it.toDto() })
                .replace(CLOSE_TAG, "<\\/send_user_message_question_reply>", ignoreCase = true)
            "$OPEN_TAG\n$jsonBody\n$CLOSE_TAG"
        } else {
            cleanReplies.joinToString("\n\n") { reply ->
                val promptLine = reply.question.trim().ifBlank { "Question" }
                val answerBody = reply.answer.trim().ifBlank { "(No reply)" }
                "> $promptLine\n\n$answerBody"
            }
        }
        return if (cleanTrailing.isEmpty()) header else "$header\n\n$cleanTrailing"
    }

    fun formatReadableSummary(replies: List<AsyncQuestionReply>): String {
        return replies.joinToString("\n\n") { reply ->
            val q = reply.question.trim().ifBlank { "Question" }
            val a = reply.answer.trim()
            if (a.isEmpty()) "Q: $q" else "Q: $q\nA: $a"
        }
    }

    fun formatReadableCopyText(text: String): String {
        val parsed = parse(text)
        if (!parsed.hasEnvelope) return text
        val summary = formatReadableSummary(parsed.replies)
        return listOf(summary, parsed.trailingText)
            .filter { it.isNotBlank() }
            .joinToString("\n\n")
            .ifBlank { parsed.trailingText }
    }

    fun formatEditableComposerText(text: String): String {
        val parsed = parse(text)
        if (!parsed.hasEnvelope) return text
        if (parsed.trailingText.isNotBlank()) return parsed.trailingText
        return parsed.replies.joinToString("\n") { it.answer.trim() }.trim()
    }
}

fun AsyncQuestionDto.toDomain(): AsyncQuestion {
    val resolvedQuestion = question.ifBlank { title }
    val resolvedTitle = title.ifBlank { resolvedQuestion }
    return AsyncQuestion(
        id = id.ifBlank { "async-$index" },
        index = index,
        title = resolvedTitle,
        question = resolvedQuestion,
        options = options.map { ApprovalOption(label = it.label, value = it.value ?: it.label, description = it.description) },
        allowFreeText = allowFreeText,
        status = status?.takeIf { it.isNotBlank() } ?: if (!answeredText.isNullOrBlank()) "answered" else "pending",
        answeredText = answeredText,
        isOther = isOther,
        isSecret = isSecret,
    )
}

fun AsyncQuestion.toDto(): AsyncQuestionDto = AsyncQuestionDto(
    id = id,
    index = index,
    title = title,
    question = question,
    options = options.map { ApprovalOptionDto(label = it.label, value = it.value, description = it.description) },
    allowFreeText = allowFreeText,
    status = status,
    answeredText = answeredText,
    isOther = isOther,
    isSecret = isSecret,
)

fun AsyncQuestionReplyDto.toDomain(): AsyncQuestionReply = AsyncQuestionReply(
    questionItemId = questionItemId,
    question = question,
    answer = answer,
)

fun AsyncQuestionReply.toDto(): AsyncQuestionReplyDto = AsyncQuestionReplyDto(
    questionItemId = questionItemId,
    question = question,
    answer = answer,
)

fun ElicitationPayloadDto.toDomain(): ElicitationPayload {
    val schemaJson = requestedSchema?.let { RagentProtocol.json.encodeToString(JsonObject.serializer(), it) }
    val properties = parseElicitationSchemaProperties(requestedSchema)
    return ElicitationPayload(
        mode = mode,
        serverName = serverName,
        elicitationId = elicitationId,
        message = message,
        requestedSchemaJson = schemaJson,
        schemaProperties = properties,
        url = url,
        codexApprovalKind = codexApprovalKind,
        title = title,
        description = description,
        challenge = challenge,
    )
}

fun ElicitationPayload.toDto(): ElicitationPayloadDto {
    val schemaObj = requestedSchemaJson?.let { raw ->
        runCatching { RagentProtocol.json.decodeFromString(JsonObject.serializer(), raw) }.getOrNull()
    }
    return ElicitationPayloadDto(
        mode = mode,
        serverName = serverName,
        elicitationId = elicitationId,
        message = message,
        requestedSchema = schemaObj,
        url = url,
        codexApprovalKind = codexApprovalKind,
        title = title,
        description = description,
        challenge = challenge,
    )
}

fun parseElicitationSchemaProperties(schema: JsonObject?): List<ElicitationSchemaProperty> {
    if (schema == null) return emptyList()
    val propertiesObj = schema["properties"] as? JsonObject ?: return emptyList()
    val requiredSet = (schema["required"] as? JsonArray)
        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        ?.toSet()
        ?: emptySet()
    return propertiesObj.entries.mapNotNull { (name, element) ->
        val def = element as? JsonObject ?: return@mapNotNull null
        val type = def.string("type")
            ?: when {
                def["enum"] is JsonArray || def["oneOf"] is JsonArray -> "string"
                else -> "string"
            }
        val directEnum = (def["enum"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .orEmpty()
        val oneOfEnum = if (directEnum.isEmpty()) {
            (def["oneOf"] as? JsonArray)?.mapNotNull { entry ->
                val obj = entry as? JsonObject ?: return@mapNotNull null
                obj.string("const") ?: obj.string("title")
            }.orEmpty()
        } else {
            emptyList()
        }
        val arrayEnum = ((def["items"] as? JsonObject)?.get("enum") as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .orEmpty()
        val defaultPrimitive = def["default"] as? JsonPrimitive
        val defaultBoolean = if (type.equals("boolean", ignoreCase = true)) defaultPrimitive?.booleanOrNull else null
        val defaultString = if (!type.equals("boolean", ignoreCase = true)) defaultPrimitive?.contentOrNull else null
        ElicitationSchemaProperty(
            name = name,
            type = type.lowercase(),
            title = def.string("title"),
            description = def.string("description"),
            format = def.string("format"),
            writeOnly = def.boolean("writeOnly") == true,
            enumValues = directEnum.ifEmpty { oneOfEnum },
            defaultValue = defaultString,
            defaultBoolean = defaultBoolean,
            minLength = (def["minLength"] as? JsonPrimitive)?.intOrNull,
            maxLength = (def["maxLength"] as? JsonPrimitive)?.intOrNull,
            minimum = (def["minimum"] as? JsonPrimitive)?.doubleOrNull,
            maximum = (def["maximum"] as? JsonPrimitive)?.doubleOrNull,
            pattern = def.string("pattern"),
            required = name in requiredSet,
            arrayItemEnumValues = arrayEnum,
        )
    }
}

data class ElicitationFormValidationResult(
    val fieldErrors: Map<String, String> = emptyMap(),
    val contentJson: String? = null,
) {
    val isValid: Boolean get() = fieldErrors.isEmpty() && contentJson != null
}

fun validateAndBuildElicitationContent(
    properties: List<ElicitationSchemaProperty>,
    textValues: Map<String, String>,
    booleanValues: Map<String, Boolean>,
    multiSelectValues: Map<String, Set<String>>,
): ElicitationFormValidationResult {
    val errors = linkedMapOf<String, String>()
    val jsonEntries = linkedMapOf<String, JsonElement>()

    for (prop in properties) {
        val label = prop.title?.takeIf { it.isNotBlank() } ?: prop.name
        when (prop.type) {
            "boolean" -> {
                val boolVal = booleanValues[prop.name] ?: prop.defaultBoolean ?: false
                jsonEntries[prop.name] = JsonPrimitive(boolVal)
            }
            "integer" -> {
                val raw = (textValues[prop.name] ?: prop.defaultValue.orEmpty()).trim()
                if (raw.isEmpty()) {
                    if (prop.required) errors[prop.name] = "$label is required"
                } else {
                    val parsed = raw.toLongOrNull()
                    if (parsed == null) {
                        errors[prop.name] = "$label must be a whole number"
                    } else {
                        val asDouble = parsed.toDouble()
                        prop.minimum?.let { min -> if (asDouble < min) errors[prop.name] = "$label must be >= ${min.toLong()}" }
                        prop.maximum?.let { max -> if (asDouble > max) errors[prop.name] = "$label must be <= ${max.toLong()}" }
                        if (prop.name !in errors) jsonEntries[prop.name] = JsonPrimitive(parsed)
                    }
                }
            }
            "number" -> {
                val raw = (textValues[prop.name] ?: prop.defaultValue.orEmpty()).trim()
                if (raw.isEmpty()) {
                    if (prop.required) errors[prop.name] = "$label is required"
                } else {
                    val parsed = raw.toDoubleOrNull()?.takeIf { it.isFinite() }
                    if (parsed == null) {
                        errors[prop.name] = "$label must be a number"
                    } else {
                        prop.minimum?.let { min -> if (parsed < min) errors[prop.name] = "$label must be >= $min" }
                        prop.maximum?.let { max -> if (parsed > max) errors[prop.name] = "$label must be <= $max" }
                        if (prop.name !in errors) jsonEntries[prop.name] = JsonPrimitive(parsed)
                    }
                }
            }
            "array" -> {
                val items = if (prop.arrayItemEnumValues.isNotEmpty()) {
                    multiSelectValues[prop.name].orEmpty().toList()
                } else {
                    (textValues[prop.name] ?: "")
                        .split(',', '\n')
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                }
                if (items.isEmpty()) {
                    if (prop.required) errors[prop.name] = "$label is required"
                } else {
                    jsonEntries[prop.name] = buildJsonArray {
                        items.forEach { add(JsonPrimitive(it)) }
                    }
                }
            }
            "object" -> {
                val raw = (textValues[prop.name] ?: prop.defaultValue.orEmpty()).trim()
                if (raw.isEmpty()) {
                    if (prop.required) errors[prop.name] = "$label is required"
                } else {
                    val obj = runCatching {
                        RagentProtocol.json.decodeFromString(JsonObject.serializer(), raw)
                    }.getOrNull()
                    if (obj == null) {
                        errors[prop.name] = "$label must be valid JSON object"
                    } else {
                        jsonEntries[prop.name] = obj
                    }
                }
            }
            else -> {
                val raw = textValues[prop.name] ?: prop.defaultValue.orEmpty()
                val trimmed = raw.trim()
                if (trimmed.isEmpty()) {
                    if (prop.required) errors[prop.name] = "$label is required"
                } else {
                    if (prop.enumValues.isNotEmpty() && raw !in prop.enumValues) {
                        errors[prop.name] = "$label must be one of the available choices"
                    }
                    prop.minLength?.let { min ->
                        if (raw.length < min) errors[prop.name] = "$label must be at least $min characters"
                    }
                    prop.maxLength?.let { max ->
                        if (raw.length > max) errors[prop.name] = "$label must be at most $max characters"
                    }
                    prop.pattern?.let { pat ->
                        val regex = runCatching { Regex(pat) }.getOrNull()
                        if (regex != null && !regex.containsMatchIn(raw)) {
                            errors[prop.name] = "$label does not match required format"
                        }
                    }
                    if (prop.name !in errors) jsonEntries[prop.name] = JsonPrimitive(raw)
                }
            }
        }
    }

    val contentJson = if (errors.isEmpty()) {
        val obj = buildJsonObject {
            jsonEntries.forEach { (k, v) -> put(k, v) }
        }
        RagentProtocol.json.encodeToString(JsonObject.serializer(), obj)
    } else null
    return ElicitationFormValidationResult(fieldErrors = errors, contentJson = contentJson)
}

fun isHttpOrHttpsUrl(raw: String?): Boolean {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return false
    val uri = runCatching { URI(trimmed) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase() ?: return false
    return (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
}

fun urlOriginHost(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
    val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
    return if (uri.port > 0) "$host:${uri.port}" else host
}

fun redactSecretText(value: String): String = if (value.isBlank()) "" else "••••••"
