package com.andysagent.ragent.core.designsystem

import android.graphics.Paint as AndroidPaint
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.coroutines.isActive

enum class AgentoAuraPhase {
    Idle,
    Start,
    Running,
    WaitingApproval,
    Completed,
    Error,
    Listening,
    Thinking,
    Speaking,
}

enum class AgentoAuraSemanticTone {
    Brand,
    Waiting,
    Success,
    Error,
    Voice,
}

data class AgentoAuraOptics(
    val intensity: Float,
    val reach: Float,
    val prism: Float,
    val surge: Float,
    val speed: Float,
    val semanticTone: AgentoAuraSemanticTone,
    val targetFrameMs: Long,
    val shouldSleep: Boolean,
)

private const val AURA_START_MS = 1100L
private const val AURA_IDLE_SETTLE_MS = 1200L
private const val AURA_APPROVAL_BREATHE_MS = 1600L
private const val AURA_COMPLETE_MS = 1200L
private const val AURA_ERROR_MS = 900L

/**
 * Computes optical parameters and frame-pacing discipline for [AgentoHorizonAura].
 * Every foreground phase (`Idle`, `Completed`, `WaitingApproval`, post-flash `Error`,
 * etc.) sustains continuous gentle undulation (`shouldSleep = false`), sleeping to
 * 0fps only when backgrounded or when Reduced Motion is active.
 */
