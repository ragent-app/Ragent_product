package com.andysagent.ragent.core.domain

/** Mirrors the Web composer's provider registry families, not model vendors. */
internal fun runtimeProviderFamily(tool: String, family: String = ""): String? = when {
    tool in setOf("claude", "claude-bidi") || family.startsWith("claude-") -> "claude"
    tool in setOf("codex", "codex-cli") || family.startsWith("codex-") -> "codex"
    tool == "agy" || family.startsWith("agy-") -> "agy"
    else -> null
}
