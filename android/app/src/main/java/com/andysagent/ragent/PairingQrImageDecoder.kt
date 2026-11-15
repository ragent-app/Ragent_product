package com.andysagent.ragent

import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/** Shared image path for camera frames and deterministic, camera-free QR validation. */
internal class PairingQrImageDecoder(
    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
    ),
) : AutoCloseable {
    fun process(image: InputImage): Task<List<Barcode>> = scanner.process(image)

    override fun close() = scanner.close()
}
