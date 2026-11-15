package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AccountPermissionPolicyRepositoryTest {
    @Test
    fun readsAndWritesTheAccountPolicyContract() = runBlocking {
        val transport = RecordingTransport(
            ApiResponse(200, "{\"policy\":{\"permissionPolicy\":\"approval\",\"updatedAt\":\"2026-09-02T00:00:00Z\"}}"),
            ApiResponse(200, "{\"policy\":{\"permissionPolicy\":\"full-auto\",\"updatedAt\":\"2026-09-02T00:01:00Z\"}}"),
        )
        val repository = DefaultAccountsRepository(transport)

        assertEquals("approval", repository.getAccountPermissionPolicy().permissionPolicy)
        val updated = repository.setAccountPermissionPolicy("full-auto", "policy-idem-1")

        assertEquals("full-auto", updated.permissionPolicy)
        assertEquals("GET", transport.requests[0].method)
        assertEquals("/api/account-policy", transport.requests[0].path)
        assertEquals("PATCH", transport.requests[1].method)
        assertEquals("policy-idem-1", transport.requests[1].idempotencyKey)
        assertEquals("{\"permissionPolicy\":\"full-auto\"}", transport.requests[1].body)
    }

    @Test
    fun conservativeAutoSurvivesReadWriteAndReadback() = runBlocking {
        val response = ApiResponse(200, "{\"policy\":{\"permissionPolicy\":\"conservative-auto\"}}")
        val transport = RecordingTransport(response, response, response)
        val repository = DefaultAccountsRepository(transport)
        assertEquals("conservative-auto", repository.getAccountPermissionPolicy().permissionPolicy)
        assertEquals("conservative-auto", repository.setAccountPermissionPolicy("conservative-auto", "conservative-idem").permissionPolicy)
        assertEquals("conservative-auto", repository.getAccountPermissionPolicy().permissionPolicy)
        assertEquals("{\"permissionPolicy\":\"conservative-auto\"}", transport.requests[1].body)
    }

    @Test
    fun rejectsUnknownPolicies() = runBlocking {
        val repository = DefaultAccountsRepository(RecordingTransport(ApiResponse(200, "{}")))

        assertFailsWith<IllegalArgumentException> {
            repository.setAccountPermissionPolicy("unrestricted", "policy-idem-2")
        }
        Unit
    }
}

private class RecordingTransport(
    private vararg val responses: ApiResponse,
) : RagentTransport {
    private val responseQueue = responses.toMutableList()
    val requests = mutableListOf<ApiRequest>()
    private val hints = MutableSharedFlow<InvalidationHint>()

    override val invalidations: Flow<InvalidationHint> = hints
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return responseQueue.removeFirst()
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
