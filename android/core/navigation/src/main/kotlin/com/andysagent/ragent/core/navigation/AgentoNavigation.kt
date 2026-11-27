package com.andysagent.ragent.core.navigation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.border
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.andysagent.ragent.core.designsystem.RagentMotion
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.recordToLayer
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.LocalAgentoPageBackdropOrigin
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.agentoAmbientShadow
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens

enum class ProjectNavLevel {
    L1_Projects,
    L2_Sessions,
}

enum class AgentoDestination(val labelRes: Int, val icon: AgentoWebGlyph) {
    // Routes remain stable for existing navigation and deep links. Home is the
    // notification-driven starting surface; device management belongs in
    // Settings and must not displace it.
    Sessions(R.string.navigation_chat, AgentoWebGlyph.ChatBubble),
    Home(R.string.navigation_home, AgentoWebGlyph.Home),
    Settings(R.string.navigation_settings, AgentoWebGlyph.Settings),

    ;

    val route: String get() = name.lowercase()

    companion object {
        fun fromRoute(route: String?): AgentoDestination = entries.firstOrNull { it.route == route } ?: Sessions
    }
}

enum class AgentoWindowSizeClass { Compact, Medium, Expanded }

private val PrimaryDestinations = listOf(
    AgentoDestination.Sessions,
    AgentoDestination.Home,
    AgentoDestination.Settings,
)

/**
 * Chat, Home and Settings are peer destinations. The dock lens communicates
 * location. Pages exchange side by side on one horizontal axis, not through
 * detail parallax or independently timed crossfades. Equal opposite offsets
 * keep the viewport covered without stacking two sets of readable text.
 */
internal fun primaryNavigationUsesPeerTransition(
    initial: AgentoDestination,
    target: AgentoDestination,
): Boolean = initial != target

private fun primaryPeerRank(destination: AgentoDestination): Int =
    PrimaryDestinations.indexOf(destination).coerceAtLeast(0)

internal fun primaryPeerIsForward(
    initial: AgentoDestination,
    target: AgentoDestination,
): Boolean = primaryPeerRank(target) >= primaryPeerRank(initial)

internal fun primaryPeerEnterTransition(preference: MotionPreference): EnterTransition = when (preference) {
    MotionPreference.None -> EnterTransition.None
    MotionPreference.Reduced -> fadeIn(tween(120))
    MotionPreference.Full -> EnterTransition.None
}

internal fun primaryPeerExitTransition(preference: MotionPreference): ExitTransition = when (preference) {
    MotionPreference.None -> ExitTransition.None
    MotionPreference.Reduced -> fadeOut(tween(120))
    MotionPreference.Full -> ExitTransition.None
}

private class PrimaryPeerDirection { var forward by mutableStateOf(true) }

/**
 * The NavHost has no current route during its first composition. Use the UDF
 * selection for that frame instead of [AgentoDestination.fromRoute]'s legacy
 * Sessions fallback, otherwise the dock briefly renders Chat before Home is
 * installed as the start destination.
 */
internal fun visibleNavigationDestination(
    currentRoute: String?,
    selected: AgentoDestination,
): AgentoDestination = currentRoute?.let(AgentoDestination::fromRoute) ?: selected

