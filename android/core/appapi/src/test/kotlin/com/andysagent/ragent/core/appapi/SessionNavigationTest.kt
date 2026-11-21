package com.andysagent.ragent.core.appapi

import kotlin.test.*

class SessionNavigationTest {
    @Test fun roundTripKeepsExactComputerAndSession() {
        val request = SessionNavigationRequest("s-1", "inst_pc-b")
        assertEquals(request, parseSessionNavigationUri(sessionNavigationUri(request)))
    }
    @Test fun renamedSchemesPreserveNavigationValidation() {
        val expected = SessionNavigationRequest("s-1", "inst_pc-b")
        listOf("ragent", "riollant", "ragent").forEach { scheme ->
            assertEquals(expected, parseSessionNavigationUri("$scheme://session/s-1?instanceId=inst_pc-b"))
            assertFailsWith<AppApiException> { parseSessionNavigationUri("$scheme://session/s-1?instanceId=inst_pc-b&approve=true") }
        }
    }
    @Test fun legacyTargetMustBeChosenBeforeLinkCanBeProduced() {
        val request = SessionNavigationRequest("s1").validated()
        assertEquals(ApiErrorCode.AMBIGUOUS_TARGET, assertFailsWith<AppApiException> { sessionNavigationUri(request) }.error.code)
    }
    @Test fun rejectsAmbiguousEncodedAndCommandLinks() {
        listOf("ragent://session/s1", "ragent://session/s1?instanceId=", "ragent://session/s1?instanceId=a&instanceId=b",
            "ragent://session/s1?instanceId=a&autoStart=true", "ragent://session/s1?instanceId=a#x",
            "ragent://session/s1/s2?instanceId=a", "ragent://session/%2e%2e?instanceId=a", "ragent://session/s1?instanceId=a%2Fb",
            "ragent://session:42/s1?instanceId=a", "ragent://user@session/s1?instanceId=a", "https://session/s1?instanceId=a",
            "ragent://sessionevil/s1?instanceId=a", "ragent://session/s1?instanceId=a&token=secret").forEach { value ->
            assertEquals(ApiErrorCode.INVALID_ARGUMENT, assertFailsWith<AppApiException>(value) { parseSessionNavigationUri(value) }.error.code)
        }
    }
    @Test fun differentComputersAndJavaHashCollisionSessionsHaveIndependentIdentity() {
        assertEquals("Aa".hashCode(), "BB".hashCode())
        val a = SessionNavigationRequest("Aa", "pc-a")
        assertNotEquals(a.identity(), a.copy(sessionId = "BB").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = "pc-b").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = null).identity())
    }
    @Test fun redeliveryHasStableIdentityAndEventIdIsScopedToTargetAndSession() {
        val a = SessionNavigationRequest("s1", "a", "attention", "question", "evt-1")
        assertEquals(a.identity(), a.copy(kind = "completion", awaitingKey = "").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = "b").identity())
        assertNotEquals(a.identity(), a.copy(sessionId = "s2").identity())
        assertNotEquals(a.identity(), a.copy(eventId = "evt-2").identity())
    }
    @Test fun missingEventUsesKindAndAwaitingKey() {
        val a = SessionNavigationRequest("s1", "a", "attention", "question")
        assertEquals(a.identity(), a.copy().identity())
        assertNotEquals(a.identity(), a.copy(kind = "completion").identity())
        assertNotEquals(a.identity(), a.copy(awaitingKey = "another question").identity())
    }
    @Test fun boundsAndControlCharactersAreRejected() {
        listOf(SessionNavigationRequest("../s"), SessionNavigationRequest("s", ""), SessionNavigationRequest("s".repeat(161)),
            SessionNavigationRequest("s", kind = "x".repeat(65)), SessionNavigationRequest("s", kind = "中".repeat(22)),
            SessionNavigationRequest("s", awaitingKey = "中".repeat(171)),
            SessionNavigationRequest("s", eventId = "x".repeat(257)), SessionNavigationRequest("s", kind = "x\ny")).forEach {
            assertFailsWith<AppApiException> { it.validated() }
        }
    }
    @Test fun parsesValidatedResponsibilityAwaitingKeyWithoutBreakingSessionNavigation() {
        val awaitingKey = "resp:v1:rid=responsibility_123&act=plan_awaiting_approval&raw=plan_proposed&pid=plan_456"
        val request = SessionNavigationRequest("root-sess-1", "inst_abc", "plan", awaitingKey, "responsibility:responsibility_123:7")
        val target = request.responsibilityTarget()
        assertNotNull(target)
        assertEquals("responsibility_123", target.responsibilityId)
        assertEquals("plan_awaiting_approval", target.category)
        assertEquals("plan_proposed", target.activityType)
        assertEquals("plan_456", target.planId)
        assertNull(SessionNavigationRequest("s1", "inst_abc", "attention", "waiting_user").responsibilityTarget())
        listOf(
            "resp:v1:",
            "resp:v1:rid=../bad&act=blocked",
            "resp:v1:rid=resp_1&rid=resp_2",
            "resp:v1:rid=resp_1&pid=../bad",
            "resp:v1:rid=resp_1&act=bad/act",
            "resp:v1:rid=resp_1\nbad",
        ).forEach { invalid ->
            assertNull(parseResponsibilityAwaitingKey(invalid), "Must reject malformed responsibility key: $invalid")
        }
    }
}
