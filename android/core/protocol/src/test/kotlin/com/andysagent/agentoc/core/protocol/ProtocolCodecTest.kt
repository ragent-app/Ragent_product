package com.andysagent.agentoc.core.protocol

import kotlinx.serialization.serializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ProtocolCodecTest {
    private val codec = ProtocolCodec()

    @Test
    fun perQuestionAnswersUseExplicitCapabilityDecision() {
        val request = RuntimeApprovalDecisionRequestDto("approve_with_answers", "req", listOf("-1", "-1"),
            customAnswers = listOf("first", "second"))
        val payload = codec.encode(serializer<RuntimeApprovalDecisionRequestDto>(), request)
        val decoded = codec.decode(serializer<RuntimeApprovalDecisionRequestDto>(), payload)
        assertEquals("approve_with_answers", decoded.decision)
        assertEquals(listOf("first", "second"), decoded.customAnswers)
    }

    @Test
    fun targetRuntimeContractRoundTripsWithWebFieldNames() {
        val summary = TargetSummary(
            targetId = "target-a",
            instanceId = "instance-a",
            revision = 7,
            eventCursor = "12",
            generatedAt = "2099-01-01T00:00:00.000Z",
            sessions = TargetSummarySessionCounts(total = 3, active = 1),
            runs = TargetSummaryRunCounts(active = 1),
            approvals = TargetSummaryApprovalCounts(pending = 2),
            recentActivity = listOf(TargetSummaryActivity(entityId = "session-1", title = "Export")),
            recentProjects = listOf(TargetSummaryProject(id = "project-1", name = "Operations", updatedAt = "2099-01-01T00:00:00.000Z")),
        )
        val event = TargetSummaryEvent(
            eventId = "event-12",
            targetId = "target-a",
            instanceId = "instance-a",
            entityType = "notification",
            entityId = "target-a",
            revision = 7,
            type = "snapshot",
            emittedAt = summary.generatedAt,
            cursor = 12,
            summary = buildJsonObject { put("sessions", buildJsonObject { put("total", 3) }) },
        )
        val command = TargetCommand(
            requestId = "request-1",
            idempotencyKey = "idempotency-1",
            targetId = "target-a",
            operation = "session.message",
            resourceId = "session:session-1",
            expectedRevision = 7,
            expiresAt = "2099-01-01T00:01:00.000Z",
        )

        assertEquals(summary, codec.decode(serializer<TargetSummary>(), codec.encode(serializer<TargetSummary>(), summary)))
        assertEquals(event, codec.decode(serializer<TargetSummaryEvent>(), codec.encode(serializer<TargetSummaryEvent>(), event)))
        assertEquals(command, codec.decode(serializer<TargetCommand>(), codec.encode(serializer<TargetCommand>(), command)))
        summary.validate()
        event.validate()
        command.validate(Instant.parse("2098-12-31T23:59:00Z"))
    }

    @Test
    fun targetRuntimeContractRejectsInvalidStateAndExpiredCommand() {
        assertFailsWith<IllegalArgumentException> {
            TargetDescriptor(
                targetId = "target-a",
                instanceId = "instance-a",
                label = "A",
                status = "unknown",
            ).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            TargetCommand(
                requestId = "request-1",
                idempotencyKey = "idempotency-1",
                targetId = "target-a",
                operation = "session.message",
                resourceId = "session:session-1",
                expectedRevision = 0,
                expiresAt = "2000-01-01T00:00:00Z",
            ).validate(Instant.parse("2020-01-01T00:00:00Z"))
        }
    }

    @Test
    fun parsesActualPairingResponseFixture() {
        val body = javaClass.getResourceAsStream("/fixtures/pairing-redeem.json")!!.bufferedReader().readText()
        val response = codec.decode(serializer<RedeemPairingInvitationResponse>(), body)
        assertEquals("rli_fixture", response.instanceId)
        assertEquals("rdev_fixture", response.device.id)
        assertEquals("Bearer", response.credential.type)
        assertEquals("provisional-google", response.credential.scope)
    }

    @Test
    fun parsesV3PairingResponseWithProvisionalBearer() {
        val body = javaClass.getResourceAsStream("/fixtures/pairing-redeem-v3.json")!!.bufferedReader().readText()
        val response = codec.decode(serializer<RedeemPairingInvitationResponse>(), body)
        assertEquals("rli_fixture_v3", response.instanceId)
        assertEquals("rdev_fixture_v3", response.device.id)
        assertEquals(3, response.device.authVersion)
        assertEquals("p256", response.device.keyAlgorithm)
        assertEquals("Bearer", response.credential.type)
        assertEquals("provisional-google", response.credential.scope)
    }

    @Test
    fun parsesDeviceP2PCandidateFromPairingResponse() {
        val json = """{
            "instanceId":"rli_p2p",
            "endpoint":"https://agentoc.example.test",
            "device":{"id":"rdev_p2p","deviceName":"Pixel","platform":"android"},
            "credential":{"type":"Bearer","token":"rda_test"},
            "deviceP2P":{"roomId":"room_123","secret":"secret_456","signalingEndpoint":"https://signal.example.test/"}
        }"""

        val response = codec.decode(serializer<RedeemPairingInvitationResponse>(), json)

        assertEquals("room_123", response.deviceP2P?.roomId)
        assertEquals("secret_456", response.deviceP2P?.secret)
        assertEquals("https://signal.example.test/", response.deviceP2P?.signalingEndpoint)
    }

    @Test
    fun parsesV3DeviceChallengeWithAllFields() {
        val body = javaClass.getResourceAsStream("/fixtures/device-challenge-v3.json")!!.bufferedReader().readText()
        val response = codec.decode(serializer<CreateDeviceChallengeResponse>(), body)
        val challenge = response.challenge
        assertEquals("ch_v3_fixture", challenge.challengeId)
        assertEquals("rdev_fixture_v3", challenge.deviceId)
        assertEquals("nonce_v3_fixture", challenge.nonce)
        assert(challenge.message.startsWith("agentoc-device-auth-v3"))
        assertEquals("2026-08-12T00:00:00.000Z", challenge.issuedAt)
        assertEquals("2026-08-12T00:01:00.000Z", challenge.expiresAt)
        assertEquals("agentoc-device-access", challenge.audience)
        assertEquals("rli_fixture_v3", challenge.instanceId)
    }

    @Test
    fun parsesSessionPageAndUsesDurableBoundarySeq() {
        val body = javaClass.getResourceAsStream("/fixtures/session-events-page.json")!!.bufferedReader().readText()
        val page = codec.decode(serializer<SessionEventsPageDto>(), body)
        assertEquals(43, page.latestSeq)
        assertEquals(43, page.events.last().boundarySeq())
        assertEquals(41, page.events.first().startingSeq())
    }

    @Test
    fun renamedPairingSchemesMatchLegacy() {
        val old = "agentoc://pair?v=3&i=i3&e=https%3A%2F%2Fexample.test&t=rpi_fixture&x=2099-01-01T00%3A00%3A00Z"
        listOf("riollant", "ragent").forEach { scheme ->
            assertEquals(parsePairingUri(old), parsePairingUri(old.replace("agentoc://", "$scheme://")))
        }
    }

    @Test
    fun rejectsUnsupportedPairingVersion() {
        assertFailsWith<IllegalArgumentException> {
            parsePairingUri("agentoc://pair?v=99&instance=i&endpoint=http%3A%2F%2F127.0.0.1%3A7690&token=t&expires=2026-08-12T00%3A00%3A00Z")
        }
    }

    @Test
    fun validatesPairingEndpointTokenAndExpiry() {
        val pairing = parsePairingUri(
            "agentoc://pair?v=2&instance=i&endpoint=https%3A%2F%2Fexample.test%2F&token=rpi_fixture&expires=2099-01-01T00%3A00%3A00Z",
        )
        assertEquals("https://example.test/", pairing.endpoint)
        assertFailsWith<IllegalArgumentException> {
            parsePairingUri(
                "agentoc://pair?v=2&instance=i&endpoint=ftp%3A%2F%2Fexample.test&token=rpi_fixture&expires=2099-01-01T00%3A00%3A00Z",
            )
        }
        assertFailsWith<IllegalArgumentException> {
            parsePairingUri(
                "agentoc://pair?v=2&instance=i&endpoint=https%3A%2F%2Fexample.test&token=bad&expires=2099-01-01T00%3A00%3A00Z",
            )
        }
        assertFailsWith<IllegalArgumentException> {
            parsePairingUri(
                "agentoc://pair?v=2&instance=i&endpoint=https%3A%2F%2Fexample.test&token=rpi_fixture&expires=2000-01-01T00%3A00%3A00Z",
            )
        }
    }

    @Test
    fun acceptsCompactV3PairingUriFields() {
        val pairing = parsePairingUri(
            "agentoc://pair?v=3&i=i3&e=https%3A%2F%2Fexample.test&t=rpi_fixture&x=2099-01-01T00%3A00%3A00Z",
        )
        assertEquals("i3", pairing.instanceId)
        assertEquals("https://example.test", pairing.endpoint)
        assertEquals("rpi_fixture", pairing.token)
    }

    @Test
    fun acceptsEndpointlessV3PairingClaimWithoutTransportFields() {
        val pairing = parsePairingUri(
            "agentoc://pair?v=3&i=instance-claim&t=rpi_claim&x=2099-01-01T00%3A00%3A00Z",
        )
        assertEquals("instance-claim", pairing.instanceId)
        assertEquals("", pairing.endpoint)
        assertEquals("rpi_claim", pairing.token)
        assertEquals(null, pairing.signalingEndpoint)
        assertEquals(null, pairing.roomId)
    }

    @Test
    fun acceptsEndpointlessV3PairingClaimWithTargetIdentity() {
        val publicKey = java.net.URLEncoder.encode(
            "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n",
            "UTF-8",
        )
        val pairing = parsePairingUri(
            "agentoc://pair?v=3&i=instance-claim&t=rpi_claim&x=2099-01-01T00%3A00%3A00Z" +
                "&p=$publicKey&f=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        assertEquals("-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n", pairing.instancePublicKey)
        assertEquals("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", pairing.instanceKeyFingerprint)
    }

    @Test
    fun pairingCredentialDtoDeserializesWithOptionalScope() {
        val json = """{"type":"Bearer","token":"rda_abc","expiresAt":"2026-08-12T00:15:00Z","scope":"device-access"}"""
        val cred = codec.decode(serializer<PairingCredentialDto>(), json)
        assertEquals("Bearer", cred.type)
        assertEquals("rda_abc", cred.token)
        assertEquals("device-access", cred.scope)
    }

    @Test
    fun pairingCredentialDtoDeserializesWithoutScope() {
        val json = """{"type":"Bearer","token":"rda_abc","expiresAt":"2026-08-12T00:15:00Z"}"""
        val cred = codec.decode(serializer<PairingCredentialDto>(), json)
        assertEquals("Bearer", cred.type)
        assertEquals(null, cred.scope)
    }

    @Test
    fun structuredAgentTriggerAndTemplateRequestsRoundTrip() {
        val trigger = CreateTriggerRequestDto(
            title = "Weekly export",
            text = "Prepare the report",
            scheduledAt = "2099-01-01T00:00:00Z",
            sessionId = "session-1",
            tool = "codex",
            model = "gpt-5.4",
            effort = "high",
            thinking = false,
        )
        val decodedTrigger = codec.decode(
            serializer<CreateTriggerRequestDto>(),
            codec.encode(serializer<CreateTriggerRequestDto>(), trigger),
        )
        assertEquals(trigger, decodedTrigger)

        val template = ApplyTemplateRequestDto("agent_reporter")
        val decodedTemplate = codec.decode(
            serializer<ApplyTemplateRequestDto>(),
            codec.encode(serializer<ApplyTemplateRequestDto>(), template),
        )
        assertEquals(template, decodedTemplate)
    }

    @Test
    fun accountJoinIntentContractUsesStableSignedMessageFields() {
        val request = CreateAccountJoinIntentRequest(
            devicePublicKey = "-----BEGIN PUBLIC KEY-----",
            deviceName = "Pixel",
            platform = "android",
            accountClaimToken = "rpi_one_time_claim",
        )
        val encoded = codec.encode(serializer<CreateAccountJoinIntentRequest>(), request)
        val decoded = codec.decode(serializer<CreateAccountJoinIntentRequest>(), encoded)
        assertEquals(request.devicePublicKey, decoded.devicePublicKey)
        assertEquals(request.accountClaimToken, decoded.accountClaimToken)
        assertEquals(
            "agentoc-account-join-intent-v1\ninstance-1\nintent-1\ndevice-1\nfingerprint\nnonce\n2026-08-14T00:00:00Z\nagentoc-account-join",
            buildAccountJoinIntentMessage(
                instanceId = "instance-1",
                intentId = "intent-1",
                deviceId = "device-1",
                devicePublicKeyFingerprint = "fingerprint",
                nonce = "nonce",
                issuedAt = "2026-08-14T00:00:00Z",
            ),
        )
    }

    @Test
    fun deserializesToolCallAndResultEventsWithMetrics() {
        val json = """{
            "seq": 10,
            "type": "tool_result",
            "toolName": "run_command",
            "toolInput": {"command": "ls -la"},
            "toolOutput": "total 0\n-rw-r--r-- 1 user group 0 test.kt",
            "exitCode": 0,
            "durationMs": 152,
            "promptTokens": 100,
            "completionTokens": 50,
            "totalTokens": 150
        }"""
        val event = codec.decode(serializer<SessionEventDto>(), json)
        assertEquals("tool_result", event.type)
        assertEquals("run_command", event.toolName)
        assertEquals("total 0\n-rw-r--r-- 1 user group 0 test.kt", event.textContent())
        assertEquals(0, event.exitCode)
        assertEquals(152L, event.durationMs)
        assertEquals(100L, event.promptTokens)
        assertEquals(50L, event.completionTokens)
        assertEquals(150L, event.totalTokens)
    }

    @Test
    fun deserializesPrivilegedBatchPasskeySignal() {
        val json = """{
            "seq": 12,
            "type": "privileged_batch_request",
            "batchId": "pbatch-1",
            "runId": "run-1",
            "passkeyRequired": false,
            "executorUnavailableReasonCode": "macos_administrator_unavailable",
            "other": [],
            "delete": []
        }"""
        val event = codec.decode(serializer<SessionEventDto>(), json)
        assertEquals("privileged_batch_request", event.type)
        assertEquals(false, event.passkeyRequired)
        assertEquals("macos_administrator_unavailable", event.executorUnavailableReasonCode)

        val legacyJson = """{
            "seq": 13,
            "type": "privileged_batch_request",
            "batchId": "pbatch-2",
            "runId": "run-1"
        }"""
        val legacyEvent = codec.decode(serializer<SessionEventDto>(), legacyJson)
        assertEquals(null, legacyEvent.passkeyRequired)
        assertEquals(null, legacyEvent.executorUnavailableReasonCode)
    }

    @Test
    fun deserializesFileChangeAndAttachmentEvents() {
        val json = """{
            "seq": 11,
            "type": "file_change",
            "fileChanges": [
                {
                    "path": "/src/Main.kt",
                    "name": "Main.kt",
                    "type": "modify",
                    "additions": 12,
                    "deletions": 3,
                    "diffSummary": "+ fun main() {}"
                }
            ],
            "attachments": [
                {
                    "assetId": "ast-1",
                    "filename": "screenshot.png",
                    "mimeType": "image/png",
                    "sizeBytes": 1024,
                    "downloadUrl": "https://example.test/ast-1.png"
                }
            ]
        }"""
        val event = codec.decode(serializer<SessionEventDto>(), json)
        assertEquals(1, event.fileChanges.size)
        assertEquals("/src/Main.kt", event.fileChanges.first().path)
        assertEquals(12, event.fileChanges.first().additions)
        assertEquals(3, event.fileChanges.first().deletions)

        assertEquals(1, event.allAttachments().size)
        assertEquals("ast-1", event.allAttachments().first().assetId)
        assertEquals("screenshot.png", event.allAttachments().first().filename)
    }

    @Test
    fun queueMutationAndFollowUpEntryPreserveServerIdentityAndAttachments() {
        val queueJson = """{
            "action":"steer",
            "requestId":"android:queued-1"
        }"""
        val request = codec.decode(serializer<QueueMutationRequestDto>(), queueJson)
        assertEquals("steer", request.action)
        assertEquals("android:queued-1", request.requestId)

        val response = codec.decode(
            serializer<QueueMutationResponseDto>(),
            """{
                "requestId":"android:queued-1",
                "steered":true,
                "pendingCancel":false,
                "queued":false,
                "session":{
                    "id":"session-1",
                    "queuedMessages":[{
                        "requestId":"android:queued-2",
                        "responseId":"android:response-2",
                        "text":"follow up",
                        "queuedAt":"2026-08-26T04:00:00Z",
                        "attachments":[{"assetId":"asset-1","originalName":"report.csv","mimeType":"text/csv","sizeBytes":12}],
                        "tool":"codex",
                        "model":"gpt-5.4",
                        "serviceTier":"fast"
                    }]
                }
            }""",
        )
        val queued = response.session!!["queuedMessages"]!!.toString()
        val entries = codec.decode(serializer<List<QueuedFollowUpDto>>(), queued)
        assertEquals("android:queued-2", entries.single().requestId)
        assertEquals("asset-1", entries.single().allAttachments().single().assetId)
        assertEquals("fast", entries.single().serviceTier)
    }

    @Test
    fun deserializesDecisionAndApprovalRequestsWithOptionsAndRiskLevel() {
        val json = """{
            "seq": 12,
            "type": "approval_request",
            "approvalId": "app-1",
            "title": "Deploy to production",
            "reason": "Production release v1.0",
            "saferAlternative": "Deploy to staging",
            "approveLabel": "Deploy Now",
            "denyLabel": "Cancel",
            "options": ["Deploy Full", "Canary 10%", "Dry Run"],
            "isMultiSelect": false,
            "questions": [{
                "id": "deployment-mode",
                "header": "Release mode",
                "question": "How should this deployment proceed?",
                "options": [
                    {"label":"Deploy Full","value":"full","description":"All users"},
                    {"label":"Canary 10%","value":"canary"}
                ]
            }],
            "riskLevel": "high"
        }"""
        val event = codec.decode(serializer<SessionEventDto>(), json)
        assertEquals("approval_request", event.type)
        assertEquals("app-1", event.approvalId)
        assertEquals("Deploy to production", event.title)
        assertEquals(3, event.options.size)
        assertEquals("Canary 10%", event.options[1])
        assertEquals(false, event.isMultiSelect)
        assertEquals("deployment-mode", event.questions.single().id)
        assertEquals("canary", event.questions.single().options[1].value)
        assertEquals("high", event.riskLevel)
    }

    @Test
    fun deserializesRunActivityAndRunDto() {
        val json = """{
            "state": "running",
            "phase": "executing_tools",
            "runId": "run-42",
            "run": {
                "id": "run-42",
                "sessionId": "ses-1",
                "state": "running",
                "tool": "bash",
                "model": "gemini-3.7-flash",
                "thinking": true
            },
            "queue": {
                "count": 2
            }
        }"""
        val activity = codec.decode(serializer<RunActivityDto>(), json)
        assertEquals("running", activity.state)
        assertEquals("executing_tools", activity.phase)
        assertEquals("run-42", activity.run?.id)
        assertEquals("gemini-3.7-flash", activity.run?.model)
        assertEquals(true, activity.run?.thinking)
        assertEquals(2, activity.queue?.count)
    }

    @Test
    fun encodesAgentBindingAndUploadedAttachmentReferences() {
        val request = SendMessageRequestDto(
            text = "Inspect this file",
            requestId = "req-attachment",
            tool = "codex",
            providerProfile = "codex-official",
            agentId = "report_cleaner",
            harnessCapabilityIds = listOf("agentoc:skill:calendar"),
            attachments = listOf(
                AttachmentItemDto(
                    assetId = "fasset_123",
                    originalName = "input.csv",
                    mimeType = "text/csv",
                    sizeBytes = 42,
                    renderAs = "file",
                ),
            ),
        )

        val encoded = codec.encode(serializer<SendMessageRequestDto>(), request)
        val decoded = codec.decode(serializer<SendMessageRequestDto>(), encoded)

        assertEquals("report_cleaner", decoded.agentId)
        assertEquals("codex", decoded.tool)
        assertEquals("codex-official", decoded.providerProfile)
        assertEquals(listOf("agentoc:skill:calendar"), decoded.harnessCapabilityIds)
        assertEquals("fasset_123", decoded.attachments.single().assetId)
        assertEquals("input.csv", decoded.attachments.single().originalName)
        assertEquals("text/csv", decoded.attachments.single().mimeType)
        assertEquals("file", decoded.attachments.single().renderAs)
    }
}
