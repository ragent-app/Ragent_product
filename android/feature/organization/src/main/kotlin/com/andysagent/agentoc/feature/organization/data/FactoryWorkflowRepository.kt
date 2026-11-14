package com.andysagent.agentoc.feature.organization.data

import android.net.Uri
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/** Thin owner API client. Callers retain command and idempotency IDs for retries. */
class FactoryWorkflowRepository(
    private val transport: AgentoCTransport,
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

    suspend fun listGoals(cursor: String? = null): JsonObject = request("/goals" + (cursor?.let { "?cursor=${Uri.encode(it)}" } ?: ""))
    suspend fun listWorkItems(cursor: String? = null): JsonObject = request("/work-items" + (cursor?.let { "?cursor=${Uri.encode(it)}" } ?: ""))
    suspend fun getWorkItem(id: String): JsonObject = request("/work-items/${Uri.encode(id)}")
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
        projectId: String, objective: String, criterion: String, tokens: Long, cost: Double,
    ): JsonObject {
        require(tokens > 0 && tokens <= 9_007_199_254_740_991L && cost.isFinite() && cost > 0)
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
                put("budgetReservation", buildJsonObject { put("tokens", tokens); put("cost", cost) })
                put("retry", buildJsonObject { put("maxAttempts", 1) })
            })
        })
    }

    suspend fun authorizeReport(commandId: String, key: String, itemId: String, expectedVersion: Long): JsonObject =
        request("/work-items/${Uri.encode(itemId)}/owner-report-authorization", buildJsonObject {
            put("commandId", commandId); put("idempotencyKey", key); put("expectedVersion", expectedVersion)
        })

    suspend fun approveContract(commandId: String, key: String, itemId: String, expectedVersion: Long): JsonObject =
        command("ApproveContract", commandId, key, itemId, expectedVersion)

    suspend fun decideManual(
        commandId: String, key: String, itemId: String, expectedVersion: Long,
        contractRevision: Long, gateGeneration: Long, candidateDigest: String,
        criterionId: String, decision: String, rationale: String,
    ): JsonObject {
        require(decision == "passed" || decision == "failed")
        return request("/work-items/${Uri.encode(itemId)}/manual-acceptance", buildJsonObject {
            put("commandId", commandId); put("idempotencyKey", key); put("expectedVersion", expectedVersion)
            put("contractRevision", contractRevision); put("gateGeneration", gateGeneration)
            put("candidateDigest", candidateDigest); put("criterionId", criterionId)
            put("decision", decision); put("rationale", rationale)
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
