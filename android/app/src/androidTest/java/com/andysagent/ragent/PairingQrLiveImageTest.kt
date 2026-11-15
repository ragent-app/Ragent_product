package com.andysagent.ragent

import android.app.Instrumentation
import android.graphics.BitmapFactory
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Camera-free check of a live QR bitmap rendered by the PC web UI's QrCreator. */
@RunWith(AndroidJUnit4::class)
class PairingQrLiveImageTest {
    @Test
    fun decodesTheExactStagedTemporaryTicketFromLiveWebQrImage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue("Stage both live ticket and QR image before this test",
            InstrumentationRegistry.getArguments().getString("liveQrImage") == "true")

        val expected = readDeviceFile(instrumentation, TICKET_FILE).toString(Charsets.UTF_8).trim()
        val imageBytes = readDeviceFile(instrumentation, QR_IMAGE_FILE)
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)) {
            "The rendered live QR image must be a readable bitmap"
        }
        val decoder = PairingQrImageDecoder()
        try {
            val barcodes = Tasks.await(
                decoder.process(InputImage.fromBitmap(bitmap, 0)),
                DECODE_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            )
            assertEquals("the web UI's live QR image must contain exactly one code", 1, barcodes.size)
            assertNotNull("the live temporary ticket must be optically decodable", barcodes.single().rawValue)
            assertEquals("decoded QR data must equal the complete ticket accepted by Android",
                expected, barcodes.single().rawValue)
        } finally {
            decoder.close()
            bitmap.recycle()
        }
    }

    private fun readDeviceFile(
        instrumentation: Instrumentation,
        path: String,
    ): ByteArray {
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat $path")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
    }

    private companion object {
        const val TICKET_FILE = "/data/local/tmp/ragent-temporary-pairing-ticket.json"
        const val QR_IMAGE_FILE = "/data/local/tmp/ragent-live-pairing-qr.png"
        const val DECODE_TIMEOUT_SECONDS = 20L
    }
}