@Composable
fun AgentoAdaptiveScaffold(
    selected: AgentoDestination,
    onDestinationSelected: (AgentoDestination) -> Unit,
    onCreateProject: (() -> Unit)? = null,
    onCreateSession: (() -> Unit)? = null,
    windowSizeClass: AgentoWindowSizeClass = AgentoWindowSizeClass.Compact,
    dockVisible: Boolean = true,
    modifier: Modifier = Modifier,
    projectActionProgress: State<Float>? = null,
    content: @Composable (Modifier, AgentoDestination, String, Boolean) -> Unit,
) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val backStackDestination = visibleNavigationDestination(currentRoute, selected)
    val initialRoute = remember { selected.route }
    val motionPolicy = LocalMotionPolicy.current
    val spatialSign = if (LocalLayoutDirection.current == LayoutDirection.Ltr) 1f else -1f
    val colors = LocalRagentColors.current
    // The navigation bar is the only control that samples the page beneath it.
    // Keeping the capture inside the NavHost layer prevents it from recording
    // transient overlays during route transitions.
    val navigationBackdrop = rememberGraphicsLayer()
    val dockGeometry = remember { PrimaryDockGeometry() }
    val peerClockStore = remember { NavigationPeerClockStore() }
    val peerDirection = remember { PrimaryPeerDirection() }
    var acknowledgedSelection by remember { mutableStateOf(selected) }
    val pendingSelection = selected.takeIf { it != acknowledgedSelection }
    if (selected == backStackDestination) {
        SideEffect { acknowledgedSelection = selected }
    }

    fun syncNavController(destination: AgentoDestination) {
        val currentVisit = navController.currentBackStackEntry
        if (currentVisit?.destination?.route == destination.route) return
        val enteringVisit = peerClockStore.clock
        val outgoingVisitVisible = navController.visibleEntries.value.any {
            it.id != currentVisit?.id && it.destination.route == destination.route
        }
        if (enteringVisit != null && outgoingVisitVisible &&
            enteringVisit?.visitId == currentVisit?.id && !enteringVisit.settled()
        ) {
            // Returning to the still-visible outgoing tab cancels this unfinished
            // visit. Reuse its actual NavHost object/position instead of pushing a
            // second copy from the edge, which also gives the dock a wrong clock.
            navController.popBackStack(destination.route, inclusive = false)
            return
        }
        // A tab tap is a new visit, not Back. Popping to an older copy of
        // Home discards the page that opened it (Home -> Settings -> Home).
        // Preserve completed visit history; only the unfinished reversal above
        // or the system Back action consumes it.
        navController.navigate(destination.route) {
            launchSingleTop = true
            restoreState = true
        }
    }

    fun navigateTo(destination: AgentoDestination) {
        // Keep the state machine and the visual navigation stack in sync for
        // nav-item taps.
        onDestinationSelected(destination)
        syncNavController(destination)
    }

    // A surface can request a destination directly (for example Home ->
    // Projects or Home -> Usage). Reconcile state changes into the navigation
    // stack without re-emitting onDestinationSelected, which would clear
    // destination subpage state (e.g. SettingsPage.Usage -> Overview). Keep
    // this effect keyed only by the requested destination so a system-back pop
    // is not immediately pushed forward again by stale selected state.
    LaunchedEffect(selected) {
        if (currentRoute != null && currentRoute != selected.route) {
            syncNavController(selected)
        }
    }

    // NavHost owns the actual back-stack pop. Reflect that pop back into the
    // UDF state instead of letting the next selected-state reconciliation
    // reopen the destination the user just left.
    LaunchedEffect(currentRoute) {
        if (currentRoute != null && currentRoute != selected.route) {
            onDestinationSelected(backStackDestination)
        }
    }

    val isDark = colors.canvas.red < 0.5f
    // Keep the root edge-to-edge. The navigation is an overlay, so destination
    // surfaces can paint and scroll all the way to the bottom behind the dock
    // instead of receiving Scaffold's reserved bottom-bar inset.
    Layout(
        modifier = modifier
            .fillMaxSize()
            .background(
                brush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight,
            ),
        content = {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .testTag("primary-reading-plane")
                .primaryReadingPlane(navigationBackdrop, dockGeometry),
        ) {
            NavHost(
                navController = navController,
                startDestination = initialRoute,
                modifier = Modifier.fillMaxSize(),
                // The destination pages are peers, not successive detail levels.
                // The persistent dock lens handles spatial orientation; content
                // exchanges as adjacent planes. No parallax, edge shadow or
                // dimming: those depth cues belong to a detail push, not tabs.
                enterTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        EnterTransition.None
                    } else {
                        primaryPeerEnterTransition(motionPolicy.preference)
                    }
                },
                exitTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        ExitTransition.None
                    } else {
                        primaryPeerExitTransition(motionPolicy.preference)
                    }
                },
                popEnterTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        EnterTransition.None
                    } else {
                        primaryPeerEnterTransition(motionPolicy.preference)
                    }
                },
                popExitTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        ExitTransition.None
                    } else {
                        primaryPeerExitTransition(motionPolicy.preference)
                    }
                },
            ) {
                AgentoDestination.entries.forEach { destination ->
                    composable(destination.route) { visit ->
                        // This child belongs to NavHost's actual transition.
                        // Its phase and the slide have the same curve and clock;
                        // the dock reads this State directly in measure/draw.
                        val pageTransition = transition
                        val fadePhase = pageTransition.animateFloat(
                            transitionSpec = { when (motionPolicy.preference) {
                                MotionPreference.None -> snap()
                                MotionPreference.Reduced -> tween(120)
                                MotionPreference.Full -> tween(380, easing = FastOutSlowInEasing)
                            } }, label = "primary_peer_phase",
                        ) { if (it == EnterExitState.Visible) 1f else 0f }
                        // Translation belongs to the page layer. A layout slide
                        // schedules measure/placement throughout the exchange;
                        // the destination's endpoint layout stays fixed here.
                        // Animate the actual offset so a third tab can retarget
                        // from the current position without changing its sign.
                        val offset = pageTransition.animateFloat(
                            transitionSpec = { when (motionPolicy.preference) {
                                MotionPreference.Full -> tween(380, easing = FastOutSlowInEasing)
                                else -> snap()
                            } }, label = "primary_peer_layer_offset",
                        ) { stage ->
                            if (motionPolicy.preference != MotionPreference.Full) 0f else when (stage) {
                                EnterExitState.PreEnter -> if (peerDirection.forward) 1f else -1f
                                EnterExitState.Visible -> 0f
                                EnterExitState.PostExit -> if (peerDirection.forward) -1f else 1f
                            }
                        }
                        val phase = remember(offset, fadePhase, motionPolicy.preference) {
                            derivedStateOf {
                                if (motionPolicy.preference == MotionPreference.Full)
                                    (1f - kotlin.math.abs(offset.value)).coerceIn(0f, 1f)
                                else fadePhase.value
                            }
                        }
                        val peerClock = remember(visit.id, pageTransition, phase) {
                            NavigationPeerClock(visit.id, destination, phase,
                                entering = { pageTransition.targetState == EnterExitState.Visible },
                                settled = { pageTransition.currentState == EnterExitState.Visible &&
                                    pageTransition.targetState == EnterExitState.Visible && !pageTransition.isRunning })
                        }
                        DisposableEffect(peerClock) { onDispose { peerClock.disposed = true } }
                        // Interrupted child transitions can temporarily both
                        // report Visible. Only the actual back-stack target may
                        // publish the dock clock; composition order is not ownership.
                        if (visit.id == backStackEntry?.id) {
                            SideEffect { peerClockStore.clock = peerClock }
                        }
                        // The dock's slots use logical placement. Mirror only
                        // the physical translation, keeping its shared phase.
                        Box(Modifier.fillMaxSize().graphicsLayer { translationX = spatialSign * size.width * offset.value }
                            .clipToBounds().testTag("primary-page-${destination.route}")) {
                            content(Modifier.fillMaxSize(), destination, visit.id, backStackEntry?.id == visit.id)
                        }
                    }
                }
            }
        }

        // Navigation is a single floating control layer. Creation belongs to
        // its relevant page, so the dock never competes with an empty state
        // or appears as an unexplained fourth primary action.
        AnimatedVisibility(
            visible = dockVisible,
            enter = fadeIn(RagentMotion.Spatial) + slideInVertically(
                initialOffsetY = { it / 3 },
                animationSpec = RagentMotion.SpatialOffset,
            ),
            exit = fadeOut(RagentMotion.Spatial) + slideOutVertically(
                targetOffsetY = { it / 3 },
                animationSpec = RagentMotion.SpatialOffset,
            ),
        ) {
            CompositionLocalProvider(LocalNavigationPeerClockStore provides peerClockStore) {
                AgentoBottomNavigation(
                    modifier = Modifier
                        .widthIn(max = 520.dp)
                        .padding(horizontal = RagentSpacing.Gutter)
                        .navigationBarsPadding()
                        .padding(bottom = 10.dp),
                    selected = backStackDestination,
                    pendingSelection = pendingSelection,
                    onDestinationSelected = ::navigateTo,
                    onCreateProject = onCreateProject,
                    onCreateSession = onCreateSession,
                    projectActionProgress = projectActionProgress,
                    backdropLayer = navigationBackdrop,
                )
            }
        }
        },
    ) { measurables, constraints ->
        // Measure the retained dock first. Content uses full page geometry and
        // keeps its list identity/padding; only its reader-facing pixels exit.
        val dock = measurables.getOrNull(1)?.measure(constraints.copy(minWidth = 0, minHeight = 0))
        dockGeometry.measure(dock?.height ?: 0)
        val page = measurables[0].measure(constraints)
        layout(constraints.maxWidth, constraints.maxHeight) {
            page.place(0, 0)
            dock?.place((constraints.maxWidth - dock.width) / 2, constraints.maxHeight - dock.height)
        }
    }
}

