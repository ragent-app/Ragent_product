package com.andysagent.ragent

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import android.content.ContextWrapper
import com.andysagent.ragent.core.domain.*
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ContentReportJournalTest {
    @Test fun coldReadRetainsExactFrozenRequestOutsideBackupAndCorruptionCannotResetIt() = runBlocking {
        val application = ApplicationProvider.getApplicationContext<Context>()
        val root = File(application.cacheDir, "report-journal-test-${UUID.randomUUID()}")
        check(root.mkdirs())
        val context = object : ContextWrapper(application) {
            override fun getNoBackupFilesDir() = root
        }
        val journal = AndroidContentReportJournal(context)
        try {
            val record = ContentReportRecord(ContentReportPayload(requestId = "067ba243-89bd-411e-8ea7-5d939e426014",
                reason = "other", details = "synthetic test", includeContent = true, content = "fixture", appVersion = "0.0.1"))
            journal.write(record)
            assertEquals(record, AndroidContentReportJournal(context).read())
            val file = File(context.noBackupFilesDir, "content-reports/last-report.json")
            assertTrue(file.isFile)
            file.writeText("broken")
            assertTrue(runCatching { AndroidContentReportJournal(context).read() }.isFailure)
            assertEquals("broken", file.readText())
        } finally {
            journal.clear()
            check(root.canonicalFile.parentFile == application.cacheDir.canonicalFile)
            check(root.name.startsWith("report-journal-test-"))
            check(root.deleteRecursively())
        }
    }
}
