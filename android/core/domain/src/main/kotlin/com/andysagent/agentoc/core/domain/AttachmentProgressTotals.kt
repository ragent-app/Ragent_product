package com.andysagent.agentoc.core.domain

/** Accumulates actual sizes as the upload client discovers them. */
internal class AttachmentProgressTotals(sizeHints: List<Long>) {
    private val sizes = sizeHints.map { it.coerceAtLeast(0) }.toMutableList()
    private val transferredBytes = MutableList(sizes.size) { 0L }
    private val completed = MutableList(sizes.size) { false }

    fun discover(index: Int, size: Long) {
        if (size > 0) sizes[index] = size
    }

    fun total(): Long? = if (sizes.any { it <= 0 }) null else sizes.sum().takeIf { it > 0 }

    fun update(index: Int, current: Long) {
        if (!completed[index]) transferredBytes[index] = current.coerceIn(0, sizes[index].takeIf { it > 0 } ?: Long.MAX_VALUE)
    }

    fun transferred(): Long = transferredBytes.sum()

    fun complete(index: Int) {
        completed[index] = true
        transferredBytes[index] = sizes[index]
    }
}
