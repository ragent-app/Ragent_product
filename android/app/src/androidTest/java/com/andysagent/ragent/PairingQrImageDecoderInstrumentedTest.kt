package com.andysagent.ragent

import android.graphics.BitmapFactory
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.TimeUnit

class PairingQrImageDecoderInstrumentedTest {
    @Test
    fun bundledMlKitDecodesThePairingQrWithoutCameraOrPlayServices() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val bitmap = context.assets.open(PAIRING_QR_ASSET).use { stream ->
            requireNotNull(BitmapFactory.decodeStream(stream)) { "QR test image could not be decoded" }
        }
        val decoder = PairingQrImageDecoder()
        try {
            val barcodes = Tasks.await(
                decoder.process(InputImage.fromBitmap(bitmap, 0)),
                DECODE_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            )
            assertEquals("expected exactly one pairing QR", 1, barcodes.size)
            assertEquals(PAIRING_URI, barcodes.single().rawValue)
        } finally {
            decoder.close()
            bitmap.recycle()
        }
    }

    private companion object {
        const val PAIRING_QR_ASSET = "pairing-link-qr.png"
        const val DECODE_TIMEOUT_SECONDS = 20L
        const val PAIRING_URI =
            "ragent://pair?v=3&i=inst_local_001&e=https%3A%2F%2Fcomputer.example.test" +
                "&t=rpi_0123456789abcdef0123456789abcdef&x=2099-08-09T09%3A02%3A00.000Z"
    }
}
