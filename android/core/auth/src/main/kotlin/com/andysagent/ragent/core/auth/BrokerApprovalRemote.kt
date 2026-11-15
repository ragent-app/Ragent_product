package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.retryAfterDelayMs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder
import java.time.Instant

data class BrokerPendingApproval(
    val requestId: String,
    val status: String,
    val challenge: BrokerApprovalChallenge,
    val brokerPublicKey: String,
    val brokerSignature: String,
)

data class BrokerPendingApprovalPage(
    val requests: List<BrokerPendingApproval>,
    val nextCursor: String?,
    val hasMore: Boolean,
    val revision: String? = null,
)

data class BrokerDecisionResult(
    val requestId: String,
    val status: String,
    val code: String?,
)

data class WindowsServicePendingApproval(
    val grant: WindowsServiceControlGrant,
    val brokerPublicKey: String,
    val brokerSignature: String,
)

data class WindowsServicePendingPage(
    val requests: List<WindowsServicePendingApproval>,
    val nextCursor: String?,
    val hasMore: Boolean,
)

data class BrokerPendingEnrollment(
    val challenge: BrokerEnrollmentChallenge,
    val brokerPublicKey: String,
    val brokerSignature: String,
)

data class BrokerEnrollmentMaterial(
    val deviceId: String,
    val publicKeyBase64: String,
)

data class BrokerEnrollmentResult(
    val deviceId: String,
    val code: String?,
)

/** Relays Broker-signed challenges and device-signed decisions over the paired computer transport. */
class BrokerApprovalRemote(private val executeRequest: suspend (ApiRequest) -> com.andysagent.ragent.core.network.ApiResponse) {
    constructor(transport: RagentTransport) : this(transport::execute)

