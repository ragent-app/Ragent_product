const SWIPE_GESTURE_LOCK_DISTANCE_PX = 18;
const SWIPE_GESTURE_TRIGGER_DISTANCE_PX = 64;
const SWIPE_GESTURE_DIRECTION_RATIO = 1.1;
const EDGE_GESTURE_ZONE_RATIO = 0.3;
const PROJECT_LEVEL_EDGE_ZONE_PX = 28;
const SESSION_SIDEBAR_GESTURE_OPEN = "sessions-open";
const SESSION_SIDEBAR_GESTURE_CLOSE = "sessions-close";
const PROJECT_LEVEL_BACK_GESTURE = "project-level-back";

let swipeGestureState = null;
let swipeGestureActionInFlight = false;

function canUseSwipeGestures() {
  if (isDesktop || visitorMode) return false;
  if (addToolModal && !addToolModal.hidden) return false;
  // Portaled composer panels own the touch surface while open. Do not let an
  // edge swipe beginning anywhere during their async/scrolling state close a
  // sidebar underneath them.
  if (document.querySelector?.(".composer-add-panel:not([hidden])")) return false;
  return true;
}

function isSwipeGestureBlockedTarget(target, startX) {
  if (!(target instanceof Element)) return false;
  // Always block true input/content-editable areas
  if (target.closest("input, textarea, select, [contenteditable='true'], .input-area, .input-wrapper, .composer-add-panel")) {
    return true;
  }
  // For edge zones, allow gestures even on buttons (needed for closing sidebars from list items)
  const screenWidth = window.innerWidth;
  const inLeftEdge = isInEdgeZone(startX, screenWidth, "left");
  const context = getSwipeContext();
  const projectLevelBack = context.sidebarOpen
    && isInProjectLevelEdgeZone(startX, screenWidth)
    && window.RagentProjectView?.canStartEdgeBackSwipe?.();
  // If we're in an edge zone with a valid action context, don't block
  if (
    (inLeftEdge && (context.rightSidebarOpen || context.auditOpen))
    || projectLevelBack
    || (isInEdgeZone(startX, screenWidth, "right") && context.sidebarOpen)
  ) {
    // Only block truly interactive elements, not general buttons
    return Boolean(target.closest("input, textarea, select, label, [contenteditable='true'], .input-area, .input-wrapper, .composer-add-panel"));
  }
  // Outside edge zones or without valid action, block all interactive elements
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, label, summary, pre, code, [contenteditable='true'], .input-area, .input-wrapper, .composer-add-panel",
    ),
  );
}

function isInEdgeZone(x, screenWidth, edge) {
  const edgeThreshold = screenWidth * EDGE_GESTURE_ZONE_RATIO;
  if (edge === "left") return x <= edgeThreshold;
  if (edge === "right") return x >= screenWidth - edgeThreshold;
  return false;
}

function isInProjectLevelEdgeZone(x, screenWidth) {
  return x <= Math.min(PROJECT_LEVEL_EDGE_ZONE_PX, screenWidth * 0.12);
}

function getSwipeContext() {
  const sidebarOpen = sidebarOverlay?.classList.contains("open");
  const rightSidebarOpen = document.body.classList.contains("right-sidebar-open");
  const auditOpen = document.body.classList.contains("workbench-inspector-open")
    && !document.body.classList.contains("workbench-inspector-collapsed");
  return { sidebarOpen, rightSidebarOpen, auditOpen };
}

function getSwipeGestureDirection(deltaX) {
  if (!Number.isFinite(deltaX) || deltaX === 0) return null;
  return deltaX > 0 ? "right" : "left";
}

function getSwipeGestureDistance(deltaX, direction) {
  if (direction === "right") return deltaX;
  if (direction === "left") return -deltaX;
  return 0;
}

