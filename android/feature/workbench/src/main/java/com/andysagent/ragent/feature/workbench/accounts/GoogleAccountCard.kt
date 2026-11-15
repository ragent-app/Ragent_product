package com.andysagent.ragent.feature.workbench.accounts

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.CircleShape
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoDialog
import com.andysagent.ragent.core.designsystem.AgentoErrorText
import com.andysagent.ragent.core.designsystem.AgentoProgress
import com.andysagent.ragent.core.designsystem.AgentoSettingRow
import com.andysagent.ragent.core.designsystem.AgentoStatus
import com.andysagent.ragent.core.designsystem.AgentoStatusTone
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.workbench.GoogleBrandIcon
import java.net.HttpURLConnection
import java.net.URL
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun GoogleAccountCard(
    state: GoogleAccountUiState,
    onSignIn: () -> Unit = {},
    onRefresh: () -> Unit = onSignIn,
    onOpenAccountManagement: () -> Unit = {},
    onBind: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val signedIn = state.hasVerifiedAccountSession
    val profile = state.accountProfile
    Column(modifier.fillMaxWidth()) {
        AgentoSettingRow(
            leadingIcon = {
                if (signedIn) GoogleAccountAvatar(profile, 38.dp) else GoogleBrandIcon()
            },
            title = if (signedIn) profile?.displayName?.ifBlank { "Google account" } ?: "Google account" else "Google account",
            subtitle = profile?.email,
            showDivider = signedIn,
            trailing = { StatusIndicator(state) },
            onClick = when {
                signedIn -> onOpenAccountManagement
                state.status == GoogleAccountStatus.SignedOut ||
                    state.status == GoogleAccountStatus.Error ||
                    state.status == GoogleAccountStatus.NotConfigured -> onSignIn
                else -> ({})
            },
        )
        when {
            state.status == GoogleAccountStatus.SignedOut || state.status == GoogleAccountStatus.Error ->
                AccountAction("Sign in with Google", onSignIn, leadingIcon = { GoogleBrandIcon() })
            state.status == GoogleAccountStatus.VerificationUnavailable ->
                AccountAction("Retry account check", onRefresh, secondary = true)
            state.deviceBindingStatus == GoogleDeviceBindingStatus.AccountClaimRequired ->
                AccountAction("Link a computer", onBind)
            state.status == GoogleAccountStatus.Checking || state.status == GoogleAccountStatus.SigningIn ->
                AgentoProgress(modifier = Modifier.padding(RagentSpacing.Standard))
        }
        state.errorMessage?.let {
            AgentoErrorText(it, Modifier.padding(horizontal = RagentSpacing.Standard, vertical = RagentSpacing.Compact))
        }
    }
}