/**
 * A quiet foreground dock. Labels are retained only when every destination
 * fits comfortably; larger type or constrained space uses icons with full
 * accessibility names instead of truncated labels. The selection is a clear glass
 * lens, not a filled navigation chip: active color belongs to the glyph and
 * label, while the material simply separates controls from page content.
 */
@Composable
fun AgentoBottomNavigation(
    selected: AgentoDestination,
    onDestinationSelected: (AgentoDestination) -> Unit,
    onCreateProject: (() -> Unit)? = null,
    onCreateSession: (() -> Unit)? = null,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
    projectActionProgress: State<Float>? = null,
    pendingSelection: AgentoDestination? = null,
) {
    val policy = LocalMotionPolicy.current
    val density = LocalDensity.current
    val largeType = density.fontScale >= 1.6f
    val dockHeight = if (largeType) RagentSizes.BottomNavigation
        else maxOf(RagentSizes.BottomNavigation, (30f + 16f * density.fontScale).dp)
    val selectionHeight = dockHeight - 8.dp
    val labels = PrimaryDestinations.map { stringResource(it.labelRes) }
    val labelStyle = androidx.compose.material3.MaterialTheme.typography.labelSmall
        .copy(fontWeight = FontWeight.SemiBold)
    val textMeasurer = rememberTextMeasurer()
    // Measure the widest selected-state label, not only the current selection.
    // Changing tabs must not unexpectedly bring clipped text back into the dock.
    val labelSizes = remember(labels, labelStyle, textMeasurer, density) {
        labels.map { textMeasurer.measure(it, labelStyle, softWrap = false, maxLines = 1).size }
    }
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val navigationOffset = remember { mutableStateOf(IntOffset.Zero) }
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current
    // Chat keeps the wide dock because it can carry its contextual creation
    // action. On the other primary pages the dock contracts to the exact
    // resting composer silhouette, rather than reading as a full-width bar.
    val peerStore = LocalNavigationPeerClockStore.current
    val peerClock = peerStore?.clock?.takeIf { it.entering() }
    // A direct UDF request can precede NavHost's new child by a frame. Keep
    // following the visible entering page until the actual child handoff.
    // A native/predictive Back with no UDF request still follows its actual child.
    val visualDestination = pendingSelection ?: peerClock?.destination ?: selected
    val contextualAction = when {
        visualDestination != AgentoDestination.Sessions -> null
        onCreateSession != null -> NavigationDockAction(
            label = stringResource(R.string.navigation_new_session),
            glyph = AgentoWebGlyph.Chat,
            onClick = onCreateSession,
        )
        onCreateProject != null -> NavigationDockAction(
            label = stringResource(R.string.navigation_new_project),
            glyph = AgentoWebGlyph.FolderPlus,
            onClick = onCreateProject,
        )
        else -> null
    }
    val dockTarget = NavigationDockTarget(visualDestination, contextualAction != null)
    val dockMotion = remember { NavigationDockMotion(dockTarget) }
    var dragFrame by remember { mutableStateOf<NavigationDockFrame?>(null) }
    var dragSlot by remember { mutableStateOf(0f) }
    var dragInside by remember { mutableStateOf(true) }
    var gestureRevision by remember { mutableStateOf(0) }
    var releasedTarget by remember { mutableStateOf(dockTarget) }
    var contact by remember { mutableStateOf(Offset(.5f, .5f)) }
    var contactOrigin by remember { mutableStateOf(Offset(.5f, .5f)) }
    var dragGrip by remember { mutableStateOf(0f) }
    var contactDown by remember { mutableStateOf(false) }
    val contactPressure = rememberNavigationContactLoad()
    var contactLoad by contactPressure
    val physicalContactSlot = (contact.x * 3f).toInt().coerceIn(0, 2)
    val contactSlot = if (LocalLayoutDirection.current == LayoutDirection.Rtl) 2 - physicalContactSlot else physicalContactSlot
    val touchingSelection = contactDown && (dragFrame != null || contactSlot == visualDestination.ordinal)
    val contactStrength by animateFloatAsState(if (touchingSelection) contactLoad else 0f,
        animationSpec = when (policy.preference) {
            MotionPreference.None -> snap()
            MotionPreference.Reduced -> tween(100)
            MotionPreference.Full -> spring(dampingRatio = .85f, stiffness = 700f)
        }, label = "dock-contact")
    val selectionTone by animateFloatAsState(
        if (touchingSelection) .10f + .05f * contactLoad else .10f,
        animationSpec = if (policy.preference == MotionPreference.None) snap() else tween(100), label = "dock-contact-tone")
    if (peerStore == null) {
        LaunchedEffect(dockTarget, policy.preference, gestureRevision) { dockMotion.retarget(dockTarget, policy.preference) }
    } else {
        LaunchedEffect(gestureRevision) {
            if (gestureRevision > 0) dockMotion.retarget(releasedTarget, policy.preference)
        }
    }
    val dockFrame = {
        // The child registers its real clock after composition. Consume it in
        // this frame's layout/draw rather than waiting for another composition
        // and SideEffect. A later requested tab must not suppress the currently
        // visible page's clock while NavHost is still handing the visit over.
        peerStore?.clock?.let { actualClock ->
            dockMotion.follow(NavigationDockTarget(actualClock.destination,
                actualClock.destination == AgentoDestination.Sessions &&
                    (onCreateSession != null || onCreateProject != null)), actualClock)
        }
        dragFrame?.copy(lensSlot = dragSlot, emphasis = PrimaryDestinations.indices.map {
            (1f - kotlin.math.abs(it - dragSlot)).coerceIn(0f, 1f)
        }) ?: dockMotion.frame(dockTarget)
    }
    val currentFrame by rememberUpdatedState(dockFrame)
    val currentDestination by rememberUpdatedState(visualDestination)
    val currentSelect by rememberUpdatedState(onDestinationSelected)
    val hasCreation = onCreateProject != null || onCreateSession != null
    val layoutDirection = LocalLayoutDirection.current
    fun finishDrag(cancelled: Boolean) {
        if (dragFrame == null) return
        val destination = if (cancelled || !dragInside) currentDestination
            else PrimaryDestinations[dragSlot.roundToInt().coerceIn(0, PrimaryDestinations.lastIndex)]
        // The last pointer frame may precede another measure pass.
        dockMotion.presented(currentFrame())
        releasedTarget = NavigationDockTarget(destination, destination == AgentoDestination.Sessions && hasCreation)
        dockMotion.releaseGesture(releasedTarget)
        dragFrame = null
        contactDown = false
        gestureRevision++
        if (destination != currentDestination) currentSelect(destination)
    }
    val currentFinish by rememberUpdatedState(::finishDrag)
    // Keep the outgoing pixels until the exit completes, but remove its touch
    // and accessibility action immediately when leaving Chat.
    var retainedAction by remember { mutableStateOf(contextualAction) }
    SideEffect { if (contextualAction != null) retainedAction = contextualAction }
    val actionStillVisible by remember(dockTarget) { derivedStateOf { dockFrame().actionPresence > 0f } }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(dockHeight),
        contentAlignment = Alignment.Center,
    ) {
        // Decide label visibility from the narrowest resting geometry, so
        // icon/label layout doesn't switch halfway through the morph.
        val minimumSlotWidth = minOf(
            maxWidth * RagentSizes.CollapsedComposerWidthFraction,
            maxWidth -
                if (onCreateSession != null || onCreateProject != null) RagentSizes.BottomNavigation + 10.dp else 0.dp,
        ) / PrimaryDestinations.size
        val showLabels = !largeType && with(density) {
            labelSizes.all { size ->
                size.width.toDp() <= minimumSlotWidth - 16.dp &&
                    size.height.toDp() + 22.dp <= selectionHeight - 8.dp
            }
        }
        // The shell and action share continuously allocated space; no fixed
        // AnimatedVisibility slot suddenly appears or disappears.
        // Read the continuous state only during measure/placement. The outer
        // constraint scope and label decisions remain stable throughout a morph.
        Layout(content = {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(dockHeight)
                .testTag("bottom-navigation-shell")
                .agentoAmbientShadow(elevation = 8.dp, shape = AgentoShapes.PillShape, alpha = .035f, spotAlpha = .015f)
                .pointerInput(Unit) {
                    // Horizontal drag callbacks omit purely vertical moves. Observe
                    // all positions before release without consuming child taps.
                    try { awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val pointer = event.changes.firstOrNull()
                            contactDown = pointer?.pressed == true && (dragFrame != null ||
                                (pointer.position.x in 0f..size.width.toFloat() && pointer.position.y in 0f..size.height.toFloat()))
                            if (contactDown && pointer != null) {
                                contact = Offset(pointer.position.x / size.width, pointer.position.y / size.height)
                                if (!pointer.previousPressed) contactOrigin = contact
                                contactLoad = navigationContactLoad(pointer.pressure)
                            }
                            if (dragFrame != null) event.changes.firstOrNull()?.position?.let { position ->
                                dragInside = position.y in -24.dp.toPx()..(size.height + 24.dp.toPx()) &&
                                    position.x in -24.dp.toPx()..(size.width + 24.dp.toPx())
                            }
                        }
                    } } finally { contactDown = false }
                }
                .pointerInput(layoutDirection) {
                    var dragOriginX = 0f
                    var smoothDragStart = false
                    fun updatePointer(position: Offset) {
                        val x = if (layoutDirection == LayoutDirection.Rtl) size.width - position.x else position.x
                        // The recognizer withholds the first touch-slop distance.
                        // Ease that distance back in after recognition, so a slow
                        // press-to-drag transition does not jump by the full slop.
                        val movement = x - dragOriginX
                        val slop = viewConfiguration.touchSlop
                        val catchUp = ((kotlin.math.abs(movement) - slop) / 12.dp.toPx()).coerceIn(0f, 1f)
                        val correction = if (smoothDragStart) {
                            (if (movement >= 0f) 1f else -1f) * minOf(slop, kotlin.math.abs(movement)) * (1f - catchUp)
                        } else 0f
                        dragSlot = ((x - correction) / (size.width / 3f) - .5f - dragGrip).coerceIn(0f, 2f)
                        dragInside = position.y in -24.dp.toPx()..(size.height + 24.dp.toPx()) &&
                            position.x in -24.dp.toPx()..(size.width + 24.dp.toPx())
                    }
                    detectHorizontalDragGestures(
                        onDragStart = { position ->
                            val frame = currentFrame()
                            val originX = if (layoutDirection == LayoutDirection.Rtl) 1f - contactOrigin.x else contactOrigin.x
                            val originSlot = originX * 3f - .5f
                            dragOriginX = originX * size.width
                            // A drag must start inside the actual capsule, not
                            // merely somewhere in its tab or on another tab.
                            val inset = (dockHeight - selectionHeight).toPx() / 2f
                            val slotWidth = size.width / 3f
                            val originY = contactOrigin.y * size.height
                            smoothDragStart = dragOriginX in
                                (frame.lensSlot * slotWidth + inset)..((frame.lensSlot + 1f) * slotWidth - inset) &&
                                originY in inset..(size.height - inset)
                            if (smoothDragStart) {
                                dragGrip = originSlot - frame.lensSlot
                                dragFrame = frame
                                updatePointer(position)
                            }
                        },
                        onHorizontalDrag = { change, _ -> if (dragFrame != null) { change.consume(); updatePointer(change.position) } },
                        onDragEnd = { currentFinish(false) },
                        onDragCancel = { currentFinish(true) },
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .fillMaxSize()
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        navigationOffset.value = IntOffset(
                            pageBackdropOrigin.x - position.x.roundToInt(),
                            pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                },
                shape = AgentoShapes.PillShape,
                surface = AgentoGlassSurface.Neutral,
                // Match the chat composer and notification substrate. Passing
                // the Dock brush would paint an extra 35% white layer over the
                // sampled blur and turn this into a milky opaque bar.
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                specularBrush = if (isDark) {
                    AgentoFrostedTokens.SpecularBorderDark
                } else {
                    AgentoFrostedTokens.SpecularBorderLight
                },
                backdropLayer = backdropLayer,
                backdropOffsetProvider = { navigationOffset.value },
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = false,
                textureAlpha = 0f,
            ) {
                // Equal-width thirds keep every tab an identical touch
                // target on the full-width dock. One refractive lens stays
                // mounted and slides between the slots.
                // The lens has a 4dp vertical clearance inside the 56dp
                // dock. Mirror that clearance horizontally so the first and
                // last selected states never visually touch the pill edge.
                val lensEdgeInset =
                    (dockHeight - selectionHeight) / 2
                Layout(modifier = Modifier.fillMaxSize(), content = {
                Box(
                    modifier = Modifier
                        .height(selectionHeight)
                        .testTag("bottom-navigation-selection")
                        .graphicsLayer {
                            val slot = dockFrame().lensSlot.let { if (layoutDirection == LayoutDirection.Rtl) 2f - it else it }
                            val pose = navigationContactPose(Offset(contact.x * 3f - slot, contact.y), contactStrength)
                            rotationX = pose.rotationX; rotationY = pose.rotationY
                            scaleX = pose.scale; scaleY = pose.scale
                            cameraDistance = 6f
                        }
                        .background(colors.primaryContent.copy(alpha = selectionTone), AgentoShapes.PillShape)
                        .border(.5.dp, colors.primaryContent.copy(alpha = .04f), AgentoShapes.PillShape),
                ) {}

                Row(
                    modifier = Modifier.fillMaxSize(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PrimaryDestinations.forEach { destination ->
                        NavigationDockTab(
                            destination = destination,
                            isSelected = visualDestination == destination,
                            showLabels = showLabels,
                            height = selectionHeight,
                            emphasis = { dockFrame().emphasis[destination.ordinal] },
                            onClick = { onDestinationSelected(destination) },
                        )
                    }
                }
                }) { measurables, constraints ->
                    val slotWidth = constraints.maxWidth.toFloat() / PrimaryDestinations.size
                    val inset = lensEdgeInset.roundToPx()
                    val lens = measurables[0].measure(Constraints.fixed(
                        (slotWidth - inset * 2).roundToInt().coerceAtLeast(0),
                        selectionHeight.roundToPx(),
                    ))
                    val tabs = measurables[1].measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight))
                    layout(constraints.maxWidth, constraints.maxHeight) {
                        lens.placeRelative((slotWidth * dockFrame().lensSlot.coerceIn(0f, 2f)).roundToInt() + inset, inset)
                        tabs.placeRelative(0, 0)
                    }
                }
            }
        }
        (contextualAction ?: retainedAction?.takeIf { actionStillVisible })?.let { action ->
            ContextualDockAction(
                label = action.label,
                glyph = action.glyph,
                onClick = action.onClick,
                enabled = dragFrame == null && contextualAction != null && dockMotion.settled(dockTarget),
                projectProgress = projectActionProgress,
                sessionRole = onCreateSession != null,
                backdropLayer = backdropLayer,
                presence = { dockFrame().actionPresence },
                contactPressure = contactPressure,
            )
        }
        }) { measurables, constraints ->
            val frame = dockFrame()
            dockMotion.presented(frame)
            val width = (constraints.maxWidth * frame.widthFraction.coerceIn(
                RagentSizes.CollapsedComposerWidthFraction, 1f,
            )).roundToInt()
            val actionExtent = ((RagentSizes.BottomNavigation + 10.dp).toPx() *
                frame.actionPresence).roundToInt()
            val shell = measurables[0].measure(Constraints.fixed((width - actionExtent).coerceAtLeast(0), constraints.maxHeight))
            val action = measurables.getOrNull(1)?.measure(Constraints.fixed(
                RagentSizes.BottomNavigation.roundToPx(), RagentSizes.BottomNavigation.roundToPx(),
            ))
            layout(width, constraints.maxHeight) {
                shell.placeRelative(actionExtent, 0)
                action?.placeRelative(0, (constraints.maxHeight - action.height) / 2)
            }
        }
    }
}

