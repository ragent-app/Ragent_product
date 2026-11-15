package com.andysagent.ragent.core.appapi

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import kotlin.test.*

class TaskExecutionLeaseTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun root() = File(temporary.root, "leases")
    private suspend fun busy(block: suspend () -> Unit) {
        val failure = assertFailsWith<AppApiException> { block() }
        assertEquals(ApiErrorCode.RATE_LIMITED, failure.error.code)
        assertTrue(failure.error.retryable)
    }

    @Test fun separateInstancesRejectOverlapAndReleaseAfterCancellation() = runBlocking {
        val first = FileTaskExecutionLease(root())
        val second = FileTaskExecutionLease(root())
        val entered = CompletableDeferred<Unit>()
        val owner = launch { first.withLease("one") { entered.complete(Unit); awaitCancellation() } }
        withTimeout(5_000) { entered.await() }
        try {
            busy { second.withLease("one") { fail("Concurrent body ran") } }
            second.withLease("two") { assertNotEquals(taskLeaseSlot("one"), taskLeaseSlot("two")) }
        } finally { owner.cancelAndJoin() }
        second.withLease("one") { }
        assertEquals(2, root().listFiles()!!.size)
    }

    @Test fun exceptionDoesNotLeaveAnInProcessOrOsLease() = runBlocking {
        assertFailsWith<IllegalStateException> {
            FileTaskExecutionLease(root()).withLease("one") { error("Synthetic failure") }
        }
        FileTaskExecutionLease(root()).withLease("one") { }
    }

    @Test fun operationIdentityCannotBecomeAPathAndStorageIsBounded() = runBlocking {
        val lease = FileTaskExecutionLease(root())
        for (index in 0..255) lease.withLease("../foreign/$index") { }
        val files = root().listFiles()!!
        assertTrue(files.size <= 128)
        assertTrue(files.all { it.name.matches(Regex("operation-[0-9]+\\.lock")) })
        assertFalse(File(temporary.root, "foreign").exists())
    }

    @Test fun secondProcessCannotAcquireEvenAfterSameProcessContention() = runBlocking {
        val first = FileTaskExecutionLease(root())
        first.withLease("one") {
            busy { FileTaskExecutionLease(root()).withLease("one") { fail("Concurrent body ran") } }
            probe("try").useProcess { process ->
                assertEquals("BUSY", process.inputStream.bufferedReader().readLine())
                assertTrue(process.waitFor(5, TimeUnit.SECONDS))
                assertEquals(0, process.exitValue())
            }
        }
        probe("try").useProcess { process ->
            assertEquals("ACQUIRED", process.inputStream.bufferedReader().readLine())
            assertTrue(process.waitFor(5, TimeUnit.SECONDS))
        }
    }

    @Test fun abruptChildProcessDeathReleasesKernelLease() = runBlocking {
        root().mkdirs()
        probe("hold").useProcess { process ->
            assertEquals("ACQUIRED", process.inputStream.bufferedReader().readLine())
            busy { FileTaskExecutionLease(root()).withLease("one") { fail("Child owns lock") } }
            process.destroyForcibly()
            assertTrue(process.waitFor(5, TimeUnit.SECONDS))
            // On Windows the process handle may signal before the kernel has
            // completed cleanup of the terminated process's file locks.
            // Keep the deadline bounded and retry only the expected busy case.
            withTimeout(2_000) {
                while (true) {
                    try {
                        FileTaskExecutionLease(root()).withLease("one") { }
                        break
                    } catch (error: AppApiException) {
                        if (error.error.code != ApiErrorCode.RATE_LIMITED || !error.error.retryable) throw error
                        delay(25)
                    }
                }
            }
        }
    }

    private fun probe(mode: String): Process {
        val classpath = listOf(TaskLeaseProcessProbe::class.java, kotlin.Unit::class.java)
            .map { File(it.protectionDomain.codeSource.location.toURI()).absolutePath }.distinct().joinToString(File.pathSeparator)
        val java = File(System.getProperty("java.home"), "bin/java" + if (File.separatorChar == '\\') ".exe" else "")
        return ProcessBuilder(java.absolutePath, "-cp", classpath, TaskLeaseProcessProbe::class.java.name,
            File(root(), "operation-${taskLeaseSlot("one")}.lock").absolutePath, mode)
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
    }

    private inline fun <T> Process.useProcess(block: (Process) -> T): T = try {
        block(this)
    } finally {
        if (isAlive) destroyForcibly()
        waitFor(5, TimeUnit.SECONDS)
    }
}

/** Separate JVM so the test observes the kernel lock, not only the process-local guard. */
object TaskLeaseProcessProbe {
    @JvmStatic fun main(args: Array<String>) {
        FileChannel.open(File(args[0]).toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
            val lease = channel.tryLock()
            println(if (lease == null) "BUSY" else "ACQUIRED")
            System.out.flush()
            if (lease != null) lease.use { if (args[1] == "hold") System.`in`.read() }
        }
    }
}
