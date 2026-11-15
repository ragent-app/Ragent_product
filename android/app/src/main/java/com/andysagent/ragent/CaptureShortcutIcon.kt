package com.andysagent.ragent

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.core.graphics.drawable.IconCompat
import androidx.core.graphics.PathParser
import com.andysagent.ragent.core.datastore.LinkedComputer
import java.util.Locale

/** Language-independent OS artwork; computer identity remains in the shortcut label. */
internal object CaptureShortcutIcon {
    const val VERSION = 3

    internal enum class Platform { WINDOWS, LINUX, MACOS, UNKNOWN }

    internal fun platform(value: String?): Platform = when (value?.trim()?.lowercase(Locale.ROOT)) {
        "win32", "win64", "windows", "windows_nt" -> Platform.WINDOWS
        "linux", "gnu/linux" -> Platform.LINUX
        "darwin", "macos", "mac", "osx", "mac os x" -> Platform.MACOS
        else -> Platform.UNKNOWN
    }

    fun create(target: LinkedComputer): IconCompat = IconCompat.createWithAdaptiveBitmap(bitmap(target))

    internal fun bitmap(target: LinkedComputer): Bitmap {
        val system = platform(target.platform)
        val background = when (system) {
            Platform.WINDOWS -> 0xFFE4EFFF
            Platform.LINUX -> 0xFFFFF1D9
            Platform.MACOS -> 0xFFEBEDF3
            Platform.UNKNOWN -> 0xFFEDF0F4
        }
        val bitmap = Bitmap.createBitmap(216, 216, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap).apply { scale(2f, 2f); drawColor(background.toInt()) }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        // All artwork stays inside the central 66 / 108 adaptive-icon safe zone.
        fun path(data: String, color: Int) {
            paint.color = color
            canvas.drawPath(requireNotNull(PathParser.createPathFromPathData(data)), paint)
        }
        when (system) {
            Platform.WINDOWS -> path(WINDOWS, 0xFF2367C9.toInt())
            Platform.MACOS -> path(MACOS, 0xFF424D63.toInt())
            Platform.LINUX -> {
                path(LINUX_BODY, 0xFF313844.toInt())
                path(LINUX_BELLY, Color.WHITE)
                path(LINUX_EYES, Color.WHITE)
                path(LINUX_PUPILS, 0xFF313844.toInt())
                path(LINUX_BEAK_FEET, 0xFFF0B43C.toInt())
            }
            Platform.UNKNOWN -> path(COMPUTER, 0xFF637086.toInt())
        }
        return bitmap
    }

    private const val WINDOWS = "M32,32 H52 V52 H32 Z M56,32 H76 V52 H56 Z M32,56 H52 V76 H32 Z M56,56 H76 V76 H56 Z"
    private const val MACOS = "M62,32 C63,27 67,24 72,24 C72,29 68,33 63,34 Z M54,38 C47,33 39,35 35,41 C29,50 32,63 39,73 C43,80 47,80 53,77 C58,74 62,80 67,77 C72,74 76,66 78,61 C67,57 65,45 75,39 C69,32 61,34 54,38 Z"
    private const val LINUX_BODY = "M54,27 C42,27 41,37 41,45 C37,52 32,64 35,71 C38,78 70,78 73,71 C76,64 71,52 67,45 C67,37 66,27 54,27 Z"
    private const val LINUX_BELLY = "M54,45 C44,45 40,56 40,64 C40,73 68,73 68,64 C68,56 64,45 54,45 Z"
    private const val LINUX_EYES = "M49,33 C43,33 43,44 49,44 C55,44 55,33 49,33 Z M59,33 C53,33 53,44 59,44 C65,44 65,33 59,33 Z"
    private const val LINUX_PUPILS = "M50,36 C47,36 47,41 50,41 C53,41 53,36 50,36 Z M58,36 C55,36 55,41 58,41 C61,41 61,36 58,36 Z"
    private const val LINUX_BEAK_FEET = "M45,44 Q54,38 63,44 Q54,51 45,44 Z M40,69 L52,76 Q50,82 34,78 Q30,76 40,69 Z M68,69 L56,76 Q58,82 74,78 Q78,76 68,69 Z"
    private const val COMPUTER = "M34,33 H74 Q79,33 79,38 V65 Q79,70 74,70 H57 V75 H66 V79 H42 V75 H51 V70 H34 Q29,70 29,65 V38 Q29,33 34,33 Z M34,38 V65 H74 V38 Z"
}
