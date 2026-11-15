package com.andysagent.ragent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Runs the same bundled ML Kit QR decoder as PairingQrScannerActivity on a dense signed payload. */
@RunWith(AndroidJUnit4::class)
class PairingQrMlKitDecodeTest {
    @Test
    fun decodesFullTemporaryPairingEnvelope() {
        val instrumentationContext = InstrumentationRegistry.getInstrumentation().context
        val bitmap = instrumentationContext.assets.open(IMAGE_FILE_NAME).use { BitmapFactory.decodeStream(it) }
        assertNotNull("Generated QR fixture must be a valid PNG", bitmap)
        val sourceBitmap = requireNotNull(bitmap)

        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
        try {
            for (width in listOf(640, 596, 564, 390, 360)) {
                val scaled = if (sourceBitmap.width == width) sourceBitmap else
                    Bitmap.createScaledBitmap(sourceBitmap, width, width, true)
                try {
                    val barcode = Tasks.await(
                        scanner.process(InputImage.fromBitmap(scaled, 0)),
                        20,
                        TimeUnit.SECONDS,
                    ).firstOrNull()
                    val value = barcode?.rawValue
                    assertNotNull("Bundled ML Kit must decode the full signed temporary QR at ${width}px", value)
                    assertTrue(value!!.startsWith("{\"version\":1,\"envelope\":{\"invitation\":{"))
                    assertTrue(value.contains("\"invitationId\":\"rti_0123456789abcdefghijklmnopqrstuv\""))
                    assertTrue(value.endsWith("\"token\":\"rtt_0123456789abcdefghijklmnopqrstuv\"}"))
                } finally {
                    if (scaled !== sourceBitmap) scaled.recycle()
                }
            }
        } finally {
            scanner.close()
            sourceBitmap.recycle()
        }
    }

    private companion object {
        const val IMAGE_FILE_NAME = "pairing-full-signed-qr.png"
    }
}
