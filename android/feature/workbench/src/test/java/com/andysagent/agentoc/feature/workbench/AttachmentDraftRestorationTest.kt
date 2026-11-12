package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AttachmentDraftRestorationTest {
    @get:Rule val rule = createComposeRule()

    @Test fun activityStateRestorationRetainsBothDraftFiles() {
        val owner = AttachmentDraftOwner("pc", null, "project")
        val files = listOf(
            ComposerAttachment(id = "1", name = "first.bin", localPath = "content://first"),
            ComposerAttachment(id = "2", name = "second.bin", localPath = "content://second"),
        )
        lateinit var store: AttachmentDraftStore
        val tester = StateRestorationTester(rule)
        tester.setContent {
            val current = rememberSaveable(saver = AttachmentDraftStore.Saver) { AttachmentDraftStore() }
            SideEffect { store = current }
        }
        rule.runOnIdle { store[owner] = files }
        tester.emulateSavedInstanceStateRestore()
        rule.runOnIdle { assertEquals(files, store[owner]) }
    }
}
