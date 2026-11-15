package com.agentoncloud.android.api

import kotlin.test.*

class AppApiWireTest {
    @Test fun rejectsIdentityFieldsVersionsAndTransportOverflow() {
        assertFails { AppApiWire.decode<PageFilter>("""{"callerBinding":"owner"}""") }
        assertFails { PageFilter(apiVersion = 2).validate() }
        assertFails { PageFilter(limit = 33).validate() }
        assertFails { OperationWatch(operationId = "\n").validate() }
        assertFails { AppApiWire.decode<PageFilter>(" ".repeat(AppApiWire.MAX_REQUEST_BYTES + 1)) }
    }
    @Test fun publicTaskRoundTripsWithoutOwnerOrInternalJournal() {
        val task = PublicTaskRequest("op", "中文任务", PublicRuntime("catalog-tool"), targetInstanceId = "pc")
        assertEquals(task, AppApiWire.decode<PublicTaskRequest>(AppApiWire.encode(task)))
        val operation = PublicOperation("op", "prep", "pc", 1, "ACCEPTED", "session", null, "request", true, false, 2, null)
        val encoded = AppApiWire.encode(operation)
        for (key in listOf("callerBinding", "creationKey", "originalFingerprint", "instruction", "uploads")) assertFalse(encoded.contains(key))
        assertEquals(operation, AppApiWire.decode<PublicOperation>(encoded))
    }
    @Test fun optionalSessionArgumentsDoNotChangeOldInvocationEncoding() {
        val old = LegacyInvocation("ragent.targets.list", page = PageFilter())
        val encoded = AppApiWire.encode(PublicInvocation(old.capabilityId, page = old.page))
        assertEquals(AppApiWire.encode(old), encoded)
        assertEquals(old, AppApiWire.decode<LegacyInvocation>(encoded))
        val new = PublicInvocation("ragent.sessions.search", session = PublicSessionRequest("pc", query = "中文"))
        assertEquals(new, AppApiWire.decode<PublicInvocation>(AppApiWire.encode(new)))
        assertFails { AppApiWire.decode<LegacyInvocation>(AppApiWire.encode(new)) }
    }
    @Test fun sessionProjectionContainsNoPrivateHistoryOrPath() {
        val encoded = AppApiWire.encode(PublicSession("pc", "session", "Title", "project", "idle", null, false))
        for (field in listOf("history", "folder", "messages", "credentials", "callerBinding", "queuedMessages"))
            assertFalse(encoded.contains(field))
    }
    @Test fun mutationArgumentsRoundTripAndAbsentFieldKeepsPreviousSessionEncoding() {
        val args = PublicSessionMutationRequest("op", "pc", "session", PublicSessionMutationKind.SET_ARCHIVED, flag = true)
        val invocation = PublicInvocation("ragent.sessions.prepareMutation", sessionMutation = args)
        assertEquals(invocation, AppApiWire.decode<PublicInvocation>(AppApiWire.encode(invocation)))
        val oldSession = PublicInvocation("ragent.sessions.get", session = PublicSessionRequest("pc", "session"))
        assertFalse(AppApiWire.encode(oldSession).contains("sessionMutation"))
        assertFails { AppApiWire.decode<PublicSessionMutationRequest>(AppApiWire.encode(args).dropLast(1) + ",\"callerBinding\":\"owner\"}") }
    }
    @Test fun mutationProjectionOmitsPrivateInputAndCommandIdentity() {
        val operation = PublicSessionMutation("op", "pc", "session", "project", PublicSessionMutationKind.RENAME,
            1000, "SUBMITTING", 2, null)
        val encoded = AppApiWire.encode(operation)
        assertEquals(operation, AppApiWire.decode<PublicSessionMutation>(encoded))
        for (field in listOf("callerBinding", "command", "requestId", "fingerprint", "title", "payload", "expectedRevision"))
            assertFalse(encoded.contains(field))
    }

}

@kotlinx.serialization.Serializable
private data class LegacyInvocation(val capabilityId: String, val apiVersion: Int = 1,
    val operationId: String? = null, val page: PageFilter? = null, val revision: String? = null,
    val resourceId: String? = null, val downloadId: String? = null)
