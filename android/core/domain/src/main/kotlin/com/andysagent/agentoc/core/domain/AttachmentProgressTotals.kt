package com.andysagent.agentoc.core.domain

/** Accumulates actual sizes as the upload client discovers them. */
internal class AttachmentProgressTotals(sizeHints: List<Long>) {
    private val sizes = sizeHints.map { it.coerceAtLeast(0) }.toMutableList()
    private var completed = 0L

    fun discover(index: Int, size: Long) {
        if (size > 0) sizes[index] = size
    }

    fun total(): Long? = if (sizes.any { it <= 0 }) null else sizes.sum().takeIf { it > 0 }

    fun transferred(current: Long): Long = completed + current.coerceAtLeast(0)

    fun complete(index: Int) {
        completed += sizes[index]
    }
}