    suspend fun pendingServiceControls(deviceId: String, cursor: String? = null): WindowsServicePendingPage {
        require(deviceId.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid approval device ID" }
        cursor?.let { require(it.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) { "Invalid Broker cursor" } }
        val query = "deviceId=$deviceId" + (cursor?.let { "&cursor=${encode(it)}" } ?: "")
        val root = request("GET", "/api/windows-privileged-broker/service-requests/pending?$query")
        require(root.string("type") == "service_pending") { "Invalid service approval response" }
        val requests = root.array("items").map { itemValue ->
            val item = itemValue.jsonObject
            val value = item["grant"]?.jsonObject ?: error("Service grant is missing")
            val grant = WindowsServiceControlGrant(
                value.requiredLong("version"), value.requiredString("keyId"), value.requiredString("brokerInstallationId"),
                value.requiredLong("policyGeneration"), value.requiredString("requestId"), value.requiredString("sessionId"),
                value.requiredString("runId"), value.requiredString("turnId"), value.requiredString("actionId"),
                value.requiredString("nonce"), value.requiredString("serviceName"), value.requiredString("action"),
                value.requiredString("definitionHash"), value.requiredString("authorization"),
                value.requiredLong("issuedMs"), value.requiredLong("expiresMs"),
            )
            WindowsServicePendingApproval(grant, item.requiredString("brokerPublicKey"), item.requiredString("brokerSignature"))
        }
        require(requests.size <= 16) { "Service approval page is too large" }
        val hasMore = root.boolean("hasMore")
        val nextCursor = root.string("nextCursor")?.takeIf(String::isNotBlank)
        require(!hasMore || nextCursor?.matches(Regex("^[A-Za-z0-9._:-]{1,128}$")) == true) { "Service approval cursor is missing" }
        return WindowsServicePendingPage(requests, nextCursor, hasMore)
    }

    suspend fun decideServiceControl(requestId: String, deviceId: String, choice: String, signature: String): BrokerDecisionResult {
        require(requestId.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) { "Invalid Broker request ID" }
        require(deviceId.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid approval device ID" }
        require(choice == "approve" || choice == "deny") { "Invalid Broker decision" }
        require(signature.isNotEmpty() && signature.length <= 1024 &&
            signature.matches(Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"))) { "Invalid Broker signature" }
        val body = """{"deviceId":"$deviceId","choice":"$choice","deviceSignature":"$signature"}"""
        val root = request("POST", "/api/windows-privileged-broker/service-requests/${encode(requestId)}/decision", body)
        require(root.string("type") == "result" && root.string("requestId") == requestId) { "Invalid Broker decision response" }
        return BrokerDecisionResult(requestId, root.string("status") ?: "unknown", root.string("code"))
    }

    suspend fun pending(
        deviceId: String,
        cursor: String? = null,
        afterRevision: String? = null,
        waitMs: Long? = null,
    ): BrokerPendingApprovalPage {
        require(deviceId.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid approval device ID" }
        cursor?.let { require(it.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) { "Invalid Broker cursor" } }
        afterRevision?.let { require(BROKER_REVISION_REGEX.matches(it) && cursor == null) { "Invalid Broker revision" } }
        waitMs?.let { require(afterRevision != null && it in 1L..15_000L) { "Invalid Broker wait" } }
        val query = buildString {
            append("deviceId=").append(deviceId)
            cursor?.let { append("&cursor=").append(encode(it)) }
            afterRevision?.let { append("&afterRevision=").append(encode(it)) }
            waitMs?.let { append("&waitMs=").append(it) }
        }
        val root = request("GET", "/api/windows-privileged-broker/requests/pending?$query")
        require(root.string("type") == "pending") { "Invalid Broker pending response" }
        val requests = root.array("pendingRequests").map(::parsePendingApproval)
        val hasMore = root.boolean("hasMore")
        val nextCursor = root.string("nextCursor")?.takeIf(String::isNotBlank)
        require(!hasMore || nextCursor != null) { "Broker pagination cursor is missing" }
        val revision = root.string("revision")
        require(revision == null || BROKER_REVISION_REGEX.matches(revision)) { "Invalid Broker revision" }
        return BrokerPendingApprovalPage(requests, nextCursor, hasMore, revision)
    }

    /** Reads an administrator-started enrollment challenge bound to this existing app device key. */
    suspend fun pendingEnrollment(deviceId: String): BrokerPendingEnrollment {
        require(deviceId.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid enrollment device ID" }
        val root = request("GET", "/api/windows-privileged-broker/enrollments/pending?deviceId=$deviceId")
        require(root.string("type") == "enrollment_challenge") { "Invalid Broker enrollment response" }
        val challengeJson = root["enrollmentChallenge"]?.jsonObject ?: error("Broker enrollment challenge is missing")
        val challenge = BrokerEnrollmentChallenge(
            enrollmentId = challengeJson.requiredString("enrollmentId"),
            brokerInstallationId = challengeJson.requiredString("brokerInstallationId"),
            policyGeneration = challengeJson.requiredLong("policyGeneration"),
            ownerId = challengeJson.requiredString("ownerId"),
            deviceId = challengeJson.requiredString("deviceId"),
            publicKeyFingerprint = challengeJson.requiredString("publicKeyFingerprint"),
            nonce = challengeJson.requiredString("nonce"),
            verificationCode = challengeJson.requiredString("verificationCode"),
            createdAt = Instant.parse(challengeJson.requiredString("createdAt")),
            expiresAt = Instant.parse(challengeJson.requiredString("expiresAt")),
        )
        require(challenge.deviceId == deviceId) { "Broker enrollment challenge targets a different device" }
        return BrokerPendingEnrollment(
            challenge = challenge,
            brokerPublicKey = root.requiredString("brokerPublicKey"),
            brokerSignature = root.requiredString("brokerSignature"),
        )
    }

    /** Completes only a current challenge signed by this app's registered device key. */
    suspend fun completeEnrollment(
        enrollmentId: String,
        verificationCode: String,
        signature: String,
    ): BrokerEnrollmentResult {
        require(enrollmentId.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) { "Invalid Broker enrollment ID" }
        require(verificationCode.matches(Regex("^[0-9]{8}$"))) { "Invalid Broker enrollment code" }
        require(signature.matches(Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")) && signature.isNotEmpty()) {
            "Invalid Broker enrollment signature"
        }
        val body = """{"verificationCode":"$verificationCode","signature":"$signature"}"""
        val root = request(
            "POST",
            "/api/windows-privileged-broker/enrollments/${encode(enrollmentId)}/complete",
            body,
        )
        require(root.string("type") == "result" && root.string("code") == "DEVICE_ENROLLED") {
            "Broker did not confirm device enrollment"
        }
        return BrokerEnrollmentResult(
            deviceId = root.requiredString("deviceId"),
            code = root.string("code"),
        )
    }

    suspend fun decide(
        requestId: String,
        deviceId: String,
        choice: String,
        signature: String,
    ): BrokerDecisionResult {
        require(requestId.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) { "Invalid Broker request ID" }
        require(deviceId.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid approval device ID" }
        require(choice == "approve" || choice == "deny") { "Invalid Broker decision" }
        require(signature.matches(Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"))) {
            "Invalid Broker signature"
        }
        val body = """{"deviceId":"$deviceId","choice":"$choice","signature":"$signature"}"""
        val root = request("POST", "/api/windows-privileged-broker/requests/${encode(requestId)}/decision", body)
        require(root.string("type") == "result" && root.string("requestId") == requestId) {
            "Invalid Broker decision response"
        }
        return BrokerDecisionResult(
            requestId = requestId,
            status = root.string("status") ?: "unknown",
            code = root.string("code"),
        )
    }

    private suspend fun request(method: String, path: String, body: String? = null): JsonObject {
        val response = executeRequest(ApiRequest(method, path, body))
        val root = runCatching { json.parseToJsonElement(response.body).jsonObject }
            .getOrElse {
                throw ApiException(
                    response.statusCode, null, "Invalid Broker response",
                    retryAfterMs = response.retryAfterDelayMs(), headers = response.headers,
                )
            }
        if (!response.isSuccessful) {
            throw ApiException(
                response.statusCode,
                root.string("code"),
                root.string("error") ?: "Broker request failed",
                retryAfterMs = response.retryAfterDelayMs(),
                headers = response.headers,
            )
        }
        return root
    }

    private fun parsePendingApproval(value: kotlinx.serialization.json.JsonElement): BrokerPendingApproval {
        val item = value.jsonObject
        val challengeJson = item["challenge"]?.jsonObject ?: error("Broker challenge is missing")
        val challenge = BrokerApprovalChallenge(
            brokerInstallationId = challengeJson.requiredString("brokerInstallationId"),
            ownerId = challengeJson.requiredString("ownerId"),
            policyGeneration = challengeJson.requiredLong("policyGeneration"),
            requestId = challengeJson.requiredString("requestId"),
            operation = challengeJson.requiredString("operation"),
            targetId = challengeJson.requiredString("targetId"),
            targetFingerprint = challengeJson.requiredString("targetFingerprint"),
            sessionId = challengeJson.requiredString("sessionId"),
            runId = challengeJson.requiredString("runId"),
            turnId = challengeJson.requiredString("turnId"),
            actionId = challengeJson.requiredString("actionId"),
            nonce = challengeJson.requiredString("nonce"),
            createdAt = Instant.parse(challengeJson.requiredString("createdAt")),
            expiresAt = Instant.parse(challengeJson.requiredString("expiresAt")),
        )
        val requestId = item.requiredString("requestId")
        require(requestId == challenge.requestId) { "Broker request ID does not match its challenge" }
        return BrokerPendingApproval(
            requestId = requestId,
            status = item.requiredString("status"),
            challenge = challenge,
            brokerPublicKey = item.requiredString("brokerPublicKey"),
            brokerSignature = item.requiredString("brokerSignature"),
        )
    }

    private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val BROKER_REVISION_REGEX = Regex("^[0-9a-f-]{36}:[0-9]{1,16}$")

        fun JsonObject.string(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull
        fun JsonObject.requiredString(name: String): String = string(name) ?: error("Broker field $name is missing")
        fun JsonObject.requiredLong(name: String): Long = this[name]?.jsonPrimitive?.longOrNull
            ?: error("Broker field $name is invalid")
        fun JsonObject.boolean(name: String): Boolean = this[name]?.jsonPrimitive?.booleanOrNull ?: false
        fun JsonObject.array(name: String): JsonArray = this[name]?.jsonArray ?: JsonArray(emptyList())
    }
}