/** Foreground tint reads the same displayed phase in draw, not a later recomposition. */
@Composable
private fun RowScope.NavigationDockTab(
    destination: AgentoDestination,
    isSelected: Boolean,
    showLabels: Boolean,
    height: androidx.compose.ui.unit.Dp,
    emphasis: () -> Float,
    onClick: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val inactiveColor = if (colors.canvas.red < .5f) Color(0x99EBEBF5) else Color(0x993C3C43)
    val label = stringResource(destination.labelRes)
    val interactionSource = remember { MutableInteractionSource() }
    val foregroundPaint = remember { Paint() }
    Box(
        modifier = Modifier.weight(1f).height(height)
            .clickable(interactionSource = interactionSource, indication = null, role = Role.Tab, onClick = onClick)
            .testTag("bottom-navigation-tab-${destination.route}")
            .semantics { selected = isSelected; contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 4.dp)
                .testTag("bottom-navigation-foreground-${destination.route}")
                .drawWithContent {
                    // Only the glyph/text alpha mask enters this small layer;
                    // the glass substrate and selection lens are never tinted.
                    foregroundPaint.colorFilter = ColorFilter.tint(
                        lerp(inactiveColor, colors.accentPrimary, emphasis()))
                    val canvas = drawContext.canvas
                    canvas.saveLayer(Rect(Offset.Zero, size), foregroundPaint)
                    drawContent()
                    canvas.restore()
                },
            verticalArrangement = Arrangement.spacedBy(2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AgentoWebIcon(destination.icon, contentDescription = null,
                modifier = Modifier.size(if (showLabels) 20.dp else 24.dp), tint = Color.Black)
            if (showLabels) Text(
                text = label,
                style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, color = Color.Black,
            )
        }
    }
}

