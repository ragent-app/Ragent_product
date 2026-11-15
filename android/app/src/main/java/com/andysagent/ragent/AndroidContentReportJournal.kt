package com.andysagent.ragent

import android.content.Context
import android.util.AtomicFile
import com.andysagent.ragent.core.domain.ContentReportJournal
import com.andysagent.ragent.core.domain.ContentReportRecord
import com.andysagent.ragent.core.domain.validateContentReportRecord
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Deliberately excluded from cloud/ADB backup and scoped to this installation. */
internal class AndroidContentReportJournal(context: Context) : ContentReportJournal {
    private val directory = File(context.noBackupFilesDir, "content-reports")
    private val file = AtomicFile(File(directory, "last-report.json"))
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }

    override suspend fun read(): ContentReportRecord? = withContext(Dispatchers.IO) {
        // Only absence is empty. Corrupt/inaccessible data cannot silently reset request identity.
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@withContext null
        val bytes = file.openRead().use { stream ->
            val buffer = ByteArray(24 * 1024 + 1)
            var count = 0
            while (count < buffer.size) {
                val read = stream.read(buffer, count, buffer.size - count)
                if (read < 0) break
                count += read
            }
            buffer.copyOf(count)
        }
        check(bytes.size <= 24 * 1024)
        json.decodeFromString<ContentReportRecord>(bytes.toString(Charsets.UTF_8)).also(::validateContentReportRecord)
    }
    override suspend fun write(record: ContentReportRecord) = withContext(Dispatchers.IO) {
        validateContentReportRecord(record)
        val bytes = json.encodeToString(record).toByteArray(Charsets.UTF_8)
        check(bytes.size <= 24 * 1024)
        check(directory.isDirectory || directory.mkdirs())
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Throwable) { file.failWrite(stream); throw error }
    }
    override suspend fun clear() = withContext(Dispatchers.IO) {
        file.delete()
        check(!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()
            && !File(file.baseFile.path + ".new").exists())
    }
}
