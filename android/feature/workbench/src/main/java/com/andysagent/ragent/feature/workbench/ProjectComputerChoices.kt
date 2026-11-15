package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.RemoteTargetAccessState

/** Revoked computers remain visible in device management, but cannot be selected as a workspace. */
internal fun projectComputerChoices(targets: List<RemoteTarget>): List<RemoteTarget> =
    targets.filter { it.accessState != RemoteTargetAccessState.Revoked }