function getSwipeGestureAction(direction, startX, screenWidth, context) {
  const { sidebarOpen, rightSidebarOpen, auditOpen } = context;

  if (direction === "right") {
    // Right swipe (finger moves left → right, pushing panels back to the right)
    if (
      sidebarOpen
      && isInProjectLevelEdgeZone(startX, screenWidth)
      && window.RagentProjectView?.canStartEdgeBackSwipe?.()
    ) {
      // L2 owns the left-edge back gesture while the sessions sidebar is open.
      // It wins over the global left-edge gesture that opens the sidebar.
      return {
        gesture: PROJECT_LEVEL_BACK_GESTURE,
        run: () => Promise.resolve(),
      };
    }
    if (rightSidebarOpen && isInEdgeZone(startX, screenWidth, "left")) {
      // Close right sidebar
      return {
        run: () => {
          if (typeof window.closeRightSidebar === "function") {
            window.closeRightSidebar();
          }
          return Promise.resolve();
        },
      };
    }
    if (auditOpen && isInEdgeZone(startX, screenWidth, "left")) {
      // Close audit panel — find the currently active tab and toggle on it
      return {
        run: () => {
          if (typeof window.ragentOpenWorkbenchInspectorTab === "function") {
            const activeBtn = document.querySelector('[data-inspector-tab][aria-selected="true"]');
            const currentTab = activeBtn?.dataset?.inspectorTab || "activity";
            window.ragentOpenWorkbenchInspectorTab(currentTab, { toggle: true });
          }
          return Promise.resolve();
        },
      };
    }
    if (!sidebarOpen && !rightSidebarOpen && !auditOpen && isInEdgeZone(startX, screenWidth, "left")) {
      // Open sessions sidebar
      return {
        gesture: SESSION_SIDEBAR_GESTURE_OPEN,
        run: () => Promise.resolve(openSessionsSidebar()),
      };
    }
  }

  if (direction === "left") {
    // Left swipe (finger moves right → left, pushing panels back to the left)
    if (sidebarOpen && isInEdgeZone(startX, screenWidth, "right")) {
      // Close sessions sidebar
      return {
        gesture: SESSION_SIDEBAR_GESTURE_CLOSE,
        run: () => {
          if (typeof closeSidebarFn === "function") {
            closeSidebarFn();
          }
          return Promise.resolve();
        },
      };
    }
  }

  return null;
}

function scheduleGestureFrame(callback) {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  if (typeof window.setTimeout === "function") {
    return window.setTimeout(callback, 0);
  }
  callback();
  return null;
}

function scheduleGestureTimeout(callback, delay) {
  if (typeof window.setTimeout === "function") {
    return window.setTimeout(callback, delay);
  }
  callback();
  return null;
}

function prefersReducedGestureMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function getSessionSidebarGestureWidth() {
  const panel = typeof sidebar !== "undefined" ? sidebar : null;
  const measuredWidth = typeof panel?.getBoundingClientRect === "function"
    ? panel.getBoundingClientRect().width
    : 0;
  return Math.max(1, measuredWidth || window.innerWidth || 1);
}

function isSessionSidebarGesture(action) {
  return action?.gesture === SESSION_SIDEBAR_GESTURE_OPEN
    || action?.gesture === SESSION_SIDEBAR_GESTURE_CLOSE;
}

function isProjectLevelBackGesture(action) {
  return action?.gesture === PROJECT_LEVEL_BACK_GESTURE;
}

function setSessionSidebarGestureTransform(action, distance) {
  if (!isSessionSidebarGesture(action) || !sidebarOverlay) return;
  const width = getSessionSidebarGestureWidth();
  const clampedDistance = Math.max(0, Math.min(distance, width));
  const transform = action.gesture === SESSION_SIDEBAR_GESTURE_OPEN
    ? `translateX(calc(-100% + ${clampedDistance}px))`
    : `translateX(-${clampedDistance}px)`;
  sidebarOverlay.style?.setProperty("--sidebar-gesture-transform", transform);
}

function beginSessionSidebarGesture(action) {
  if (!isSessionSidebarGesture(action) || !sidebarOverlay) return;
  sidebarOverlay.classList.add("is-gesture-dragging");
  sidebarOverlay.classList.remove("is-closing");
  if (action.gesture === SESSION_SIDEBAR_GESTURE_OPEN) {
    sidebarOverlay.classList.add("open");
    sidebarOverlay.setAttribute?.("aria-hidden", "false");
  }
}

function beginProjectLevelBackGesture(action) {
  if (!isProjectLevelBackGesture(action)) return false;
  return window.RagentProjectView?.beginEdgeBackSwipe?.() === true;
}

