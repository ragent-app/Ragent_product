package com.andysagent.agentoc.core.designsystem

import androidx.annotation.DrawableRes
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource

/**
 * Native copies of the canonical paths in static/chat/icons.js.
 * Keep the Android chrome on the same icon language as the Web UI.
 */
enum class AgentoWebGlyph(@DrawableRes val resource: Int) {
    Menu(R.drawable.agento_menu),
    Home(R.drawable.agento_home),
    Agent(R.drawable.agento_sparkle_solid),
    Settings(R.drawable.agento_gear_solid),
    Palette(R.drawable.agento_palette_solid),
    Language(R.drawable.agento_language_solid),
    Folder(R.drawable.agento_folder_solid),
    FolderPlus(R.drawable.agento_folder_plus),
    Search(R.drawable.agento_search),
    Plus(R.drawable.agento_plus),
    Back(R.drawable.agento_arrow_left),
    ChevronRight(R.drawable.agento_chevron_right),
    ChevronDown(R.drawable.agento_chevron_down),
    More(R.drawable.agento_more_horizontal),
    Edit(R.drawable.agento_edit),
    Refresh(R.drawable.agento_refresh),
    Monitor(R.drawable.agento_monitor),
    MonitorPlus(R.drawable.agento_monitor_plus),
    Terminal(R.drawable.agento_terminal),
    File(R.drawable.agento_file),
    Send(R.drawable.agento_send),
    Maximize(R.drawable.agento_maximize),
    Shield(R.drawable.agento_shield),
    ShieldSolid(R.drawable.agento_shield_solid),
    Share(R.drawable.agento_share),
    Device(R.drawable.agento_device),
    Check(R.drawable.agento_check),
    Info(R.drawable.agento_info),
    Bell(R.drawable.agento_bell),
    Clock(R.drawable.agento_clock),
    Stop(R.drawable.agento_stop),
    Chat(R.drawable.agento_new_chat),
    Qr(R.drawable.agento_qr),
    ChatBubble(R.drawable.agento_chat_bubble_solid),
    TriangleSend(R.drawable.agento_triangle_send),
    TargetArrow(R.drawable.agento_target_arrow),
    Copy(R.drawable.agento_copy),
    Fork(R.drawable.agento_fork),
    Report(R.drawable.agento_report),
    Pin(R.drawable.agento_pin),
    Play(R.drawable.agento_play),
    Pause(R.drawable.agento_pause),
    Close(R.drawable.agento_close),
    Bolt(R.drawable.agento_bolt),
    Image(R.drawable.agento_image),
    Microphone(R.drawable.agento_microphone),
    Trash(R.drawable.agento_trash),
}

@Composable
fun AgentoWebIcon(
    glyph: AgentoWebGlyph,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current,
) {
    Icon(
        painter = painterResource(glyph.resource),
        contentDescription = contentDescription,
        modifier = modifier,
        tint = tint,
    )
}
