package com.andysagent.ragent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import android.util.Size
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** In-app QR scanner backed by the bundled ML Kit model; it works without Google Play services. */
@ExperimentalGetImage
class PairingQrScannerActivity : ComponentActivity() {
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val frameInFlight = AtomicBoolean(false)
    private lateinit var decoder: PairingQrImageDecoder
    private var previewView: PreviewView? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var status by mutableStateOf<String?>(null)

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else fail("需要相机权限才能扫描配对二维码")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        decoder = PairingQrImageDecoder()
        setContent {
            RagentTheme {
                Surface(color = Color.Black) {
                    val context = LocalContext.current
                    DisposableEffect(Unit) {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            startCamera()
                        } else {
                            cameraPermission.launch(Manifest.permission.CAMERA)
                        }
                        onDispose { }
                    }
                    Box(Modifier.fillMaxSize().background(Color.Black)) {
                        AndroidView(
                            factory = { ctx ->
                                PreviewView(ctx).also {
                                    it.scaleType = PreviewView.ScaleType.FILL_CENTER
                                    it.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                                    previewView = it
                                }
                            },
                            modifier = Modifier.fillMaxSize(),
                        )
                        Canvas(
                            modifier = Modifier.align(Alignment.Center).size(288.dp),
                        ) {
                            val guide = Color.White.copy(alpha = 0.78f)
                            val inset = 2.dp.toPx()
                            val size = this.size.width
                            val stroke = 4.dp.toPx()
                            val corner = 28.dp.toPx()
                            drawRoundRect(
                                color = Color.White.copy(alpha = 0.28f),
                                topLeft = Offset(inset, inset),
                                size = androidx.compose.ui.geometry.Size(size - inset * 2, size - inset * 2),
                                cornerRadius = CornerRadius(22.dp.toPx()),
                                style = Stroke(width = 1.5.dp.toPx()),
                            )
                            val corners = listOf(
                                Triple(Offset(inset, inset), Offset(inset + corner, inset), Offset(inset, inset + corner)),
                                Triple(Offset(size - inset, inset), Offset(size - inset - corner, inset), Offset(size - inset, inset + corner)),
                                Triple(Offset(inset, size - inset), Offset(inset + corner, size - inset), Offset(inset, size - inset - corner)),
                                Triple(Offset(size - inset, size - inset), Offset(size - inset - corner, size - inset), Offset(size - inset, size - inset - corner)),
                            )
                            corners.forEach { (origin, horizontal, vertical) ->
                                drawLine(guide, origin, horizontal, strokeWidth = stroke, cap = StrokeCap.Round)
                                drawLine(guide, origin, vertical, strokeWidth = stroke, cap = StrokeCap.Round)
                            }
                        }
                        Column(
                            modifier = Modifier.align(Alignment.BottomCenter).padding(horizontal = 24.dp, vertical = 32.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Text(status ?: getString(WorkbenchR.string.journey_scanner_hint), color = Color.White, style = MaterialTheme.typography.bodyLarge)
                            AgentoButton(text = getString(android.R.string.cancel), onClick = { setResult(RESULT_CANCELED); finish() })
                        }
                    }
                }
            }
        }
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            if (isFinishing || isDestroyed) return@addListener
            val provider = providerFuture.get()
            cameraProvider = provider
            val preview = Preview.Builder().build().also { useCase ->
                previewView?.let { useCase.surfaceProvider = it.surfaceProvider }
            }
            val analysis = ImageAnalysis.Builder()
                // Temporary invitation envelopes are intentionally signed and dense. A
                // higher analysis target gives ML Kit enough pixels per QR module on
                // desktop displays, while CameraX may fall back on devices that lack it.
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1920, 1080),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                            ),
                        )
                        .build(),
                )
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(cameraExecutor) { proxy ->
                val mediaImage = proxy.image
                if (mediaImage == null || !frameInFlight.compareAndSet(false, true)) {
                    proxy.close()
                    return@setAnalyzer
                }
                decoder.process(InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees))
                    .addOnSuccessListener { barcodes ->
                        val value = barcodes.firstNotNullOfOrNull { it.rawValue?.takeIf(String::isNotBlank) }
                        if (value != null && !isFinishing) {
                            setResult(RESULT_OK, Intent().putExtra(EXTRA_RAW_VALUE, value))
                            finish()
                        }
                    }
                    .addOnFailureListener { status = "无法识别二维码，请调整距离和角度" }
                    .addOnCompleteListener {
                        frameInFlight.set(false)
                        proxy.close()
                    }
            }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }.onFailure { fail("无法启动相机：${it.message.orEmpty()}") }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun fail(message: String) {
        setResult(RESULT_FIRST_USER, Intent().putExtra(EXTRA_ERROR, message))
        finish()
    }

    override fun onDestroy() {
        cameraProvider?.unbindAll()
        if (::decoder.isInitialized) decoder.close()
        cameraExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_RAW_VALUE = "com.andysagent.ragent.extra.PAIRING_QR"
        const val EXTRA_ERROR = "com.andysagent.ragent.extra.PAIRING_QR_ERROR"
    }
}
