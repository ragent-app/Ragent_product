package com.andysagent.ragent

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.IconCompat
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.datastore.LinkedComputer
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class CaptureShortcutIconTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun themed(night: Boolean): Context = context.createConfigurationContext(
        Configuration(context.resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        })

    @Test fun iconDependsOnlyOnPlatformAndNeverOnComputerNameLanguage() {
        val computer = LinkedComputer("pc-alpha", "", "Office", platform = "win32")
        val original = CaptureShortcutIcon.bitmap(computer)
        assertEquals(IconCompat.TYPE_ADAPTIVE_BITMAP, CaptureShortcutIcon.create(computer).type)
        assertTrue(original.sameAs(CaptureShortcutIcon.bitmap(computer)))
        val renamed = CaptureShortcutIcon.bitmap(computer.copy(label = "Home"))
        assertEquals(original.getPixel(0, 0), renamed.getPixel(0, 0))
        assertTrue(original.sameAs(renamed))
        assertTrue(original.sameAs(CaptureShortcutIcon.bitmap(computer.copy(label = "家用电脑", instanceId = "another-pc"))))
        assertEquals(255, Color.alpha(original.getPixel(0, 0)))
        assertTrue(ColorUtils.calculateLuminance(original.getPixel(0, 0)) > 0.75)
        val others = listOf("linux", "darwin", null).map { CaptureShortcutIcon.bitmap(computer.copy(platform = it)) }
        assertTrue(others.all { !it.sameAs(original) })
        assertEquals(4, (others + original).map { it.getPixel(0, 0) }.distinct().size)
        assertTrue(original.sameAs(CaptureShortcutIcon.bitmap(computer)))
    }

    @Test fun platformAliasesResolveWithoutInferringFromLabels() {
        for (value in listOf("win32", " Windows ", "WIN64", "windows_nt")) assertEquals(CaptureShortcutIcon.Platform.WINDOWS, CaptureShortcutIcon.platform(value))
        for (value in listOf("linux", "GNU/Linux")) assertEquals(CaptureShortcutIcon.Platform.LINUX, CaptureShortcutIcon.platform(value))
        for (value in listOf("darwin", "macOS", "Mac", "OSX", "Mac OS X")) assertEquals(CaptureShortcutIcon.Platform.MACOS, CaptureShortcutIcon.platform(value))
        for (value in listOf(null, "", "unknown")) assertEquals(CaptureShortcutIcon.Platform.UNKNOWN, CaptureShortcutIcon.platform(value))
    }

    @Test fun launcherBackgroundFollowsSystemThemeWithoutChangingBrandForeground() {
        val light = themed(false).getDrawable(R.mipmap.ic_launcher) as AdaptiveIconDrawable
        val dark = themed(true).getDrawable(R.mipmap.ic_launcher) as AdaptiveIconDrawable
        fun render(drawable: android.graphics.drawable.Drawable): Bitmap {
            val bitmap = Bitmap.createBitmap(216, 216, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, 216, 216); drawable.draw(Canvas(bitmap))
            return bitmap
        }
        assertTrue(ColorUtils.calculateLuminance(render(light.background).getPixel(108, 108)) > 0.9)
        assertTrue(ColorUtils.calculateLuminance(render(dark.background).getPixel(108, 108)) < 0.03)
        assertTrue(render(light.foreground).sameAs(render(dark.foreground)))
    }

    @Test fun renderFrameworkMaskedLightAndDarkIconReview() {
        val board = Bitmap.createBitmap(1000, 560, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(board)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val computers = listOf(LinkedComputer("pc-windows", "", "Windows", platform = "win32"),
            LinkedComputer("pc-linux", "", "Linux", platform = "linux"), LinkedComputer("pc-mac", "", "macOS", platform = "darwin"))
        listOf(false, true).forEachIndexed { row, night ->
            val y = row * 280
            paint.color = if (night) Color.rgb(20, 22, 28) else Color.rgb(250, 251, 253)
            canvas.drawRect(0f, y.toFloat(), 1000f, (y + 280).toFloat(), paint)
            paint.color = if (night) Color.WHITE else Color.rgb(35, 39, 46)
            paint.textSize = 22f; paint.textAlign = Paint.Align.LEFT
            canvas.drawText(if (night) "Dark system surface" else "Light system surface", 28f, y + 35f, paint)
            val scoped = themed(night)
            val icons = listOf(scoped.getDrawable(R.mipmap.ic_launcher)!!) + computers.map {
                CaptureShortcutIcon.create(it).toIcon(scoped).loadDrawable(scoped)!!
            }
            icons.forEachIndexed { column, drawable ->
                val x = 45 + column * 250
                drawable.setBounds(x, y + 62, x + 150, y + 212); drawable.draw(canvas)
                paint.textAlign = Paint.Align.CENTER
                canvas.drawText(listOf("Ragent", "Windows", "Linux", "macOS")[column], x + 75f, y + 246f, paint)
            }
        }
        File(context.cacheDir, "share-icons-review.png").outputStream().use {
            assertTrue(board.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }
}