function setProjectLevelBackGestureDistance(action, distance) {
  if (!isProjectLevelBackGesture(action)) return false;
  return window.RagentProjectView?.updateEdgeBackSwipe?.(distance) === true;
}

function settleSessionSidebarGesture(action, committed, onSettled) {
  if (!isSessionSidebarGesture(action) || !sidebarOverlay) {
    onSettled?.();
    return;
  }
  if (!committed) {
    // Keep the current transform while switching from direct manipulation to
    // the short cancel transition, then move it back to the origin.
    sidebarOverlay.classList.add("is-gesture-settling");
    sidebarOverlay.classList.remove("is-gesture-dragging");
    scheduleGestureFrame(() => {
      setSessionSidebarGestureTransform(action, 0);
      scheduleGestureTimeout(finish, prefersReducedGestureMotion() ? 0 : 180);
    });
    return;
  }

  scheduleGestureFrame(() => {
    const runAction = committed ? action.run() : Promise.resolve();
    Promise.resolve(runAction).finally(() => {
      sidebarOverlay.classList.remove("is-gesture-dragging");
      sidebarOverlay.classList.remove("is-gesture-settling");
      sidebarOverlay.style?.removeProperty("--sidebar-gesture-transform");
      if (!committed && action.gesture === SESSION_SIDEBAR_GESTURE_OPEN) {
        sidebarOverlay.classList.remove("open");
        sidebarOverlay.setAttribute?.("aria-hidden", "true");
      }
      onSettled?.();
    });
  });

  function finish() {
    sidebarOverlay.classList.remove("is-gesture-dragging", "is-gesture-settling");
    sidebarOverlay.style?.removeProperty("--sidebar-gesture-transform");
    if (action.gesture === SESSION_SIDEBAR_GESTURE_OPEN) {
      sidebarOverlay.classList.remove("open");
      sidebarOverlay.setAttribute?.("aria-hidden", "true");
    }
    onSettled?.();
  }
}

function settleProjectLevelBackGesture(action, committed, onSettled) {
  if (!isProjectLevelBackGesture(action)) {
    onSettled?.();
    return;
  }
  window.RagentProjectView?.settleEdgeBackSwipe?.(committed, onSettled);
}

function cancelSwipeGesture() {
  const state = swipeGestureState;
  swipeGestureState = null;
  if (state?.action) {
    if (isProjectLevelBackGesture(state.action)) {
      settleProjectLevelBackGesture(state.action, false);
    } else {
      settleSessionSidebarGesture(state.action, false);
    }
  }
}

function shouldCancelSwipeGesture(deltaX, deltaY) {
  if (Math.abs(deltaY) < SWIPE_GESTURE_LOCK_DISTANCE_PX) return false;
  return Math.abs(deltaY) > Math.abs(deltaX) * SWIPE_GESTURE_DIRECTION_RATIO;
}

function shouldLockSwipeGesture(deltaX, deltaY) {
  if (Math.abs(deltaX) < SWIPE_GESTURE_LOCK_DISTANCE_PX) return false;
  return Math.abs(deltaX) >= Math.abs(deltaY) * SWIPE_GESTURE_DIRECTION_RATIO;
}

function handleSwipeGestureStart(event) {
  if (!canUseSwipeGestures()) return;
  if (swipeGestureActionInFlight || swipeGestureState) return;
  if (event.touches.length !== 1) return;

  const touch = event.touches[0];
  if (isSwipeGestureBlockedTarget(event.target, touch.clientX)) return;

  swipeGestureState = {
    direction: null,
    startX: touch.clientX,
    startY: touch.clientY,
    locked: false,
    distance: 0,
  };
}

