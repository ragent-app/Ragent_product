package com.andysagent.ragent.feature.workbench

import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import com.andysagent.ragent.core.designsystem.LocalAgentoBackdropRevision
import kotlin.math.ceil

/**
 * Smooth cosine distribution stops for progressive transparency fade.
 * Calibrated so that 50% opacity falls right at 50% progress.
 */
private val SmoothTopGradientStops = arrayOf(
    0.00f to 1.00f,
    0.15f to 0.98f,
    0.30f to 0.92f,
    0.50f to 0.78f, // Stronger masking across capsule center to avoid text bleed-through
    0.70f to 0.50f,
    0.85f to 0.20f,
    1.00f to 0.00f,
)

private val SmoothBottomGradientStops = arrayOf(
    0.00f to 0.00f,
    0.15f to 0.10f,
    0.30f to 0.25f,
    0.50f to 0.50f, // Exactly 50% opacity at composer center
    0.70f to 0.75f,
    0.85f to 0.90f,
    1.00f to 1.00f,
)

/**
 * Top progressive blur and pure solid canvas mask, calibrated so ~50% mask opacity
 * falls exactly at the vertical center of the top capsule.
 *
 * 1. Solid zone (0 .. [statusBarHeight]): 100% solid [canvasColor], protecting the OS status bar.
 * 2. Fade zone ([statusBarHeight] .. [topControlsHeight]): smoothstep fade from 100% to 0%.
 *    50% opacity is reached right at the vertical center of the top capsule.
 *    Reaches 0% at the bottom of the top controls so messages below are untouched.
 *
 * Does NOT consume pointer input so scrolling gestures pass straight through to the LazyColumn.
 */
@Composable
fun ChatTopGradientMask(
    topControlsHeight: Dp,
    canvasColor: Color,
    modifier: Modifier = Modifier,
    statusBarHeight: Dp = (topControlsHeight - 56.dp).coerceAtLeast(0.dp),
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    presentationAlpha: Float = 1f,
) {
    if (presentationAlpha <= 0f) return

    val density = LocalDensity.current
    val revision = LocalAgentoBackdropRevision.current
    val blurRadiusPx = with(density) { 16.dp.toPx() }
    val blurEffect = remember(density) {
        if (Build.VERSION.SDK_INT >= 31) {
            RenderEffect.createBlurEffect(blurRadiusPx, blurRadiusPx, Shader.TileMode.CLAMP).asComposeRenderEffect()
        } else null
    }

    val sampleLayer = rememberGraphicsLayer()
    val maskLayer = rememberGraphicsLayer()
    var maskOrigin by remember { mutableStateOf(IntOffset.Zero) }

    val totalHeight = topControlsHeight

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(totalHeight)
            .clearAndSetSemantics { }
            .graphicsLayer {
                alpha = presentationAlpha
            }
            .onGloballyPositioned { coordinates ->
                maskOrigin = coordinates.positionInRoot().round()
            }
            .drawWithCache {
                val widthPx = size.width
                val totalHeightPx = size.height
                val solidHeightPx = with(density) { statusBarHeight.toPx() }.coerceIn(0f, totalHeightPx)
                val fadeHeightPx = (totalHeightPx - solidHeightPx).coerceAtLeast(0f)

                val canvasSolidColor = canvasColor
                val canvasFadeBrush = Brush.verticalGradient(
                    colorStops = SmoothTopGradientStops.map { (frac, alpha) ->
                        frac to canvasColor.copy(alpha = alpha)
                    }.toTypedArray(),
                    startY = solidHeightPx,
                    endY = totalHeightPx,
                )

                val blurAlphaBrush = Brush.verticalGradient(
                    colorStops = arrayOf(
                        0.00f to Color.White.copy(alpha = 0.95f),
                        0.50f to Color.White.copy(alpha = 0.45f),
                        1.00f to Color.Transparent,
                    ),
                    startY = 0f,
                    endY = fadeHeightPx,
                )

                onDrawWithContent {
                    // 1. Solid pure canvas color over status bar
                    if (solidHeightPx > 0f) {
                        drawRect(
                            color = canvasSolidColor,
                            topLeft = Offset.Zero,
                            size = Size(widthPx, solidHeightPx),
                        )
                    }

                    // 2. Progressive blur in the fade band across the top controls
                    if (backdropLayer != null && Build.VERSION.SDK_INT >= 31 && blurEffect != null &&
                        fadeHeightPx > 0f && widthPx > 0f && revision.value >= 0
                    ) {
                        val margin = ceil(blurRadiusPx * 2).toInt()
                        val relX = backdropOrigin.x - maskOrigin.x
                        val relY = backdropOrigin.y - (maskOrigin.y + solidHeightPx.toInt())

                        sampleLayer.renderEffect = blurEffect
                        sampleLayer.record(this, layoutDirection, IntSize(
                            ceil(widthPx).toInt() + margin * 2,
                            ceil(fadeHeightPx).toInt() + margin * 2,
                        )) {
                            translate(
                                left = (margin + relX).toFloat(),
                                top = (margin + relY).toFloat(),
                            ) {
                                drawLayer(backdropLayer)
                            }
                        }

                        maskLayer.compositingStrategy = androidx.compose.ui.graphics.layer.CompositingStrategy.Offscreen
                        maskLayer.record(this, layoutDirection, IntSize(
                            ceil(widthPx).toInt(),
                            ceil(fadeHeightPx).toInt(),
                        )) {
                            translate(-margin.toFloat(), -margin.toFloat()) {
                                drawLayer(sampleLayer)
                            }
                            drawRect(blurAlphaBrush, blendMode = BlendMode.DstIn)
                        }

                        translate(top = solidHeightPx) {
                            drawLayer(maskLayer)
                        }
                    }

                    // 3. Smooth solid canvas color fade out across the top controls
                    if (fadeHeightPx > 0f) {
                        drawRect(
                            brush = canvasFadeBrush,
                            topLeft = Offset(0f, solidHeightPx),
                            size = Size(widthPx, fadeHeightPx),
                        )
                    }
                }
            }
    )
}

