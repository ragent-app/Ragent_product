package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors

/** A single account, carried between two devices; decorative, with no simulated controls. */
@Composable
internal fun AccountConnectionIllustration(compact: Boolean, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val dark = colors.canvas.red < 0.5f
    val blue = colors.accentPrimary
    val violet = if (dark) Color(0xFFAAA0FF) else Color(0xFF7B6AE0)
    val surface = if (dark) Color(0xFF242630) else Color.White
    val edge = if (dark) Color(0xFF4A5062) else Color(0xFFD5DEED)
    val description = stringResource(R.string.sign_in_guide_connection_path_description)
    val width = if (compact) 224.dp else 256.dp
    Canvas(modifier.width(width).height(width * (184f / 256f))
        .semantics { contentDescription = description }) {
        scale(size.width / 256f, size.height / 184f, pivot = Offset.Zero) {
            drawOval(blue.copy(alpha = if (dark) 0.08f else 0.045f), Offset(16f, 164f), Size(218f, 14f))

            // Computer: a fine rim, a softly tinted screen, and a restrained stand.
            drawRoundRect(edge, Offset(92f, 126f), Size(28f, 27f), CornerRadius(3f))
            drawRoundRect(surface, Offset(94f, 126f), Size(24f, 26f), CornerRadius(2f))
            drawRoundRect(edge, Offset(70f, 151f), Size(72f, 4f), CornerRadius(2f))
            drawRoundRect(blue.copy(alpha = 0.04f), Offset(17f, 31f), Size(182f, 112f), CornerRadius(13f))
            drawRoundRect(surface, Offset(14f, 26f), Size(182f, 112f), CornerRadius(13f))
            drawRoundRect(edge, Offset(14f, 26f), Size(182f, 112f), CornerRadius(13f), style = Stroke(1.2f))
            drawRoundRect(Brush.linearGradient(listOf(
                blue.copy(alpha = if (dark) 0.17f else 0.08f),
                violet.copy(alpha = if (dark) 0.12f else 0.035f),
            )), Offset(21f, 33f), Size(168f, 89f), CornerRadius(8f))
            drawLine(edge.copy(alpha = 0.65f), Offset(21f, 124f), Offset(189f, 124f), 0.8f)
            drawCircle(edge, 1.5f, Offset(105f, 131f))
            accountPortrait(Offset(105f, 77f), 25f, blue)

            // Phone overlaps the computer slightly, with the same identity motif.
            drawRoundRect(blue.copy(alpha = 0.08f), Offset(170f, 64f), Size(67f, 113f), CornerRadius(14f))
            drawRoundRect(surface, Offset(167f, 60f), Size(67f, 113f), CornerRadius(14f))
            drawRoundRect(edge, Offset(167f, 60f), Size(67f, 113f), CornerRadius(14f), style = Stroke(1.2f))
            drawRoundRect(Brush.verticalGradient(listOf(violet.copy(alpha = 0.11f), blue.copy(alpha = 0.04f))),
                Offset(172f, 65f), Size(57f, 103f), CornerRadius(10f))
            drawRoundRect(edge, Offset(191f, 68f), Size(19f, 3f), CornerRadius(2f))
            accountPortrait(Offset(200.5f, 113f), 18f, violet)
            drawLine(violet.copy(alpha = 0.4f), Offset(193f, 160f), Offset(208f, 160f), 2f, StrokeCap.Round)
        }
    }
}

private fun DrawScope.accountPortrait(center: Offset, radius: Float, tint: Color) {
    drawCircle(Brush.linearGradient(listOf(tint, tint.copy(alpha = 0.72f)),
        start = center - Offset(radius, radius), end = center + Offset(radius, radius)), radius, center)
    drawCircle(Color.White.copy(alpha = 0.96f), radius * 0.24f, center - Offset(0f, radius * 0.23f))
    val shoulders = Path().apply {
        moveTo(center.x - radius * 0.48f, center.y + radius * 0.44f)
        cubicTo(center.x - radius * 0.48f, center.y - radius * 0.05f,
            center.x + radius * 0.48f, center.y - radius * 0.05f,
            center.x + radius * 0.48f, center.y + radius * 0.44f)
        quadraticTo(center.x, center.y + radius * 0.7f,
            center.x - radius * 0.48f, center.y + radius * 0.44f)
        close()
    }
    drawPath(shoulders, Color.White.copy(alpha = 0.96f))
}
