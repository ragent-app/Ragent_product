package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.RemoteTarget

/**
 * The project and chat surfaces describe the computer that owns the active
 * runtime.  Pairing-device records describe this Android phone instead, so
 * they must only be a legacy fallback when no remote target is known.
 */
internal fun activeComputerDisplayName(
    activeTargetId: String?,
    remoteTargets: List<RemoteTarget>,
    computers: List<Computer>,
    fallback: String,
): String {
    val target = remoteTargets.firstOrNull { it.instanceId == activeTargetId }
        ?: remoteTargets.firstOrNull { it.linkedToPhone }
    return target?.label?.trim()?.takeIf { it.isNotEmpty() }
        ?: computers.firstOrNull { it.connected }?.name?.trim()?.takeIf { it.isNotEmpty() }
        ?: computers.firstOrNull()?.name?.trim()?.takeIf { it.isNotEmpty() }
        ?: fallback
}