/**
 * Bottom progressive blur and pure solid canvas mask, calibrated so ~50% mask opacity
 * falls exactly at the vertical center of the Composer.
 *
 * 1. Fade zone (0 .. [fadeHeightPx]): starts [fadeExtensionAboveComposer] above composer and fades
 *    down across the composer. 50% opacity is reached right at the vertical center of the Composer.
 * 2. Solid zone: 100% solid [canvasColor] covering below the composer (nav bar / bottom spacing).
 *
 * Does NOT consume pointer input so scrolling gestures pass straight through to the LazyColumn.
 */
@Composable
fun ChatBottomGradientMask(
    dockHeight: Dp,
    canvasColor: Color,
    modifier: Modifier = Modifier,
    composerHeight: Dp = 56.dp,
    fadeExtensionAboveComposer: Dp = 6.dp,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    presentationAlpha: Float = 1f,
) {
    if (presentationAlpha <= 0f) return

    val density = LocalDensity.current
    val revision = LocalAgentoBackdropRevision.current
    val blurRadiusPx = with(density) { 16.dp.toPx() }
    val blurEffect = remember(density) {
        if (Build.VERSION.SDK_INT >= 31) {
            RenderEffect.createBlurEffect(blurRadiusPx, blurRadiusPx, Shader.TileMode.CLAMP).asComposeRenderEffect()
        } else null
    }

    val sampleLayer = rememberGraphicsLayer()
    val maskLayer = rememberGraphicsLayer()
    var maskOrigin by remember { mutableStateOf(IntOffset.Zero) }

    val totalHeight = dockHeight + fadeExtensionAboveComposer

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(totalHeight)
            .clearAndSetSemantics { }
            .graphicsLayer {
                alpha = presentationAlpha
            }
            .onGloballyPositioned { coordinates ->
                maskOrigin = coordinates.positionInRoot().round()
            }
            .drawWithCache {
                val widthPx = size.width
                val totalHeightPx = size.height
                val extensionPx = with(density) { fadeExtensionAboveComposer.toPx() }
                val composerHeightPx = with(density) { composerHeight.toPx() }
                val fadeHeightPx = (extensionPx + composerHeightPx).coerceIn(0f, totalHeightPx)
                val solidHeightPx = (totalHeightPx - fadeHeightPx).coerceAtLeast(0f)

                val canvasFadeBrush = Brush.verticalGradient(
                    colorStops = SmoothBottomGradientStops.map { (frac, alpha) ->
                        frac to canvasColor.copy(alpha = alpha)
                    }.toTypedArray(),
                    startY = 0f,
                    endY = fadeHeightPx,
                )

                val blurAlphaBrush = Brush.verticalGradient(
                    colorStops = arrayOf(
                        0.00f to Color.Transparent,
                        0.50f to Color.White.copy(alpha = 0.45f),
                        1.00f to Color.White.copy(alpha = 0.95f),
                    ),
                    startY = 0f,
                    endY = fadeHeightPx,
                )

                onDrawWithContent {
                    // 1. Progressive blur in the fade zone across the composer
                    if (backdropLayer != null && Build.VERSION.SDK_INT >= 31 && blurEffect != null &&
                        fadeHeightPx > 0f && widthPx > 0f && revision.value >= 0
                    ) {
                        val margin = ceil(blurRadiusPx * 2).toInt()
                        val relX = backdropOrigin.x - maskOrigin.x
                        val relY = backdropOrigin.y - maskOrigin.y

                        sampleLayer.renderEffect = blurEffect
                        sampleLayer.record(this, layoutDirection, IntSize(
                            ceil(widthPx).toInt() + margin * 2,
                            ceil(fadeHeightPx).toInt() + margin * 2,
                        )) {
                            translate(
                                left = (margin + relX).toFloat(),
                                top = (margin + relY).toFloat(),
                            ) {
                                drawLayer(backdropLayer)
                            }
                        }

                        maskLayer.compositingStrategy = androidx.compose.ui.graphics.layer.CompositingStrategy.Offscreen
                        maskLayer.record(this, layoutDirection, IntSize(
                            ceil(widthPx).toInt(),
                            ceil(fadeHeightPx).toInt(),
                        )) {
                            translate(-margin.toFloat(), -margin.toFloat()) {
                                drawLayer(sampleLayer)
                            }
                            drawRect(blurAlphaBrush, blendMode = BlendMode.DstIn)
                        }

                        drawLayer(maskLayer)
                    }

                    // 2. Smooth solid canvas color fade in across the composer
                    if (fadeHeightPx > 0f) {
                        drawRect(
                            brush = canvasFadeBrush,
                            topLeft = Offset.Zero,
                            size = Size(widthPx, fadeHeightPx),
                        )
                    }

                    // 3. Solid pure canvas color below the composer (nav bar / bottom spacing)
                    if (solidHeightPx > 0f) {
                        drawRect(
                            color = canvasColor,
                            topLeft = Offset(0f, fadeHeightPx),
                            size = Size(widthPx, solidHeightPx),
                        )
                    }
                }
            }
    )
}