private data class NavigationDockAction(
    val label: String,
    val glyph: AgentoWebGlyph,
    val onClick: () -> Unit,
)

/** A sequential glyph dissolve, not two opaque symbols over one another. */
internal fun projectDockGlyphAlpha(progress: Float, session: Boolean): Float {
    val p = progress.coerceIn(0f, 1f)
    return if (session) ((p - 0.45f) / 0.55f).coerceIn(0f, 1f)
        else ((0.55f - p) / 0.55f).coerceIn(0f, 1f)
}

@Composable
private fun ContextualDockAction(
    label: String,
    glyph: AgentoWebGlyph,
    onClick: () -> Unit,
    backdropLayer: GraphicsLayer?,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    projectProgress: State<Float>? = null,
    sessionRole: Boolean = false,
    presence: () -> Float = { 1f },
    contactPressure: androidx.compose.runtime.MutableState<Float>,
) {
    val colors = LocalRagentColors.current
    val actionOffset = remember { mutableStateOf(IntOffset.Zero) }
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current
    val roleReady = projectProgress == null ||
        if (sessionRole) projectProgress.value >= 0.999f else projectProgress.value <= 0.001f
    val interactive = enabled && roleReady
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val policy = LocalMotionPolicy.current
    var contact by remember { mutableStateOf(Offset(.5f, .5f)) }
    var contactLoad by contactPressure
    val contactStrength by animateFloatAsState(if (pressed && interactive) contactLoad else 0f,
        animationSpec = when (policy.preference) {
            MotionPreference.None -> snap()
            MotionPreference.Reduced -> tween(100)
            MotionPreference.Full -> spring(dampingRatio = .85f, stiffness = 700f)
        }, label = "creation-contact")
    // The full touch slot stays put. Only the visible disc grows with the dock;
    // its glyph and diffuse shadow are not raster-scaled into a tiny dot.
    Layout(
        modifier = modifier
            .size(RagentSizes.BottomNavigation)
            .testTag("bottom-navigation-contextual-action")
            .then(if (interactive) Modifier.clickable(interactionSource, indication = null, role = Role.Button, onClick = onClick) else Modifier)
            .then(if (interactive) Modifier.semantics { contentDescription = label }
                else Modifier.clearAndSetSemantics {}),
        content = {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .testTag("bottom-navigation-action-surface")
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) {
                                awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull()?.let {
                                    if (it.pressed) {
                                        contact = Offset(it.position.x / size.width, it.position.y / size.height)
                                        contactLoad = navigationContactLoad(it.pressure)
                                    }
                                }
                            }
                        }
                    }
                    .graphicsLayer {
                        val pose = navigationContactPose(contact, contactStrength)
                        rotationX = pose.rotationX; rotationY = pose.rotationY
                        scaleX = pose.scale; scaleY = pose.scale
                        cameraDistance = 6f
                    }
                    .agentoAmbientShadow(elevation = 8.dp, shape = CircleShape, alpha = .035f, spotAlpha = .015f)
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        actionOffset.value = IntOffset(
                            pageBackdropOrigin.x - position.x.roundToInt(),
                            pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                    },
                shape = CircleShape,
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                backdropLayer = backdropLayer,
                backdropOffsetProvider = { actionOffset.value },
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = false,
                textureAlpha = 0f,
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier.graphicsLayer { alpha = navigationActionFrame(presence()).glyphAlpha }
                        .testTag("bottom-navigation-action-glyph"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (projectProgress != null) {
                        listOf(false, true).forEach { session ->
                            AgentoWebIcon(
                                glyph = if (session) AgentoWebGlyph.Chat else AgentoWebGlyph.FolderPlus,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp).graphicsLayer {
                                    val alphaProgress = projectDockGlyphAlpha(projectProgress.value, session)
                                    alpha = alphaProgress
                                    scaleX = 0.88f + 0.12f * alphaProgress
                                    scaleY = scaleX
                                },
                                tint = colors.textPrimary,
                            )
                        }
                    } else AgentoWebIcon(
                        glyph = glyph,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = colors.textPrimary,
                    )
                }
            }
        },
    ) { measurables, constraints ->
        val frame = navigationActionFrame(presence())
        val diameter = frame.diameter.dp.roundToPx().coerceIn(0, minOf(constraints.maxWidth, constraints.maxHeight))
        val disc = measurables.single().measure(Constraints.fixed(diameter, diameter))
        layout(constraints.maxWidth, constraints.maxHeight) {
            disc.placeRelative(frame.start.dp.roundToPx(), (constraints.maxHeight - diameter) / 2)
        }
    }
}
