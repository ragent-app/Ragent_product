package com.andysagent.ragent.core.protocol

import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.model.ElicitationKind
import com.andysagent.ragent.core.model.Message
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CodexQuestionProtocolTest {
    private val codec = ProtocolCodec()

    @Test
    fun `track 1 question extensions and emptySkip round-trip cleanly`() {
        val rawEvent = """
            {
              "seq": 10,
              "type": "approval_request",
              "kind": "question",
              "approvalId": "apr-1",
              "runId": "run-1",
              "isBlocking": false,
              "questions": [
                {
                  "id": "q-secret",
                  "header": "Credentials",
                  "question": "Enter token",
                  "isOther": true,
                  "isSecret": true,
                  "options": [
                    { "label": "Use env", "value": "env", "description": "Read TOKEN_A" }
                  ]
                }
              ]
            }
        """.trimIndent()
        val event = codec.decode(SessionEventDto.serializer(), rawEvent)
        assertEquals(false, event.isBlocking)
        val q = event.questions.single()
        assertEquals("q-secret", q.id)
        assertEquals("Credentials", q.header)
        assertEquals(true, q.isOther)
        assertEquals(true, q.isSecret)
        assertEquals("Read TOKEN_A", q.allOptions().single().description)

        val skipReq = RuntimeApprovalDecisionRequestDto(
            decision = "approve",
            requestId = "req-skip",
            emptySkip = true,
        )
        val encodedSkip = codec.encode(RuntimeApprovalDecisionRequestDto.serializer(), skipReq)
        val decodedSkip = codec.decode(RuntimeApprovalDecisionRequestDto.serializer(), encodedSkip)
        assertEquals(true, decodedSkip.emptySkip)
        assertEquals("approve", decodedSkip.decision)
    }

    @Test
    fun `async question options deserialize null, strings, and objects`() {
        val nullOpts = codec.decode(
            AsyncQuestionDto.serializer(),
            """{"id":"aq-1","question":"Pick","options":null}""",
        )
        assertTrue(nullOpts.options.isEmpty())

        val stringOpts = codec.decode(
            AsyncQuestionDto.serializer(),
            """{"id":"aq-2","question":"Pick","options":["Alpha","Beta"]}""",
        )
        assertEquals(listOf("Alpha", "Beta"), stringOpts.options.map { it.label })
        assertEquals(listOf("Alpha", "Beta"), stringOpts.options.map { it.value })

        val objOpts = codec.decode(
            AsyncQuestionDto.serializer(),
            """{"id":"aq-3","question":"Pick","options":[{"label":"A","value":"a","description":"Desc A"}]}""",
        )
        assertEquals("Desc A", objOpts.options.single().description)
    }

    @Test
    fun `question reply envelope parses valid, trailing, partial streaming, and falls back past 512 bytes`() {
        val replies = listOf(
            AsyncQuestionReply(questionItemId = "q-1", question = "Framework?", answer = "Compose"),
        )
        val built = QuestionReplyEnvelopeCodec.buildText(replies, trailingText = "Please proceed")
        assertTrue(built.contains(QuestionReplyEnvelopeCodec.OPEN_TAG))
        val parsed = QuestionReplyEnvelopeCodec.parse(built)
        assertTrue(parsed.hasEnvelope)
        assertFalse(parsed.isMalformed)
        assertEquals("Compose", parsed.replies.single().answer)
        assertEquals("Please proceed", parsed.trailingText)
        assertTrue(QuestionReplyEnvelopeCodec.formatReadableCopyText(built).contains("Q: Framework?\nA: Compose"))
        assertEquals("Please proceed", QuestionReplyEnvelopeCodec.formatEditableComposerText(built))

        // Partial opening marker stripped cleanly during token streaming.
        val streaming = QuestionReplyEnvelopeCodec.parse("Hello <send_user_")
        assertTrue(streaming.hasEnvelope)
        assertEquals("Hello", streaming.trailingText)

        // Malformed envelope is flagged without losing trailing/leading text.
        val malformed = QuestionReplyEnvelopeCodec.parse("<send_user_message_question_reply>not-json</send_user_message_question_reply>After")
        assertTrue(malformed.hasEnvelope)
        assertTrue(malformed.isMalformed)
        assertEquals("After", malformed.trailingText)

        // Multi-byte UTF-8 ID exceeding 512 bytes falls back to Markdown blockquote.
        val longId = "问".repeat(180) // 540 UTF-8 bytes > 512
        val fallback = QuestionReplyEnvelopeCodec.buildText(
            listOf(AsyncQuestionReply(questionItemId = longId, question = "What path?", answer = "src/main")),
            trailingText = "extra",
        )
        assertFalse(fallback.contains(QuestionReplyEnvelopeCodec.OPEN_TAG))
        assertTrue(fallback.startsWith("> What path?\n\nsrc/main"))
        assertTrue(fallback.endsWith("extra"))
    }

    @Test
    fun `metadata json persists delivery=async and reconciles cross-client answers`() {
        val event = codec.decode(
            SessionEventDto.serializer(),
            """
            {
              "seq": 2,
              "type": "message",
              "role": "assistant",
              "entityId": "msg-q",
              "delivery": "async",
              "asyncQuestionMessageId": "aqm-1",
              "asyncQuestionsState": "pending",
              "asyncQuestions": [
                {"id": "q1", "index": 0, "title": "Env", "question": "Which env?", "isSecret": false},
                {"id": "q2", "index": 1, "title": "Key", "question": "API key?", "isSecret": true}
              ]
            }
            """.trimIndent(),
        )
        val metaJson = event.encodeMessageMetadataJson()
        assertNotNull(metaJson)
        val qMsg = Message(
            id = "msg-q",
            sessionId = "s1",
            role = "assistant",
            content = "Questions",
            seq = 2,
            metadataJson = metaJson,
        ).withDecodedMetadata()
        assertEquals("async", qMsg.messageDelivery)
        assertEquals(2, qMsg.asyncQuestions.size)

        val userReplyText = QuestionReplyEnvelopeCodec.buildText(
            listOf(AsyncQuestionReply(questionItemId = "q1", question = "Which env?", answer = "Staging")),
        )
        val u1 = Message(id = "u1", sessionId = "s1", role = "user", content = userReplyText, seq = 3)
        val u2 = Message(
            id = "u2",
            sessionId = "s1",
            role = "user",
            content = "done",
            seq = 4,
            answeredQuestionItemIds = listOf("q2"),
        )
        val reconciled = reconcileAsyncQuestionStatuses(listOf(qMsg, u1, u2)).first()
        assertEquals("answered", reconciled.asyncQuestions[0].status)
        assertEquals("Staging", reconciled.asyncQuestions[0].answeredText)
        assertEquals("answered", reconciled.asyncQuestions[1].status)
        assertNull(reconciled.asyncQuestions[1].answeredText) // secret/id-only match avoids plaintext leak
        assertEquals("answered", reconciled.asyncQuestionsState)
    }

    @Test
    fun `elicitation kinds, json schema validation, url guard, and cancel round-trip`() {
        val schema = buildJsonObject {
            put(
                "properties",
                buildJsonObject {
                    put(
                        "apiKey",
                        buildJsonObject {
                            put("type", "string")
                            put("format", "password")
                            put("minLength", 4)
                        },
                    )
                    put(
                        "retries",
                        buildJsonObject {
                            put("type", "integer")
                            put("minimum", 1)
                            put("maximum", 5)
                            put("default", 2)
                        },
                    )
                    put(
                        "confirm",
                        buildJsonObject {
                            put("type", "boolean")
                            put("default", true)
                        },
                    )
                    put(
                        "scope",
                        buildJsonObject {
                            put("type", "string")
                            put("enum", JsonArray(listOf(JsonPrimitive("read"), JsonPrimitive("write"))))
                        },
                    )
                },
            )
            put("required", JsonArray(listOf(JsonPrimitive("apiKey"), JsonPrimitive("scope"))))
        }
        val formPayload = ElicitationPayloadDto(
            mode = "openai/form",
            serverName = "github",
            elicitationId = "el-1",
            message = "Configure GitHub access",
            requestedSchema = schema,
        ).toDomain()
        assertEquals(ElicitationKind.DynamicForm, formPayload.resolvedKind)
        assertTrue(formPayload.schemaProperties.first { it.name == "apiKey" }.isSecretField)
        assertTrue(formPayload.isFormComplexForAttention)

        val invalid = validateAndBuildElicitationContent(
            properties = formPayload.schemaProperties,
            textValues = mapOf("apiKey" to "12", "retries" to "9", "scope" to "invalid"),
            booleanValues = emptyMap(),
            multiSelectValues = emptyMap(),
        )
        assertFalse(invalid.isValid)
        assertTrue(invalid.fieldErrors.containsKey("apiKey"))
        assertTrue(invalid.fieldErrors.containsKey("retries"))
        assertTrue(invalid.fieldErrors.containsKey("scope"))

        val valid = validateAndBuildElicitationContent(
            properties = formPayload.schemaProperties,
            textValues = mapOf("apiKey" to "secret-123", "retries" to "3", "scope" to "read"),
            booleanValues = mapOf("confirm" to false),
            multiSelectValues = emptyMap(),
        )
        assertTrue(valid.isValid)
        assertTrue(valid.contentJson!!.contains("\"confirm\":false"))

        val compact = ElicitationPayloadDto(codexApprovalKind = "mcp_tool_call").toDomain()
        assertEquals(ElicitationKind.CompactToolApproval, compact.resolvedKind)
        val external = ElicitationPayloadDto(mode = "url", url = "https://auth.example.com:8443/cb").toDomain()
        assertEquals(ElicitationKind.ExternalUrl, external.resolvedKind)
        val unsupported = ElicitationPayloadDto(mode = "openai/userVerification").toDomain()
        assertEquals(ElicitationKind.Unsupported, unsupported.resolvedKind)

        assertTrue(isHttpOrHttpsUrl("https://auth.example.com/oauth"))
        assertFalse(isHttpOrHttpsUrl("javascript:alert(1)"))
        assertFalse(isHttpOrHttpsUrl("file:///etc/passwd"))
        assertEquals("auth.example.com:8443", urlOriginHost("https://auth.example.com:8443/cb"))
        assertEquals("••••••", redactSecretText("top-secret"))

        val cancelReq = RuntimeApprovalDecisionRequestDto(
            decision = "cancel",
            requestId = "req-el",
            elicitationResponse = ElicitationResponseDto(action = "cancel"),
        )
        val roundTripped = codec.decode(
            RuntimeApprovalDecisionRequestDto.serializer(),
            codec.encode(RuntimeApprovalDecisionRequestDto.serializer(), cancelReq),
        )
        assertEquals("cancel", roundTripped.decision)
        assertEquals("cancel", roundTripped.elicitationResponse?.action)
    }
}
