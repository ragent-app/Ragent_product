package com.andysagent.ragent.feature.organization.ui

import android.net.Uri
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationOfflineCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant

/** Offline presentation only: no mutation actions or deferred requests. */
@Composable
internal fun OfflineOrganizationItems(cache: OrganizationOfflineCache, scope: String, organizationId: String, nodes: List<OrganizationNodeDto>?, onBack: () -> Unit) {
    val base = "/api/organizations/${Uri.encode(organizationId)}/factory/"
    var path by remember(scope, organizationId, nodes) { mutableStateOf(if (nodes == null) base + "work-items" else "") }
    var snapshot by remember(scope, path) { mutableStateOf<Pair<String, Long>?>(null) }
    LaunchedEffect(scope, path) {
        snapshot = null
        if (path.isNotEmpty()) snapshot = withContext(Dispatchers.IO) { cache.read(scope, path) }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Offline, read-only. Only views previously opened online are available.")
        if (nodes != null) nodes.forEach { node ->
            TextButton(onClick = { path = base + "nodes/${Uri.encode(node.id)}/messages" }) { Text(node.displayName.ifBlank { node.id }) }
        }
        if (nodes == null && path != base + "work-items") TextButton(onClick = { path = base + "work-items" }) { Text("Work items") }
        if (path.isNotEmpty()) {
            val current = snapshot
            if (current == null) Text("No cached data for this view.") else {
                Text("Cached at ${Instant.ofEpochMilli(current.second)}")
                val json = remember(current.first) { runCatching { JSONObject(current.first) }.getOrNull() }
                if (nodes == null && path == base + "work-items" && json != null) {
                    val rows = json.optJSONArray("items")
                    if (rows == null || rows.length() == 0) Text("No cached work items in this page.")
                    if (!json.isNull("nextCursor") && json.optString("nextCursor").isNotBlank()) Text("More work items exist; reconnect to load further pages.")
                    if (rows != null) for (i in 0 until rows.length()) {
                        val row = rows.optJSONObject(i) ?: continue
                        val id = row.optString("id")
                        val title = row.optJSONObject("contract")?.optString("objective").orEmpty().ifBlank { id }
                        if (id.isNotEmpty()) TextButton(onClick = { path = base + "work-items/${Uri.encode(id)}" }) { Text("$title · ${row.optString("state")}") }
                    }
                } else if (nodes != null && json != null) {
                    val messages = json.optJSONArray("messages")
                    if (messages == null) Text("Messages cannot be displayed from this snapshot.")
                    else if (messages.length() == 0) Text("No messages in this cached view.")
                    else for (i in 0 until messages.length()) {
                        val message = messages.optJSONObject(i) ?: continue
                        Text("${message.optString("createdAt", "Unknown time")} · ${message.optString("senderKind", "Unknown sender")} ${message.optString("senderPrincipal", "")} · ${message.optString("deliveryState", "unknown delivery")}")
                        Text(message.optString("body", "Message body unavailable"))
                        val requestState = if (message.isNull("requestState")) "information" else message.optString("requestState")
                        Text("Request: $requestState")
                        message.optJSONObject("reply")?.let { reply -> Text("Reply: ${reply.optString("body", "unavailable")} · ${reply.optString("createdAt", "unknown time")}") }
                    }
                    Text("Only the saved message page is shown; reconnect for current messages.")
                } else if (json != null) {
                    val item = json.optJSONObject("item")
                    if (item == null) Text("Work item details are unavailable in this snapshot.") else {
                        val contract = item.optJSONObject("contract")
                        Text(contract?.optString("objective")?.takeIf { it.isNotBlank() } ?: "Objective unavailable")
                        Text("State: ${item.optString("state", "unknown")} · control: ${item.optString("controlState", "unknown")}")
                        Text("Project: ${item.optString("projectId")} · Goal: ${item.optString("goalId")} · Work item: ${item.optString("id")}")
                        val digest = item.optString("candidateDigest")
                        Text("Candidate: ${digest.ifBlank { "unverified" }} · version ${item.optString("rowVersion")} · contract ${item.optString("contractRevision")}")
                        val candidates = item.optJSONArray("candidates")
                        var reportShown = false
                        if (candidates != null) for (i in 0 until candidates.length()) {
                            val candidate = candidates.optJSONObject(i) ?: continue
                            if (candidate.optString("digest") != digest || digest.isBlank()) continue
                            val report = candidate.optJSONObject("report") ?: continue
                            Text(report.optString("visibleText").ifBlank { "Cached report content unavailable" })
                            reportShown = true
                        }
                        if (!reportShown) Text("Report evidence: unverified in this snapshot")
                        Text("Cached reading does not record acceptance; reconnect for current facts and decisions.")
                        val criteria = contract?.optJSONArray("acceptanceCriteria")
                        if (criteria == null || criteria.length() == 0) Text("Acceptance criteria unavailable")
                        else for (i in 0 until criteria.length()) {
                            val criterion = criteria.optJSONObject(i) ?: continue
                            Text("Criterion: ${criterion.optString("description", criterion.optString("id", "unavailable"))}")
                        }
                        val decisions = item.optJSONArray("decisions")
                        if (decisions == null || decisions.length() == 0) Text("Acceptance: unverified")
                        else for (i in 0 until decisions.length()) {
                            val decision = decisions.optJSONObject(i) ?: continue
                            Text("Acceptance ${decision.optString("criterionId", "unknown")}: ${decision.optString("decision", "unverified")}")
                        }
                        val milestones = item.optJSONArray("milestones")
                        var integrated = false
                        if (milestones != null) for (i in 0 until milestones.length()) {
                            val milestone = milestones.optJSONObject(i) ?: continue
                            if (milestone.optString("milestone") == "integrated") {
                                integrated = true
                                Text("Integrated commit: ${milestone.optJSONObject("evidence")?.optString("commit")?.takeIf { it.isNotBlank() } ?: "unverified"}")
                            }
                        }
                        if (!integrated) Text("Integrated commit: unverified")
                    }
                } else Text("Cached details cannot be displayed.")
            }
        }
    }
}
