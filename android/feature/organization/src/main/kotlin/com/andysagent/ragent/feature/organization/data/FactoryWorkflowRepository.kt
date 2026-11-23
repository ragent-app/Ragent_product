package com.andysagent.ragent.feature.organization.data

import android.net.Uri
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/** Thin owner API client. Callers retain command and idempotency IDs for retries. */
class FactoryWorkflowRepository(
    private val transport: RagentTransport,
    private val organizationId: String,
) {
    private val base = "/api/organizations/${Uri.encode(organizationId)}/factory"

    private suspend fun request(path: String, body: JsonObject? = null, absolute: Boolean = false): JsonObject {
        val response = transport.execute(ApiRequest(
            method = if (body == null) "GET" else "POST",
            path = if (absolute) path else base + path,
            body = body?.toString(),
            requestId = (body?.get("commandId") as? JsonPrimitive)?.contentOrNull,
            idempotencyKey = (body?.get("idempotencyKey") as? JsonPrimitive)?.contentOrNull,
            contentType = if (body == null) null else "application/json",
        ))
        val parsed = runCatching { Json.parseToJsonElement(response.body) as? JsonObject }.getOrNull()
        if (!response.isSuccessful) throw ApiException(
            statusCode = response.statusCode,
            code = (parsed?.get("code") as? JsonPrimitive)?.contentOrNull,
            message = (parsed?.get("error") as? JsonPrimitive)?.contentOrNull ?: "HTTP ${response.statusCode}",
            headers = response.headers,
        )
        return parsed ?: error("Invalid server response")
    }

    suspend fun listOwnerResponsibilities(): JsonObject = request("/api/responsibilities?organizationId=${Uri.encode(organizationId)}", absolute = true)
    suspend fun ownerResponsibility(id: String): JsonObject = request("/api/responsibilities/${Uri.encode(id)}", absolute = true)
    suspend fun bindOwnerReportScope(body: JsonObject): JsonObject = request("/owner-report-node/bind", body)
    suspend fun ownerReportNodeCatalog(): JsonObject = request("/owner-report-node/catalog")
    suspend fun codexModels(): JsonObject = request("/api/models?tool=codex", absolute = true)
    suspend fun previewOwnerReportNode(body: JsonObject): JsonObject = request("/owner-report-node/preview", body)
    suspend fun commitOwnerReportNode(body: JsonObject): JsonObject = request("/owner-report-node/commit", body)
    suspend fun ownerReportNodeOperation(commandId: String): JsonObject = request("/owner-report-node/operations/${Uri.encode(commandId)}")

    suspend fun listGoals(cursor: String? = null): JsonObject = request("/goals" + (cursor?.let { "?cursor=${Uri.encode(it)}" } ?: ""))
    suspend fun listWorkItems(cursor: String? = null): JsonObject = request("/work-items" + (cursor?.let { "?cursor=${Uri.encode(it)}" } ?: ""))
    suspend fun getWorkItem(id: String): JsonObject = request("/work-items/${Uri.encode(id)}")
    suspend fun getReconciliation(id: String): JsonObject = request("/work-items/${Uri.encode(id)}/reconcile")
    suspend fun getBudget(id: String): JsonObject = request("/work-items/${Uri.encode(id)}/budget")
    suspend fun createHandoff(itemId: String, version: Long, commandId: String): JsonObject =
        request("/work-items/${Uri.encode(itemId)}/handoffs", buildJsonObject {
            put("commandId", commandId); put("expectedVersion", version)
        })
    suspend fun getHandoff(id: String): JsonObject = request("/handoffs/${Uri.encode(id)}")
    suspend fun getCommand(commandId: String): JsonObject = request("/commands/${Uri.encode(commandId)}")
    suspend fun getSessionProject(sessionId: String): String? {
        val response = request("/api/sessions/${Uri.encode(sessionId)}?view=summary", absolute = true)
        val session = response["session"] as? JsonObject ?: return null
        if ((session["id"] as? JsonPrimitive)?.contentOrNull != sessionId) return null
        return (session["projectId"] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
    }

    suspend fun createGoal(commandId: String, key: String, projectId: String, objective: String): JsonObject =
        command("CreateGoal", commandId, key, payload = buildJsonObject {
            put("projectId", projectId); put("objective", objective)
        })

    /** Creates a proposed read-only report. Authorization and approval are separate owner actions. */
    suspend fun createReadOnlyWork(
        commandId: String, key: String, goalId: String, nodeId: String,
        projectId: String, objective: String, criterion: String, attempts: Int = 1, tokens: Long? = null, cost: Double? = null,
    ): JsonObject {
        require(attempts in 1..2)
        require((tokens == null && cost == null) || (tokens != null && cost != null
            && tokens > 0 && tokens <= 9_007_199_254_740_991L && cost.isFinite() && cost > 0))
        return command("CreateWorkItem", commandId, key, payload = buildJsonObject {
            put("goalId", goalId); put("kind", "review"); put("assigneeNodeId", nodeId)
            put("contract", buildJsonObject {
                put("objective", objective); put("accessMode", "read"); put("allowedPaths", buildJsonArray { })
                put("acceptanceCriteria", buildJsonArray { add(buildJsonObject {
                    put("id", "owner-review"); put("method", "manual"); put("description", criterion)
                }) })
                put("resource", buildJsonObject {
                    put("projectId", projectId); put("readScope", "entire_project")
                    put("networkPolicy", "inherit_existing_permissions")
                })
                if (tokens != null && cost != null) put("budgetReservation", buildJsonObject { put("tokens", tokens); put("cost", cost) })
                put("retry", buildJsonObject { put("maxAttempts", attempts) })
            })
        })
    }

    /** Adds a confirmed reservation to the server-read contract; authorization must follow this revision. */
    suspend fun amendReportBudget(
        commandId: String, key: String, itemId: String, expectedVersion: Long,
        contract: JsonObject, tokens: Long, cost: Double,
    ): JsonObject {
        require(tokens > 0 && tokens <= 9_007_199_254_740_991L && cost.isFinite() && cost > 0)
        val next = buildJsonObject {
            contract.forEach { (name, value) -> if (name != "budgetReservation") put(name, value) }
            put("budgetReservation", buildJsonObject { put("tokens", tokens); put("cost", cost) })
        }
        return command("AmendContract", commandId, key, itemId, expectedVersion, buildJsonObject { put("contract", next) })
    }

    suspend fun authorizeReport(commandId: String, key: String, itemId: String, expectedVersion: Long): JsonObject =
        request("/work-items/${Uri.encode(itemId)}/owner-report-authorization", buildJsonObject {
            put("commandId", commandId); put("idempotencyKey", key); put("expectedVersion", expectedVersion)
        })

    suspend fun retryWork(commandId: String, key: String, itemId: String, expectedVersion: Long): JsonObject =
        command("RetryWork", commandId, key, itemId, expectedVersion)

    suspend fun approveContract(commandId: String, key: String, itemId: String, expectedVersion: Long): JsonObject =
        command("ApproveContract", commandId, key, itemId, expectedVersion)

    suspend fun decideManual(
        commandId: String, key: String, itemId: String, expectedVersion: Long,
        contractRevision: Long, gateGeneration: Long, candidateDigest: String,
        criterionId: String, decision: String, rationale: String, packetId: String, packetDigest: String, targets: kotlinx.serialization.json.JsonArray? = null,
    ): JsonObject {
        require(decision == "passed" || decision == "failed")
        return request("/work-items/${Uri.encode(itemId)}/manual-acceptance", buildJsonObject {
            put("commandId", commandId); put("idempotencyKey", key); put("expectedVersion", expectedVersion)
            put("contractRevision", contractRevision); put("gateGeneration", gateGeneration)
            put("candidateDigest", candidateDigest); put("criterionId", criterionId)
            put("decision", decision); put("rationale", rationale)
            put("packetId", packetId); put("packetDigest", packetDigest)
            if (decision == "failed" && targets != null && targets.isNotEmpty()) put("targets", targets)
        })
    }

    private suspend fun command(
        type: String, commandId: String, key: String, targetId: String? = null,
        expectedVersion: Long? = null, payload: JsonObject = buildJsonObject { },
    ): JsonObject = request("/commands", buildJsonObject {
        put("type", type); put("commandId", commandId); put("idempotencyKey", key)
        if (targetId != null) put("targetId", targetId)
        if (expectedVersion != null) put("expectedVersion", expectedVersion)
        put("payload", payload)
    })
}
