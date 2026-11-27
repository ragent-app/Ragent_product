package com.andysagent.ragent.core.designsystem

import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.ceil

/**
 * Narrow, progressive blur at system edges, independent of floating control
 * bounds. The sharp capture is retained for glass; only the reading copy fades.
 */
fun Modifier.agentoReadingEdges(
    backdrop: GraphicsLayer,
    topInsetPx: () -> Float,
    bottomInsetPx: () -> Float,
    presentationAlpha: Float = 1f,
): Modifier = composed {
    val density = LocalDensity.current
    val revision = LocalAgentoBackdropRevision.current
    val bandPx = with(density) { 28.dp.toPx() }
    val fadePx = with(density) { 16.dp.toPx() }
    val radii = with(density) { listOf(4.dp.toPx(), 12.dp.toPx()) }
    val effects = remember(density) {
        radii.map { radius ->
            if (Build.VERSION.SDK_INT >= 31) RenderEffect.createBlurEffect(
                radius, radius, Shader.TileMode.CLAMP,
            ).asComposeRenderEffect() else null
        }
    }
    // Two small edge strips at two blur levels; never blur four full screens.
    val samples = List(4) { rememberGraphicsLayer() }
    val masks = List(4) { rememberGraphicsLayer() }
    graphicsLayer {
        alpha = presentationAlpha
        compositingStrategy = CompositingStrategy.Offscreen
    }.drawWithCache {
        val height = size.height.coerceAtLeast(1f)
        val top = topInsetPx().coerceIn(0f, height)
        val bottom = (height - bottomInsetPx()).coerceIn(top, height)
        val band = bandPx.coerceAtMost((bottom - top) / 2f)
        val fade = fadePx.coerceAtMost(band)
        val visibility = Brush.verticalGradient(
            0f to Color.Transparent,
            top / height to Color.Transparent,
            (top + fade * .5f) / height to Color.White.copy(alpha = .5f),
            (top + fade) / height to Color.White,
            (bottom - fade) / height to Color.White,
            (bottom - fade * .5f) / height to Color.White.copy(alpha = .5f),
            bottom / height to Color.Transparent,
            1f to Color.Transparent,
        )
        val strengths = List(4) { index ->
            val topEdge = index < 2
            val strong = index % 2 == 1
            val stops = if (strong) arrayOf(
                0f to Color.White, .5f to Color.Transparent, 1f to Color.Transparent,
            ) else arrayOf(0f to Color.White, 1f to Color.Transparent)
            Brush.verticalGradient(
                *stops,
                startY = if (topEdge) 0f else band,
                endY = if (topEdge) band else 0f,
            )
        }
        onDrawWithContent {
            // Capture once, before all effects. Never feed softened edges back
            // into a glass surface, and never obscure its sharp foreground.
            recordToLayer(backdrop)
            // As with glass controls, invalidate the sampled RenderNodes when
            // a lazy-list child updates without recomposing this modifier.
            if (band > 0f && size.width > 0f && Build.VERSION.SDK_INT >= 31 && revision.value >= 0) {
                repeat(4) { index ->
                    val start = if (index < 2) top else bottom - band
                    val stage = index % 2
                    val margin = ceil(radii[stage] * 2).toInt()
                    val sample = samples[index]
                    sample.renderEffect = effects[stage]
                    sample.record(this, layoutDirection, IntSize(
                        ceil(size.width).toInt() + margin * 2, ceil(band).toInt() + margin * 2,
                    )) {
                        translate(margin.toFloat(), margin - start) { drawLayer(backdrop) }
                    }
                    val masked = masks[index]
                    masked.compositingStrategy = androidx.compose.ui.graphics.layer.CompositingStrategy.Offscreen
                    masked.record(this, layoutDirection, IntSize(ceil(size.width).toInt(), ceil(band).toInt())) {
                        translate(-margin.toFloat(), -margin.toFloat()) { drawLayer(sample) }
                        drawRect(strengths[index], blendMode = BlendMode.DstIn)
                    }
                    translate(top = start) { drawLayer(masked) }
                }
            }
            // Only the final 8dp fades away; the rest of the 24dp band stays
            // fully opaque and progressively loses detail instead of vanishing.
            drawRect(visibility, blendMode = BlendMode.DstIn)
        }
    }
}
