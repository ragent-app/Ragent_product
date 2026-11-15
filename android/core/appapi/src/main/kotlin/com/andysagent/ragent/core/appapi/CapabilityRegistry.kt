package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable

@Serializable
data class CapabilityDescriptor(
    val id: String,
    val version: Int = 1,
    val description: String,
    val mutates: Boolean,
    val targetRequired: Boolean,
    val implemented: Boolean,
)

/** Only implemented handlers enter this initial catalog. Domain expansion is incremental. */
class CapabilityRegistry(descriptors: List<CapabilityDescriptor> = coreCapabilities + SessionCapabilities.descriptors + SessionMutationCapabilities.descriptors) {
    private val entries = descriptors.associateBy { it.id }
    init { require(entries.size == descriptors.size) { "Duplicate capability ID" } }
    fun list(): List<CapabilityDescriptor> = entries.values.toList()
    fun requireImplemented(id: String): CapabilityDescriptor {
        val descriptor = entries[id]
        if (descriptor?.implemented != true) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Capability is not implemented")
        return descriptor
    }

    companion object {
        const val TARGETS_LIST = "ragent.targets.list"
        const val TASKS_PREPARE = "ragent.tasks.prepare"
        const val TASKS_COMMIT = "ragent.tasks.commit"
        const val TASKS_GET = "ragent.tasks.get"
        const val TASKS_RECONCILE = "ragent.tasks.reconcile"
        const val TASKS_CANCEL = "ragent.tasks.cancelSubmission"
        const val TASKS_RESULT = "ragent.tasks.getResult"
        const val TASKS_RESULT_EXPORT = "ragent.tasks.downloadResult"
        val coreCapabilities = listOf(
            CapabilityDescriptor(TARGETS_LIST, description = "List authorized paired computers", mutates = false, targetRequired = false, implemented = true),
            CapabilityDescriptor(TASKS_PREPARE, description = "Prepare a task without starting PC work", mutates = false, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_COMMIT, description = "Submit the immutable prepared task", mutates = true, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_GET, description = "Read a submission operation and its remote receipt", mutates = false, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_RECONCILE, description = "Read retained PC acceptance evidence without sending a task", mutates = false, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_CANCEL, description = "Cancel submission before message dispatch; does not cancel a Run", mutates = true, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_RESULT, description = "Read the retained result of this exact submission without dispatch", mutates = false, targetRequired = true, implemented = true),
            CapabilityDescriptor(TASKS_RESULT_EXPORT, description = "Read an exact result manifest and stream verified complete bytes into private storage", mutates = false, targetRequired = true, implemented = true),
        )
    }
}
