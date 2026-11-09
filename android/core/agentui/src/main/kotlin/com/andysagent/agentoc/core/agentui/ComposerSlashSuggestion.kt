package com.andysagent.agentoc.core.agentui

import androidx.compose.runtime.Immutable

@Immutable
data class ComposerSlashSuggestion(
    val id: String,
    val kind: String,
    val source: String,
    val title: String,
    val description: String = "",
    val invocationText: String = "",
    val enabled: Boolean = true,
    val disabledReason: String? = null,
    val selectionMode: String = "insert",
)

@Immutable
data class ComposerSelectedCapability(
    val id: String,
    val kind: String,
    val source: String,
    val title: String,
)

/** Returns the query for a slash token at the end of the composer draft. */
fun composerSlashQuery(value: String): String? {
    val tokenStart = value.indexOfLast { it.isWhitespace() } + 1
    val token = value.substring(tokenStart)
    if (!token.startsWith("/")) return null
    val query = token.drop(1)
    if (query.any(Char::isWhitespace)) return null
    if (query.any { !(it.isLetterOrDigit() || it in "-_:.@") }) return null
    return query
}

/** Replaces only the active slash token, preserving any preceding draft text. */
fun replaceComposerSlashToken(value: String, invocationText: String): String? {
    if (invocationText.isBlank()) return null
    val tokenStart = value.indexOfLast { it.isWhitespace() } + 1
    val token = value.substring(tokenStart)
    if (!token.startsWith("/") || token.drop(1).any(Char::isWhitespace)) return null
    return value.substring(0, tokenStart) + invocationText
}

/** Removes the active trailing slash query while keeping the preceding draft. */
fun clearComposerSlashToken(value: String): String? {
    val tokenStart = value.indexOfLast { it.isWhitespace() } + 1
    val token = value.substring(tokenStart)
    if (!token.startsWith("/") || token.drop(1).any(Char::isWhitespace)) return null
    return value.substring(0, tokenStart).trimEnd()
}
