package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.ApprovalAction
import com.andysagent.ragent.core.model.ApprovalExplanation
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AttentionPresentationTest {
    @Test fun `option descriptions omit redundant instructions but retain real consequences`() {
        assertEquals(null, questionOptionDetail("Canary", "Choose Canary as the answer."))
        assertEquals(null, questionOptionDetail("Full", "Select \"Full\" as your answer"))
        assertEquals(null, questionOptionDetail("Canary", "Canary"))
        assertEquals("Choose Canary as the answer only for a staged rollout.",
            questionOptionDetail("Canary", "Choose Canary as the answer only for a staged rollout."))
        assertEquals("Publishes to all users", questionOptionDetail("Full", "Publishes to all users"))
    }
    private val approval = Approval("a", "s", "Export report", reason = "Writes a shared report", actions = listOf(
        ApprovalAction("one", description = "Export sources", summary = "Export audited report", command = "export --sources", cwd = "C:/Reports")))
    private val item = AttentionItem("i", "s", "Weekly report", AttentionKind.Approval, "Export report", "Export report", approval = approval)

    @Test fun `operation and real consequence have distinct roles`() {
        assertEquals(ApprovalPresentation("Export audited report", "Writes a shared report"), approvalPresentation(item))
        assertEquals(ApprovalPresentation("Export report", null), approvalPresentation(item.copy(approval = approval.copy(actions = emptyList(), reason = "Export report"))))
    }

    @Test fun `server explanation is the overview and original command remains available`() {
        val described = approval.copy(actions = emptyList(), command = "rm example", explanation = ApprovalExplanation(
            summary = "Removes an example", reason = "Deletion may be permanent", saferAlternative = "Review it first", operation = "delete"))
        val describedItem = item.copy(approval = described)
        assertEquals(ApprovalPresentation("Removes an example", "Deletion may be permanent"), approvalPresentation(describedItem))
        assertTrue(approvalDetails(describedItem, false).any { it.value == "rm example" })
    }

    @Test fun `selectable actions are not repeated in technical list and full payload is retained`() {
        val inline = approvalDetails(item, skipActionList = false)
        assertTrue(inline.any { it.value == "export --sources" })
        assertTrue(inline.any { it.value == "C:/Reports" })
        val batch = approvalDetails(item, skipActionList = true)
        assertFalse(batch.any { it.value == "export --sources" || it.value == "Export audited report" })
        assertTrue(batch.any { it.value == "Writes a shared report" })
    }

    @Test fun `reveal has continuous geometry and bounded endpoints`() {
        assertEquals(0, attentionDisclosureHeight(200, -1f))
        assertEquals(100, attentionDisclosureHeight(200, .5f))
        assertEquals(200, attentionDisclosureHeight(200, 2f))
        assertEquals(0, attentionDisclosureHeight(-200, .5f))
    }

    @Test fun `ordinary approval shows the actual command and scope`() {
        val ordinary = approval.copy(actions = emptyList(), command = "echo test", cwd = "/work", filePaths = listOf("/work/file"), grantRoot = "/work")
        val details = approvalDetails(item.copy(approval = ordinary), skipActionList = false)
        assertTrue(details.any { it.value == "echo test" })
        assertTrue(details.any { it.value == "/work/file" })
        assertTrue(details.any { it.value == "/work" })
    }

    @Test fun `permission details show network and exact file scopes`() {
        val details = approvalPermissionDetails("""{"network":{"enabled":true},"fileSystem":{"read":["/a"],"write":["/b"]}}""")
        assertTrue(details.any { it.label == R.string.approval_scope_network })
        assertTrue(details.any { it.label == R.string.approval_scope_read && it.value == "/a" })
        assertTrue(details.any { it.label == R.string.approval_scope_write && it.value == "/b" })
    }

    @Test fun `claude optional permission suggestions are not shown as active scope`() {
        val details = approvalPermissionDetails("""{"suggestions":[{"type":"addRules","destination":"localSettings"}],"network":{"enabled":true},"extra":{"mode":"custom"}}""")
        assertTrue(details.any { it.label == R.string.approval_scope_network })
        assertTrue(details.any { it.value.contains("extra") })
        assertFalse(details.any { it.value.contains("suggestions") })
    }
}