fun computeAgentoAuraOptics(
    phase: AgentoAuraPhase,
    phaseElapsedMs: Long,
    nowMs: Long,
    isDark: Boolean,
    voiceLevel: Float = 0f,
): AgentoAuraOptics {
    val elapsed = phaseElapsedMs.coerceAtLeast(0L)
    val level = voiceLevel.coerceIn(0f, 1f)
    val idleRestIntensity = if (isDark) 0.28f else 0.34f
    val runBaseIntensity = if (isDark) 0.52f else 0.66f
    val peakIntensity = if (isDark) 0.68f else 0.82f

    return when (phase) {
        AgentoAuraPhase.Start -> {
            val p = (elapsed.toFloat() / AURA_START_MS).coerceIn(0f, 1f)
            val bell = sin(p * PI.toFloat())
            val settleEase = p.pow(2.2f)
            AgentoAuraOptics(
                intensity = (idleRestIntensity + (peakIntensity - idleRestIntensity) * bell).coerceIn(0f, 1f),
                reach = (0.30f + 0.14f * bell).coerceIn(0.10f, 0.48f),
                prism = (0.42f + 0.42f * bell).coerceIn(0f, 1f),
                surge = (0.58f * (1f - 0.35f * settleEase)).coerceIn(-1f, 1f),
                speed = (2.05f - 0.45f * settleEase).coerceIn(0.2f, 3f),
                semanticTone = AgentoAuraSemanticTone.Brand,
                targetFrameMs = if (p >= 1f) 33L else 16L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Running -> {
            val breath = sin(nowMs * 0.0021f)
            AgentoAuraOptics(
                intensity = (runBaseIntensity + (if (isDark) 0.05f else 0.06f) * breath).coerceIn(0f, 1f),
                reach = (0.34f + 0.03f * breath).coerceIn(0.10f, 0.48f),
                prism = 0.72f,
                surge = 0.06f * (1f + sin(nowMs * 0.0015f)),
                speed = 1.65f,
                semanticTone = AgentoAuraSemanticTone.Brand,
                targetFrameMs = 33L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.WaitingApproval -> {
            val p = (elapsed.toFloat() / AURA_APPROVAL_BREATHE_MS).coerceIn(0f, 1f)
            val settled = elapsed >= AURA_APPROVAL_BREATHE_MS
            val wave = if (!settled) sin(p * PI.toFloat() * 2f) * (1f - 0.35f * p) else 0f
            val holdPulse = sin(nowMs * 0.0016f)
            val holdBase = if (isDark) 0.24f else 0.42f
            AgentoAuraOptics(
                intensity = (holdBase + if (!settled) (if (isDark) 0.05f else 0.07f) * wave else 0.07f * holdPulse).coerceIn(0f, 1f),
                reach = (if (!settled) 0.21f + 0.03f * wave.coerceAtLeast(0f) else 0.22f + 0.035f * holdPulse).coerceIn(0.10f, 0.48f),
                prism = 0.38f,
                surge = if (!settled) 0.14f * wave else 0f,
                speed = if (!settled) 0.85f else 0.72f,
                semanticTone = AgentoAuraSemanticTone.Waiting,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Completed -> {
            val p = (elapsed.toFloat() / AURA_COMPLETE_MS).coerceIn(0f, 1f)
            val settled = elapsed >= AURA_COMPLETE_MS
            val ease = 1f - (1f - p).pow(2.1f)
            val drift = sin(nowMs * 0.00145f)
            val hueDrift = 0.5f + 0.5f * cos(nowMs * 0.00072f)
            val startStr = if (isDark) 0.40f else 0.66f
            val restStr = idleRestIntensity + (if (isDark) 0.085f else 0.095f) * drift
            val restReach = 0.25f + 0.045f * drift
            AgentoAuraOptics(
                intensity = (startStr + (restStr - startStr) * ease).coerceIn(0f, 1f),
                reach = (0.29f + (restReach - 0.29f) * ease).coerceIn(0.10f, 0.48f),
                prism = (0.72f + ((0.56f + 0.22f * hueDrift) - 0.72f) * ease).coerceIn(0f, 1f),
                surge = if (settled) 0f else (-0.42f * (1f - ease * 0.88f)).coerceIn(-1f, 1f),
                speed = (1.65f + (0.88f - 1.65f) * ease).coerceIn(0.2f, 3f),
                semanticTone = if (settled) AgentoAuraSemanticTone.Brand else AgentoAuraSemanticTone.Success,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Error -> {
            val p = (elapsed.toFloat() / AURA_ERROR_MS).coerceIn(0f, 1f)
            val settled = elapsed >= AURA_ERROR_MS
            val ease = 1f - (1f - p).pow(2.2f)
            val drift = sin(nowMs * 0.00145f)
            val hueDrift = 0.5f + 0.5f * cos(nowMs * 0.00072f)
            val peakErr = if (isDark) 0.30f else 0.48f
            val restStr = idleRestIntensity + (if (isDark) 0.085f else 0.095f) * drift
            val restReach = 0.25f + 0.045f * drift
            AgentoAuraOptics(
                intensity = if (settled) restStr.coerceIn(0f, 1f) else (peakErr * (1f - ease)).coerceIn(0f, 1f),
                reach = if (settled) restReach.coerceIn(0.10f, 0.48f) else (0.24f - 0.10f * ease).coerceIn(0.10f, 0.48f),
                prism = if (settled) (0.56f + 0.22f * hueDrift).coerceIn(0f, 1f) else (0.36f * (1f - ease)).coerceIn(0f, 1f),
                surge = if (settled) 0f else (-0.44f * (1f - ease)).coerceIn(-1f, 1f),
                speed = if (settled) 0.85f else (0.95f * (1f - 0.60f * ease)).coerceIn(0.2f, 3f),
                semanticTone = if (settled) AgentoAuraSemanticTone.Brand else AgentoAuraSemanticTone.Error,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Listening -> {
            AgentoAuraOptics(
                intensity = ((if (isDark) 0.48f else 0.58f) + level * 0.34f).coerceIn(0f, 1f),
                reach = (0.34f + level * 0.14f).coerceIn(0.10f, 0.48f),
                prism = (0.68f + level * 0.24f).coerceIn(0f, 1f),
                surge = (0.14f + level * 0.45f).coerceIn(-1f, 1f),
                speed = (1.35f + level * 1.15f).coerceIn(0.2f, 3f),
                semanticTone = AgentoAuraSemanticTone.Voice,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Thinking -> {
            val pulse = 0.5f + 0.5f * cos(nowMs * 0.0026f)
            AgentoAuraOptics(
                intensity = ((if (isDark) 0.48f else 0.60f) + pulse * 0.10f).coerceIn(0f, 1f),
                reach = (0.34f + pulse * 0.04f).coerceIn(0.10f, 0.48f),
                prism = 0.80f,
                surge = 0.18f * pulse,
                speed = 1.65f,
                semanticTone = AgentoAuraSemanticTone.Brand,
                targetFrameMs = 28L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Speaking -> {
            AgentoAuraOptics(
                intensity = ((if (isDark) 0.52f else 0.64f) + level * 0.32f).coerceIn(0f, 1f),
                reach = (0.34f + level * 0.14f).coerceIn(0.10f, 0.48f),
                prism = (0.74f + level * 0.20f).coerceIn(0f, 1f),
                surge = (-0.24f - level * 0.40f).coerceIn(-1f, 1f),
                speed = (1.50f + level * 1.0f).coerceIn(0.2f, 3f),
                semanticTone = AgentoAuraSemanticTone.Voice,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }

        AgentoAuraPhase.Idle -> {
            val p = (elapsed.toFloat() / AURA_IDLE_SETTLE_MS).coerceIn(0f, 1f)
            val ease = 1f - (1f - p).pow(2f)
            val drift = sin(nowMs * 0.00145f)
            val hueDrift = 0.5f + 0.5f * cos(nowMs * 0.00072f)
            val entryStr = if (isDark) 0.36f else 0.44f
            val restStr = idleRestIntensity + (if (isDark) 0.085f else 0.095f) * drift
            val restReach = 0.26f + 0.048f * drift
            AgentoAuraOptics(
                intensity = (entryStr + (restStr - entryStr) * ease).coerceIn(0f, 1f),
                reach = (0.30f + (restReach - 0.30f) * ease).coerceIn(0.10f, 0.48f),
                prism = (0.56f + 0.22f * hueDrift).coerceIn(0f, 1f),
                surge = 0f,
                speed = (1.15f + (0.92f - 1.15f) * ease).coerceIn(0.2f, 3f),
                semanticTone = AgentoAuraSemanticTone.Brand,
                targetFrameMs = 22L,
                shouldSleep = false,
            )
        }
    }
}

private const val RagentHorizonAuraAgsl = """
    uniform float2 uRes;
    uniform float uDpr;
    uniform float uTime;
    uniform float uDark;
    uniform float uReach;
    uniform float uIntensity;
    uniform float uPrism;
    uniform float uSurge;
    uniform float uAmbient;
    uniform float3 uPrimaryRgb;
    uniform float3 uAccentRgb;
    uniform float3 uSemanticRgb;
    uniform float uSemanticWeight;

    float hash2(float2 p) {
        p = fract(p * float2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    float ign(float2 p) {
        return fract(52.9829189 * fract(dot(p, float2(0.06711056, 0.00583715))));
    }

    float valueNoise(float2 p) {
        float2 i = floor(p);
        float2 f = fract(p);
        float2 u = f * f * (3.0 - 2.0 * f);
        float a = hash2(i);
        float b = hash2(i + float2(1.0, 0.0));
        float c = hash2(i + float2(0.0, 1.0));
        float d = hash2(i + float2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float fbm3(float2 p) {
        float sum = 0.0625;
        float amp = 0.5;
        for (int i = 0; i < 3; i++) {
            sum += amp * valueNoise(p);
            p = p * 2.03 + float2(17.1, 13.7);
            amp *= 0.5;
        }
        return sum;
    }

    float perspectiveHalftone(float2 px, float2 res, float yNorm, float t, float cell, float maskVal) {
        float persp = 1.0 / (0.55 + max(yNorm, 0.0));
        float2 g = float2((px.x - res.x * 0.5) * persp, res.y * log(0.55 + max(yNorm, 0.0)));
        g.x += sin(t * 0.55 + yNorm * 3.2) * 14.0;
        g.y += 14.0 * sin(g.x * 0.0085 + t * 0.92) + 5.0 * sin(g.x * 0.021 - t * 0.64) - t * 6.5;
        float2 cellUv = fract(g / cell) - 0.5;
        float dist = length(cellUv);
        float aa = clamp(1.25 / max(cell, 1.0), 0.045, 0.14);
        float radius = 0.10 + 0.18 * maskVal;
        return (1.0 - smoothstep(radius - aa, radius + aa * 0.35, dist)) * maskVal;
    }

    half4 main(float2 fragCoord) {
        float2 res = max(uRes, float2(1.0));
        // AGSL fragCoord.y = 0 at top; anchor horizon at bottom edge.
        float yBottom = (res.y - fragCoord.y) / res.y;
        float reach = max(uReach, 0.05);
        float surgeUp = max(uSurge, 0.0);
        float y = yBottom / reach;
        if (y > 1.72 + 0.22 * surgeUp) {
            return half4(0.0);
        }

        float uvX = fragCoord.x / res.x;
        float topFeather = 1.0 - smoothstep(1.18 + 0.14 * surgeUp, 1.70 + 0.22 * surgeUp, y);
        float t = uTime;

        float waveA = sin(uvX * 4.6 - t * 1.05);
        float waveB = sin(uvX * 7.8 + t * 0.78 + 1.4);
        float curtain = 0.5 + 0.34 * waveA + 0.16 * waveB;
        float swell = 0.30 * waveA + 0.16 * waveB;
        float lobe1X = 0.50 + 0.34 * sin(t * 0.62);
        float lobe2X = 0.50 + 0.30 * cos(t * 0.43 + 1.1);
        float d1 = (uvX - lobe1X) / 0.28;
        float d2 = (uvX - lobe2X) / 0.24;
        float lobe1 = exp(-d1 * d1);
        float lobe2 = exp(-d2 * d2);
        float roam = 0.52 + 0.48 * lobe1 + 0.34 * lobe2;
        float xEdge = mix(0.45, 1.0, smoothstep(0.0, 0.18, uvX) * (1.0 - smoothstep(0.82, 1.0, uvX)));

        float2 px = fragCoord / max(uDpr, 0.5);
        float2 logRes = res / max(uDpr, 0.5);
        float2 p = (px - logRes * 0.5) / max(logRes.y, 1.0);
        float2 q = p + 0.09 * float2(
            fbm3(p * 2.0 + float2(t * 0.22, 0.0)),
            fbm3(p * 2.0 + float2(3.1, -t * 0.18))
        ) - 0.045;

        float jut = (fbm3(float2(px.x / 180.0 + t * 0.36, t * 0.22)) - 0.5) * 0.62;
        float h = max(y + 0.42 * (jut - swell) + 0.10 * (fbm3(float2(px.x / 90.0 - t * 0.28, t * 0.18 + 3.0)) - 0.5), 0.0);
        float glow = exp(-h * h * 2.35) * (0.62 + 0.58 * curtain) * roam * xEdge;
        if (glow * topFeather < 0.0008 && abs(uSurge) < 0.001) {
            return half4(0.0);
        }

        float n = fbm3(q * 3.0 + t * 0.22);
        float field = (1.0 - exp(-1.8 * glow * (0.75 + 0.45 * n))) * 1.13;

        float colorPhase = uvX * 1.25 - t * 0.34 + 0.28 * fbm3(q * 1.6);
        float blendWave = 0.5 + 0.5 * sin(colorPhase * 6.2831853);
        float3 brandBase = mix(uPrimaryRgb, uAccentRgb, blendWave);
        float3 prismIris = float3(0.56, 0.44, 0.96);
        float3 prismCyan = float3(0.32, 0.76, 0.98);
        float3 prismTint = mix(prismCyan, prismIris, 0.5 + 0.5 * sin(colorPhase * 6.2831853 + 1.2));
        float3 baseRgb = mix(brandBase, prismTint, uPrism * 0.68);
        baseRgb = mix(baseRgb, uSemanticRgb, clamp(uSemanticWeight, 0.0, 1.0));

        float dotBoost = 0.0;
        if (uSurge > 0.001) {
            float xRel = (uvX - 0.5) * 2.0;
            float xSpan = smoothstep(0.0, 0.22, uvX) * (1.0 - smoothstep(0.78, 1.0, uvX));
            float frontY = 0.42 + 0.45 * uSurge - 0.15 * xRel * xRel + 0.06 * jut;
            float dy = y - frontY;
            float arc = (dy >= 0.0 ? exp(-dy * dy * 22.0) : exp(-dy * dy * 5.2)) * uSurge * xSpan;
            field = clamp(field + arc * 0.48, 0.0, 1.0);
            baseRgb = mix(baseRgb, uAccentRgb, clamp(arc * 0.72, 0.0, 0.85));
            dotBoost += arc * 0.55;
        } else if (uSurge < -0.001) {
            float cp = clamp(-uSurge, 0.0, 1.0);
            float rx = abs(uvX - 0.5);
            float dr = (rx - cp * 0.48) / 0.14;
            float hRip = exp(-dr * dr) + 0.30 * (1.0 - cp) * exp(-rx * rx * 16.0);
            float dsy = y - 0.22;
            float vSet = exp(-dsy * dsy * 13.0) * (1.0 - smoothstep(1.05, 1.35, y));
            float chime = hRip * vSet * cp;
            field = clamp(field + chime * 0.44, 0.0, 1.0);
            baseRgb = mix(baseRgb, uSemanticRgb, clamp(chime * 0.78, 0.0, 0.85));
            dotBoost += chime * 0.42;
        }

        float hot = 0.72 * smoothstep(0.65, 1.0, field);
        field *= topFeather;
        dotBoost *= topFeather;

        // Particle feel: perspective halftone specks constrained to transition band & surge waves.
        float band = smoothstep(0.16, 0.46, field) * (1.0 - smoothstep(0.68, 0.96, field));
        float dotMask = clamp(band * (0.45 + 0.55 * smoothstep(-0.08, 0.26, -jut)) + dotBoost * 0.85, 0.0, 1.0);
        float dotAlpha = dotMask > 0.001 ? perspectiveHalftone(px, logRes, yBottom, t, 8.5, dotMask) : 0.0;
        float grain = hash2(px + fract(t * 7.0) * 91.0) - 0.5;

        float3 fillRgb;
        float3 dotRgb;
        float a;
        float da;
        if (uDark > 0.5) {
            float3 fill = baseRgb * (1.0 + 0.28 * hot) * mix(0.95, 1.28, uIntensity);
            fillRgb = clamp(fill + grain * 0.022, 0.0, 1.0);
            dotRgb = clamp(min(fill * 1.65 + 0.10, float3(1.0)), 0.0, 1.0);
            a = clamp(field * 0.64 * mix(0.75, 1.32, uIntensity) * uAmbient, 0.0, 1.0);
            da = clamp(dotAlpha * sqrt(max(a, 0.0)) * 0.92, 0.0, 1.0);
        } else {
            // Light mode dichroic wash: avoid muddy grey on bright surfaces.
            float washPh = uvX * 3.1 + t * 0.46 + 1.25 * n;
            float3 inkRgb = mix(uPrimaryRgb * 0.86, uAccentRgb * 0.92, 0.5 + 0.5 * sin(washPh));
            inkRgb = mix(inkRgb, uSemanticRgb * 0.90, clamp(uSemanticWeight, 0.0, 1.0));
            fillRgb = clamp(inkRgb + grain * 0.020, 0.0, 1.0);
            dotRgb = clamp(mix(uPrimaryRgb * 0.84, prismIris * 0.92, 0.45), 0.0, 1.0);
            a = clamp(field * 0.52 * mix(0.82, 1.38, uIntensity) * uAmbient, 0.0, 0.78);
            da = clamp(dotAlpha * (0.50 + 0.42 * sqrt(max(a, 0.0))) * uAmbient, 0.0, 0.82);
        }

        float outAlpha = clamp(a + da * (1.0 - a), 0.0, 1.0);
        float3 premul = fillRgb * a * (1.0 - da) + dotRgb * da;
        if (outAlpha > 0.0015) {
            float2 dp = fragCoord + fract(t * 3.0) * float2(37.0, 19.0);
            float tpdf = ign(dp) - ign(dp.yx + float2(11.3, 27.1));
            premul += (tpdf / 255.0) * min(1.0, outAlpha * 2.5);
            outAlpha = clamp(outAlpha + tpdf * (0.5 / 255.0), 0.0, 1.0);
        }
        premul = clamp(premul, float3(0.0), float3(outAlpha));
        return half4(half3(premul), half(outAlpha));
    }
"""

@Composable
fun AgentoHorizonAura(
    phase: AgentoAuraPhase,
    modifier: Modifier = Modifier,
    voiceLevel: Float = 0f,
    ambientIntensity: Float = 1f,
    heightFraction: Float = 0.32f,
    bottomBleedPx: Float = 0f,
    renderHeightOverridePx: Float? = null,
    verticalOffsetPx: Float = 0f,
    sharedClock: HorizonEdgeAuraController? = null,
) {
    val motionPreference = LocalMotionPolicy.current.preference
    val backgrounded = LocalAgentoBackgrounded.current
    if (motionPreference == MotionPreference.None || ambientIntensity <= 0.005f) {
        return
    }

    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val density = LocalDensity.current
    val clampedAmbient = ambientIntensity.coerceIn(0f, 1f)
    val clampedHeight = heightFraction.coerceIn(0.12f, 0.65f)

    val phaseEnteredAtMs = remember(phase) { mutableLongStateOf(System.currentTimeMillis()) }
    val frameNowMs = remember { mutableLongStateOf(phaseEnteredAtMs.longValue) }
    val animTimeSec = remember { androidx.compose.runtime.mutableFloatStateOf(0f) }

    LaunchedEffect(phase, motionPreference, backgrounded, sharedClock != null) {
        if (sharedClock != null) return@LaunchedEffect
        val enterMs = System.currentTimeMillis()
        phaseEnteredAtMs.longValue = enterMs
        frameNowMs.longValue = enterMs
        if (motionPreference != MotionPreference.Full || backgrounded) {
            return@LaunchedEffect
        }
        var lastDrawNs = 0L
        var prevFrameNs = 0L
        while (isActive) {
            var shouldContinue = true
            withFrameNanos { nowNs ->
                if (prevFrameNs == 0L) prevFrameNs = nowNs
                val nowMs = System.currentTimeMillis()
                val elapsedMs = (nowMs - enterMs).coerceAtLeast(0L)
                val optics = computeAgentoAuraOptics(
                    phase = phase,
                    phaseElapsedMs = elapsedMs,
                    nowMs = nowMs,
                    isDark = isDark,
                    voiceLevel = voiceLevel,
                )
                if (optics.shouldSleep) {
                    frameNowMs.longValue = nowMs
                    shouldContinue = false
                    return@withFrameNanos
                }
                val gapMs = if (lastDrawNs == 0L) Long.MAX_VALUE else (nowNs - lastDrawNs) / 1_000_000L
                if (gapMs >= optics.targetFrameMs) {
                    val dtSec = ((nowNs - prevFrameNs).coerceIn(0L, 50_000_000L)) / 1_000_000_000f
                    animTimeSec.floatValue = (animTimeSec.floatValue + dtSec * optics.speed) % 10_000f
                    frameNowMs.longValue = nowMs
                    lastDrawNs = nowNs
                    prevFrameNs = nowNs
                }
            }
            if (!shouldContinue) break
        }
    }

    val runtimeShader = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching { RuntimeShader(RagentHorizonAuraAgsl) }.getOrNull()
        } else {
            null
        }
    }

    val resolvedPhaseEnteredAtMs = sharedClock?.phaseEnteredAtMs?.longValue ?: phaseEnteredAtMs.longValue
    val resolvedFrameNowMsProvider: () -> Long = sharedClock?.let { clock ->
        { clock.frameNowMs.longValue }
    } ?: { frameNowMs.longValue }
    val resolvedTimeSecProvider: () -> Float = sharedClock?.let { clock ->
        { clock.animTimeSec.floatValue }
    } ?: { animTimeSec.floatValue }

    if (runtimeShader != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        AgslHorizonAuraCanvas(
            runtimeShader = runtimeShader,
            phase = phase,
            phaseEnteredAtMs = resolvedPhaseEnteredAtMs,
            frameNowMsProvider = resolvedFrameNowMsProvider,
            timeSecProvider = resolvedTimeSecProvider,
            isDark = isDark,
            voiceLevel = voiceLevel,
            ambientIntensity = clampedAmbient,
            heightFraction = clampedHeight,
            bottomBleedPx = bottomBleedPx,
            renderHeightOverridePx = renderHeightOverridePx,
            verticalOffsetPx = verticalOffsetPx,
            dprScaled = density.density * 0.7f,
            motionPreference = motionPreference,
            primaryColor = colors.actionPrimary,
            accentColor = colors.accentPrimary,
            waitingColor = colors.waiting,
            successColor = colors.success,
            errorColor = colors.error,
            modifier = modifier.fillMaxSize().testTag("agento-horizon-aura"),
        )
    } else {
        FallbackHorizonAuraCanvas(
            phase = phase,
            phaseEnteredAtMs = resolvedPhaseEnteredAtMs,
            frameNowMsProvider = resolvedFrameNowMsProvider,
            isDark = isDark,
            voiceLevel = voiceLevel,
            ambientIntensity = clampedAmbient,
            heightFraction = clampedHeight,
            bottomBleedPx = bottomBleedPx,
            renderHeightOverridePx = renderHeightOverridePx,
            verticalOffsetPx = verticalOffsetPx,
            motionPreference = motionPreference,
            primaryColor = colors.actionPrimary,
            accentColor = colors.accentPrimary,
            waitingColor = colors.waiting,
            successColor = colors.success,
            errorColor = colors.error,
            modifier = modifier.fillMaxSize().testTag("agento-horizon-aura"),
        )
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun AgslHorizonAuraCanvas(
    runtimeShader: RuntimeShader,
    phase: AgentoAuraPhase,
    phaseEnteredAtMs: Long,
    frameNowMsProvider: () -> Long,
    timeSecProvider: () -> Float,
    isDark: Boolean,
    voiceLevel: Float,
    ambientIntensity: Float,
    heightFraction: Float,
    bottomBleedPx: Float,
    renderHeightOverridePx: Float?,
    verticalOffsetPx: Float,
    dprScaled: Float,
    motionPreference: MotionPreference,
    primaryColor: Color,
    accentColor: Color,
    waitingColor: Color,
    successColor: Color,
    errorColor: Color,
    modifier: Modifier = Modifier,
) {
    val paint = remember { AndroidPaint().apply { isAntiAlias = true } }
    Box(
        modifier = modifier.drawBehind {
            if (size.width <= 1f || size.height <= 1f) return@drawBehind
            val effectiveHeight = (renderHeightOverridePx ?: (size.height + bottomBleedPx)).coerceAtLeast(1f)
            val nowMs = frameNowMsProvider()
            val elapsedMs = if (motionPreference == MotionPreference.Reduced) 450L else (nowMs - phaseEnteredAtMs).coerceAtLeast(0L)
            val optics = computeAgentoAuraOptics(
                phase = phase,
                phaseElapsedMs = elapsedMs,
                nowMs = if (motionPreference == MotionPreference.Reduced) 0L else nowMs,
                isDark = isDark,
                voiceLevel = voiceLevel,
            )
            if (optics.intensity <= 0.002f) return@drawBehind

            val (semanticRgb, semanticWeight) = resolveSemanticColor(
                tone = optics.semanticTone,
                primary = primaryColor,
                accent = accentColor,
                waiting = waitingColor,
                success = successColor,
                error = errorColor,
            )

            runtimeShader.setFloatUniform("uRes", size.width, effectiveHeight)
            runtimeShader.setFloatUniform("uDpr", dprScaled.coerceAtLeast(0.5f))
            runtimeShader.setFloatUniform("uTime", if (motionPreference == MotionPreference.Reduced) 1.2f else timeSecProvider())
            runtimeShader.setFloatUniform("uDark", if (isDark) 1f else 0f)
            runtimeShader.setFloatUniform("uReach", (optics.reach * (heightFraction / 0.32f).coerceAtLeast(0.35f)).coerceIn(0.10f, 0.72f))
            runtimeShader.setFloatUniform("uIntensity", optics.intensity)
            runtimeShader.setFloatUniform("uPrism", optics.prism)
            runtimeShader.setFloatUniform("uSurge", optics.surge)
            runtimeShader.setFloatUniform("uAmbient", ambientIntensity)
            runtimeShader.setFloatUniform("uPrimaryRgb", primaryColor.red, primaryColor.green, primaryColor.blue)
            runtimeShader.setFloatUniform("uAccentRgb", accentColor.red, accentColor.green, accentColor.blue)
            runtimeShader.setFloatUniform("uSemanticRgb", semanticRgb.red, semanticRgb.green, semanticRgb.blue)
            runtimeShader.setFloatUniform("uSemanticWeight", semanticWeight)

            paint.shader = runtimeShader
            val topY = (effectiveHeight * (1f - (heightFraction * 1.72f).coerceIn(0.20f, 0.88f))).coerceAtLeast(0f)
            withTransform({
                if (verticalOffsetPx != 0f) {
                    translate(left = 0f, top = verticalOffsetPx)
                }
            }) {
                drawIntoCanvas { canvas ->
                    canvas.nativeCanvas.drawRect(0f, topY, size.width, effectiveHeight, paint)
                }
            }
        },
    )
}

@Composable
private fun FallbackHorizonAuraCanvas(
    phase: AgentoAuraPhase,
    phaseEnteredAtMs: Long,
    frameNowMsProvider: () -> Long,
    isDark: Boolean,
    voiceLevel: Float,
    ambientIntensity: Float,
    heightFraction: Float,
    bottomBleedPx: Float,
    renderHeightOverridePx: Float?,
    verticalOffsetPx: Float,
    motionPreference: MotionPreference,
    primaryColor: Color,
    accentColor: Color,
    waitingColor: Color,
    successColor: Color,
    errorColor: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        if (size.width <= 1f || size.height <= 1f) return@Canvas
        val effectiveHeight = (renderHeightOverridePx ?: (size.height + bottomBleedPx)).coerceAtLeast(1f)
        val nowMs = frameNowMsProvider()
        val elapsedMs = if (motionPreference == MotionPreference.Reduced) 450L else (nowMs - phaseEnteredAtMs).coerceAtLeast(0L)
        val optics = computeAgentoAuraOptics(
            phase = phase,
            phaseElapsedMs = elapsedMs,
            nowMs = if (motionPreference == MotionPreference.Reduced) 0L else nowMs,
            isDark = isDark,
            voiceLevel = voiceLevel,
        )
        if (optics.intensity <= 0.002f) return@Canvas

        val (semanticRgb, semanticWeight) = resolveSemanticColor(
            tone = optics.semanticTone,
            primary = primaryColor,
            accent = accentColor,
            waiting = waitingColor,
            success = successColor,
            error = errorColor,
        )
        val tint = if (semanticWeight > 0.1f) semanticRgb else accentColor
        val alpha = (optics.intensity * ambientIntensity * if (isDark) 0.42f else 0.28f).coerceIn(0f, 0.65f)
        val bandHeight = effectiveHeight * (optics.reach * (heightFraction / 0.32f).coerceAtLeast(0.35f)).coerceIn(0.10f, 0.65f)
        val topY = (effectiveHeight - bandHeight).coerceAtLeast(0f)

        withTransform({
            if (verticalOffsetPx != 0f) {
                translate(left = 0f, top = verticalOffsetPx)
            }
        }) {
            drawRect(
                brush = Brush.verticalGradient(
                    colors = listOf(Color.Transparent, tint.copy(alpha = alpha * 0.45f), tint.copy(alpha = alpha)),
                    startY = topY,
                    endY = effectiveHeight,
                ),
                topLeft = Offset(0f, topY),
                size = Size(size.width, bandHeight),
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(primaryColor.copy(alpha = alpha * 0.6f), Color.Transparent),
                    center = Offset(size.width * 0.5f, effectiveHeight),
                    radius = size.width * 0.55f,
                ),
                center = Offset(size.width * 0.5f, effectiveHeight),
                radius = size.width * 0.55f,
            )
        }
    }
}

private fun resolveSemanticColor(
    tone: AgentoAuraSemanticTone,
    primary: Color,
    accent: Color,
    waiting: Color,
    success: Color,
    error: Color,
): Pair<Color, Float> = when (tone) {
    AgentoAuraSemanticTone.Brand -> accent to 0f
    AgentoAuraSemanticTone.Voice -> Color(0xFF56C8FF).let { cyan ->
        Color(
            red = (accent.red + cyan.red) * 0.5f,
            green = (accent.green + cyan.green) * 0.5f,
            blue = (accent.blue + cyan.blue) * 0.5f,
            alpha = 1f,
        ) to 0.35f
    }
    AgentoAuraSemanticTone.Waiting -> waiting to 0.85f
    AgentoAuraSemanticTone.Success -> success to 0.72f
    AgentoAuraSemanticTone.Error -> error to 0.90f
}

/** Convenience helper so existing [AgentoFrostedTokens] stays referenced directly for default palettes. */
internal val DefaultAuraBrandRgb: Color = AgentoFrostedTokens.BrandPrimary
