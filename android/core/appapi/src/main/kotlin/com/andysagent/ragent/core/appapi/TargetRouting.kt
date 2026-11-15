package com.andysagent.ragent.core.appapi

data class ApiTarget(val instanceId: String, val name: String, val aliases: Set<String> = emptySet())
data class TargetDirectorySnapshot(val targets: List<ApiTarget>, val defaultShareTargetId: String? = null)

/** No active UI target or first-element fallback participates in headless routing. */
fun resolveTaskTarget(request: TaskRequest, directory: TargetDirectorySnapshot): ApiTarget {
    val id = request.targetInstanceId
    if (id != null) {
        if (id.isBlank()) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Computer identity is empty")
        return directory.targets.singleOrNull { it.instanceId == id }
            ?: apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Specified computer is not available to this caller")
    }
    val alias = request.targetAlias
    if (alias != null) {
        if (alias.isBlank()) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Computer alias is empty")
        val aliases = directory.targets.filter { it.aliases.any { candidate -> candidate.equals(alias.trim(), ignoreCase = true) } }
        val matches = aliases.ifEmpty { directory.targets.filter { it.name.equals(alias.trim(), ignoreCase = true) } }
        if (matches.size > 1) apiFailure(ApiErrorCode.AMBIGUOUS_TARGET, "More than one computer matches; specify an instanceId")
        return matches.singleOrNull() ?: apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Computer alias was not found")
    }
    directory.defaultShareTargetId?.let { defaultId ->
        return directory.targets.singleOrNull { it.instanceId == defaultId }
            ?: apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Default sharing computer is no longer available")
    }
    return when (directory.targets.size) {
        0 -> apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "No authorized paired computer is available")
        1 -> directory.targets.single()
        else -> apiFailure(ApiErrorCode.AMBIGUOUS_TARGET, "Select a computer or configure a sharing default")
    }
}
