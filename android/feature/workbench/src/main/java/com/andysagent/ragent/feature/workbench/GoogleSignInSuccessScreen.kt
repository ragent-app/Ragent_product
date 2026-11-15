package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*

@Composable
fun GoogleSignInSuccessScreen(
    action: GoogleSignInSuccessAction,
    onAction: (GoogleSignInSuccessAction) -> Unit,
    modifier: Modifier = Modifier,
    accountLabel: String? = null,
) {
    val colors = LocalRagentColors.current
    Box(modifier.fillMaxSize().background(colors.canvas), contentAlignment = Alignment.TopCenter) {
        OnboardingPageContent(Modifier.widthIn(max = 440.dp).fillMaxSize().systemBarsPadding()
            .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) { compact ->
            SuccessCheckMark()
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.onboarding_signed_in), color = colors.primaryContent,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, lineHeight = 36.sp,
                    fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
                textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            accountLabel?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 280.dp))
            }
            Spacer(Modifier.height(if (compact) 28.dp else 36.dp))
            AgentoButton(
                stringResource(if (action == GoogleSignInSuccessAction.EnterApp) R.string.onboarding_enter_workspace
                    else R.string.journey_setup_computer),
                { onAction(action) }, Modifier.widthIn(min = 200.dp, max = 280.dp).testTag("sign-in-success-action"),
                decision = true, labelMaxLines = 3,
                contentPadding = PaddingValues(horizontal = 24.dp, vertical = 14.dp),
                labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 22.sp),
            )
        }
    }
}

@Composable
private fun SuccessCheckMark() {
    val colors = LocalRagentColors.current
    val motion = LocalMotionPolicy.current.preference
    val progress = remember { Animatable(if (motion == MotionPreference.Full) 0f else 1f) }
    val description = stringResource(R.string.onboarding_success_description)
    LaunchedEffect(motion) {
        if (motion == MotionPreference.Full) progress.animateTo(1f, tween(320)) else progress.snapTo(1f)
    }
    Canvas(Modifier.size(72.dp).semantics { contentDescription = description }) {
        val inset = 3.dp.toPx()
        drawCircle(colors.success.copy(alpha = 0.12f), radius = size.minDimension / 2)
        val unit = size.minDimension / 72f
        val path = Path().apply {
            moveTo(20f * unit, 36f * unit)
            lineTo(31f * unit, 47f * unit)
            lineTo(52f * unit, 25f * unit)
        }
        val measure = PathMeasure().apply { setPath(path, false) }
        val visible = Path()
        measure.getSegment(0f, measure.length * progress.value, visible, true)
        drawPath(visible, colors.success, style = Stroke(inset, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}