function handleSwipeGestureMove(event) {
  if (!swipeGestureState) return;
  if (event.touches.length !== 1) {
    cancelSwipeGesture();
    return;
  }

  const touch = event.touches[0];
  const deltaX = touch.clientX - swipeGestureState.startX;
  const deltaY = touch.clientY - swipeGestureState.startY;

  if (!swipeGestureState.locked) {
    if (shouldCancelSwipeGesture(deltaX, deltaY)) {
      cancelSwipeGesture();
      return;
    }
    if (!shouldLockSwipeGesture(deltaX, deltaY)) {
      return;
    }
    swipeGestureState.locked = true;
    swipeGestureState.direction = getSwipeGestureDirection(deltaX);
  }

  if (!swipeGestureState.direction) {
    return;
  }

  // A recognized horizontal direction still needs a valid action for the
  // current surface. In particular, a right-edge left swipe on the main
  // surface must remain passive instead of stealing native scrolling or
  // browser gesture handling.
  const action = swipeGestureState.action || getSwipeGestureAction(
    swipeGestureState.direction,
    swipeGestureState.startX,
    window.innerWidth,
    getSwipeContext(),
  );
  if (!action) {
    cancelSwipeGesture();
    return;
  }
  swipeGestureState.action = action;
  if (isSessionSidebarGesture(action) && !swipeGestureState.previewStarted) {
    beginSessionSidebarGesture(action);
    swipeGestureState.previewStarted = true;
  }
  if (isProjectLevelBackGesture(action) && !swipeGestureState.previewStarted) {
    if (!beginProjectLevelBackGesture(action)) {
      cancelSwipeGesture();
      return;
    }
    swipeGestureState.previewStarted = true;
  }

  const swipeDistance = getSwipeGestureDistance(deltaX, swipeGestureState.direction);
  swipeGestureState.distance = swipeDistance;

  if (swipeDistance <= 0 && !isProjectLevelBackGesture(action)) {
    return;
  }

  event.preventDefault();
  if (isSessionSidebarGesture(action)) {
    setSessionSidebarGestureTransform(action, swipeDistance);
  } else if (isProjectLevelBackGesture(action)) {
    setProjectLevelBackGestureDistance(action, swipeDistance);
  }
}

function handleSwipeGestureEnd(event) {
  if (!swipeGestureState) return;

  const finalTouch = event.changedTouches?.[0] || null;
  if (finalTouch) {
    const deltaX = finalTouch.clientX - swipeGestureState.startX;
    const deltaY = finalTouch.clientY - swipeGestureState.startY;
    if (!swipeGestureState.locked && shouldLockSwipeGesture(deltaX, deltaY)) {
      swipeGestureState.locked = true;
      swipeGestureState.direction = getSwipeGestureDirection(deltaX);
    }
    swipeGestureState.distance = getSwipeGestureDistance(deltaX, swipeGestureState.direction);
  }

  const state = swipeGestureState;
  const action = state.action || getSwipeGestureAction(
    state.direction,
    state.startX,
    window.innerWidth,
    getSwipeContext(),
  );
  const projectLevelBack = isProjectLevelBackGesture(action);
  const triggerDistance = projectLevelBack
    ? (window.RagentProjectView?.getEdgeBackSwipeTriggerDistance?.() || SWIPE_GESTURE_TRIGGER_DISTANCE_PX)
    : SWIPE_GESTURE_TRIGGER_DISTANCE_PX;
  const shouldTrigger =
    state.locked &&
    Boolean(state.direction) &&
    state.distance >= triggerDistance;
  swipeGestureState = null;
  if (!action) return;

  if (!shouldTrigger || swipeGestureActionInFlight) {
    if (isProjectLevelBackGesture(action)) {
      settleProjectLevelBackGesture(action, false);
      return;
    }
    settleSessionSidebarGesture(action, false);
    return;
  }

  if (isProjectLevelBackGesture(action)) {
    swipeGestureActionInFlight = true;
    settleProjectLevelBackGesture(action, true, () => {
      swipeGestureActionInFlight = false;
    });
    return;
  }

  if (isSessionSidebarGesture(action)) {
    swipeGestureActionInFlight = true;
    settleSessionSidebarGesture(action, true, () => {
      swipeGestureActionInFlight = false;
    });
    return;
  }

  swipeGestureActionInFlight = true;
  action.run().finally(() => {
    swipeGestureActionInFlight = false;
  });
}

document.addEventListener("touchstart", handleSwipeGestureStart, {
  passive: true,
  capture: true,
});
document.addEventListener("touchmove", handleSwipeGestureMove, { passive: false });
document.addEventListener("touchend", handleSwipeGestureEnd, { passive: true });
document.addEventListener("touchcancel", cancelSwipeGesture, { passive: true });
