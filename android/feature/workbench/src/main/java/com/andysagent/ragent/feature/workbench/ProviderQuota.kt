package com.andysagent.ragent.feature.workbench

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

internal data class ProviderQuotaWindow(
    val id: String,
    val label: String?,
    val group: String?,
    val remainingPercent: Double?,
    val resetsAt: String?,
)

internal data class ProviderQuotaBalance(val remaining: Double, val currency: String?)
internal data class ProviderQuotaDisplay(
    val status: String,
    val planName: String?,
    val windows: List<ProviderQuotaWindow>,
    val balances: List<ProviderQuotaBalance>,
)

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun JsonObject.number(key: String): Double? =
    (this[key] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }

internal fun parseProviderQuota(snapshot: JsonObject): ProviderQuotaDisplay {
    val windows = (snapshot["windows"] as? JsonArray).orEmpty().mapNotNull { value ->
        val item = value as? JsonObject ?: return@mapNotNull null
        val remaining = item.number("remainingPercent") ?: item.number("usedPercent")?.let { 100.0 - it }
        if (remaining == null || remaining !in 0.0..100.0) return@mapNotNull null
        ProviderQuotaWindow(item.text("id").orEmpty(), item.text("label"), item.text("group"), remaining, item.text("resetsAt"))
    }
    val balanceItems = (snapshot["balances"] as? JsonArray)?.toList()
        ?: listOfNotNull(snapshot["balance"] as? JsonObject)
    val balances = balanceItems.mapNotNull { value ->
        val item = value as? JsonObject ?: return@mapNotNull null
        val remaining = item.number("remaining") ?: return@mapNotNull null
        ProviderQuotaBalance(remaining, item.text("currency") ?: item.text("unit"))
    }
    return ProviderQuotaDisplay(snapshot.text("status").orEmpty(), snapshot.text("planName"), windows, balances)
}