@Composable
fun GoogleAccountAvatar(
    profile: com.andysagent.ragent.core.domain.GoogleAccountProfile?,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val photoUrl = profile?.photoUrl?.takeIf { it.startsWith("https://") }
    val context = LocalContext.current.applicationContext
    val cachedImage = remember(photoUrl) { photoUrl?.let(AvatarImageCache::get) }
    var avatarState by remember(photoUrl) {
        mutableStateOf(AvatarImageState(cachedImage))
    }
    LaunchedEffect(photoUrl) {
        if (photoUrl != null && cachedImage == null) {
            val loaded = AvatarImageCache.load(context, photoUrl)
            avatarState = AvatarImageState(loaded)
        }
    }
    Box(
        // A profile image owns its own identity. For accounts without one,
        // keep the fallback tied to Ragent's deep-blue brand rather than to
        // a potentially unrelated dynamic Material accent.
        modifier = modifier.size(size).clip(CircleShape).background(colors.actionPrimary),
        contentAlignment = Alignment.Center,
    ) {
        if (avatarState.image != null) {
            Image(
                bitmap = avatarState.image!!,
                contentDescription = profile?.displayName ?: "Google account",
                modifier = Modifier.fillMaxWidth(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(
                profileInitials(profile),
                style = MaterialTheme.typography.titleMedium,
                // Initials are artwork within a fixed avatar, not body text.
                fontSize = (size.value * 0.36f / LocalDensity.current.fontScale).sp,
                maxLines = 1,
                fontWeight = FontWeight.SemiBold,
                color = colors.actionPrimaryContent,
            )
        }
    }
}

object AvatarImageCache {
    private val cache = LruCache<String, ImageBitmap>(4)

    fun get(photoUrl: String): ImageBitmap? = cache.get(photoUrl)

    fun put(photoUrl: String, image: ImageBitmap) {
        cache.put(photoUrl, image)
    }

    suspend fun prefetch(context: Context, photoUrl: String) {
        load(context.applicationContext, photoUrl)
    }

    suspend fun load(context: Context, photoUrl: String): ImageBitmap? {
        get(photoUrl)?.let { return it }
        val image = withContext(Dispatchers.IO) {
            runCatching {
                readFromDisk(context, photoUrl) ?: downloadToDisk(context, photoUrl)
            }.getOrNull()
        }
        image?.let { put(photoUrl, it) }
        return image
    }

    private fun readFromDisk(context: Context, photoUrl: String): ImageBitmap? =
        BitmapFactory.decodeFile(cacheFile(context, photoUrl).absolutePath)?.asImageBitmap()

    private fun downloadToDisk(context: Context, photoUrl: String): ImageBitmap? {
        val connection = (URL(photoUrl).openConnection() as? HttpURLConnection) ?: return null
        return try {
            connection.connectTimeout = 4_000
            connection.readTimeout = 4_000
            connection.doInput = true
            connection.connect()
            if (connection.responseCode !in 200..299) return null
            val bytes = connection.inputStream.use { it.readBytes() }
            val file = cacheFile(context, photoUrl)
            file.parentFile?.mkdirs()
            file.writeBytes(bytes)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        } finally {
            connection.disconnect()
        }
    }

    private fun cacheFile(context: Context, photoUrl: String): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(photoUrl.toByteArray())
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        return File(File(context.filesDir, "account-avatars"), "$digest.img")
    }
}

private data class AvatarImageState(
    val image: ImageBitmap?,
)

private fun profileInitials(profile: com.andysagent.ragent.core.domain.GoogleAccountProfile?): String =
    profile?.displayName.orEmpty().trim().split(" ").filter { it.isNotBlank() }.take(2)
        .mapNotNull { it.firstOrNull() }.joinToString("").ifBlank { "G" }.uppercase()

@Composable
private fun AccountAction(
    text: String,
    onClick: () -> Unit,
    secondary: Boolean = false,
    leadingIcon: (@Composable () -> Unit)? = null,
) {
    Spacer(Modifier.size(RagentSpacing.Grid))
    Box(Modifier.fillMaxWidth().padding(RagentSpacing.Standard)) {
        AgentoButton(
            text,
            onClick,
            modifier = Modifier.fillMaxWidth(),
            secondary = secondary,
            leadingIcon = leadingIcon,
        )
    }
}

@Composable
private fun StatusIndicator(state: GoogleAccountUiState) {
    if (state.status == GoogleAccountStatus.SignedIn && !state.hasVerifiedAccountSession) {
        AgentoProgress(modifier = Modifier.size(RagentSizes.Icon))
        return
    }
    when (state.status) {
        GoogleAccountStatus.SignedIn -> AgentoStatus("Signed in", AgentoStatusTone.Success)
        GoogleAccountStatus.SignedOut -> AgentoWebIcon(AgentoWebGlyph.ChevronRight, contentDescription = null)
        GoogleAccountStatus.Checking, GoogleAccountStatus.SigningIn -> AgentoProgress(modifier = Modifier.size(RagentSizes.Icon))
        GoogleAccountStatus.VerificationUnavailable -> AgentoStatus("Check unavailable", AgentoStatusTone.Neutral)
        GoogleAccountStatus.NotConfigured -> AgentoStatus("Not configured", AgentoStatusTone.Neutral)
        GoogleAccountStatus.Error -> AgentoStatus("Sign-in failed", AgentoStatusTone.Error)
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun GoogleAccountCardPreview() {
    RagentTheme { GoogleAccountCard(GoogleAccountUiState(status = GoogleAccountStatus.SignedOut)) }
}

@Preview(name = "Google account bound", showBackground = true, widthDp = 390)
@Composable
private fun GoogleAccountCardBoundPreview() {
    RagentTheme {
        GoogleAccountCard(
            GoogleAccountUiState(
                status = GoogleAccountStatus.SignedIn,
                accountProfile = com.andysagent.ragent.core.domain.GoogleAccountProfile("Alex Chen", "alex@example.com"),
            )
        )
    }
}

@Preview(name = "Temporary connection dark", showBackground = true, widthDp = 390)
@Composable
private fun GoogleAccountCardTemporaryDarkPreview() {
    RagentTheme(darkTheme = true) {
        GoogleAccountCard(GoogleAccountUiState(status = GoogleAccountStatus.SigningIn))
    }
}
