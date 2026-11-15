"use strict";

let liveBarSession = null;
let liveBarTimer = null;
let liveBarAutoHideTimer = null;
let liveBarAnimationTimer = null;
let liveBarCapsuleMotionTimer = null;
let liveBarCapsuleStatusTransitionTimer = null;
let liveBarSessionKey = null;
let liveBarStatusSignature = "";
let liveBarVisualKey = "";
let liveBarAutoHidden = false;
let liveBarCapsule = false;
let liveBarProgressActive = false;
let liveBarOrbAnimationFrame = null;
let liveBarOrbId = 0;
let liveBarOrbAnimationOrb = null;
let liveBarOrbAnimationStartedAt = null;
let liveBarOrbAnimationToken = 0;
let liveBarPendingApproval = null;
let liveBarUnsubscribes = [];

const LIVE_BAR_VISIBLE_MS = 10000;
const LIVE_BAR_ANIMATION_MS = 280;
const LIVE_BAR_CAPSULE_ANIMATION_MS = 320;
const LIVE_BAR_ORB_SVG_NS = "http://www.w3.org/2000/svg";
const LIVE_BAR_ORB_VIEWBOX_SIZE = 44;
const LIVE_BAR_ORB_CENTER = LIVE_BAR_ORB_VIEWBOX_SIZE / 2;
const LIVE_BAR_ORB_SPHERE_RADIUS = 13;
const LIVE_BAR_ORB_RING_RADIUS = 18.8;
const LIVE_BAR_ORB_RING_SEGMENTS = 128;
const LIVE_BAR_ORB_TUMBLE_MS = 6000;
const LIVE_BAR_ORB_STATIC_TIME_MS = 500;

function parseLiveBarTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatLiveBarElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getLiveBarStartedAt(session, status) {
  if (status?.key !== "running") return 0;
  return parseLiveBarTimestamp(session?.activity?.run?.startedAt);
}

function stopLiveBarTimer() {
  if (liveBarTimer) clearInterval(liveBarTimer);
  liveBarTimer = null;
}

function clearLiveBarAutoHideTimer() {
  if (liveBarAutoHideTimer) clearTimeout(liveBarAutoHideTimer);
  liveBarAutoHideTimer = null;
}

function clearLiveBarAnimationTimer() {
  if (liveBarAnimationTimer) clearTimeout(liveBarAnimationTimer);
  liveBarAnimationTimer = null;
}

function clearLiveBarCapsuleMotionTimer() {
  if (liveBarCapsuleMotionTimer) clearTimeout(liveBarCapsuleMotionTimer);
  liveBarCapsuleMotionTimer = null;
}

function clearLiveBarCapsuleStatusTransitionTimer() {
  if (liveBarCapsuleStatusTransitionTimer) clearTimeout(liveBarCapsuleStatusTransitionTimer);
  liveBarCapsuleStatusTransitionTimer = null;
}

function stopLiveBarOrbAnimation() {
  liveBarOrbAnimationToken += 1;
  if (liveBarOrbAnimationFrame !== null) {
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(liveBarOrbAnimationFrame);
    } else if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(liveBarOrbAnimationFrame);
    }
  }
  liveBarOrbAnimationFrame = null;
  liveBarOrbAnimationOrb = null;
  liveBarOrbAnimationStartedAt = null;
}

window.RagentMotion?.subscribeReducedMotion?.((reduced) => {
  if (!reduced) return;
  const activeOrb = liveBarOrbAnimationOrb;
  stopLiveBarOrbAnimation();
  if (activeOrb) renderLiveBarOrb(activeOrb);
});
function getLiveBarSessionKey(session) {
  return String(session?.id || session?.sessionId || "");
}

function getLiveBarPrefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
}

function getLiveBarMotionHost(el) {
  return document.getElementById("chatStatusHeader")
    || el?.parentElement
    || el;
}

function clearLiveBarCapsule(el) {
  if (!liveBarCapsule && !el?.dataset?.collapsed) return;
  liveBarCapsule = false;
  if (el) {
    delete el.dataset.collapsed;
    setLiveBarCapsuleA11y(el, false);
  }
}

function setLiveBarCapsuleMotion(el, motion, options = {}) {
  clearLiveBarCapsuleMotionTimer();
  if (!el) return;
  if (motion) {
    el.dataset.capsuleMotion = motion;
    if (options.autoClear === false) return;
    liveBarCapsuleMotionTimer = setTimeout(() => {
      delete el.dataset.capsuleMotion;
      liveBarCapsuleMotionTimer = null;
    }, LIVE_BAR_CAPSULE_ANIMATION_MS);
  } else {
    delete el.dataset.capsuleMotion;
  }
}

function revealLiveBar(el) {
  const motionHost = getLiveBarMotionHost(el);
  clearLiveBarAnimationTimer();
  el.hidden = false;
  motionHost.classList.remove("is-collapsing");
  motionHost.classList.remove("is-capsule-exiting");
  motionHost.classList.remove("is-revealing");
  void motionHost.offsetWidth;
  motionHost.classList.add("is-revealing");
  liveBarAnimationTimer = setTimeout(() => {
    motionHost.classList.remove("is-revealing");
    liveBarAnimationTimer = null;
  }, LIVE_BAR_ANIMATION_MS);
}

function collapseLiveBar(el) {
  const motionHost = getLiveBarMotionHost(el);
  clearLiveBarAutoHideTimer();
  clearLiveBarAnimationTimer();
  clearLiveBarCapsuleStatusTransitionTimer();
  clearLiveBarCapsule(el);
  setLiveBarCapsuleMotion(el, "");
  if (el.hidden) return;
  motionHost.classList.remove("is-revealing");
  motionHost.classList.remove("is-capsule-exiting");
  motionHost.classList.add("is-collapsing");
  liveBarAnimationTimer = setTimeout(() => {
    el.hidden = true;
    motionHost.classList.remove("is-collapsing");
    liveBarAutoHidden = true;
    stopLiveBarOrbAnimation();
    stopLiveBarTimer();
    liveBarAnimationTimer = null;
  }, LIVE_BAR_ANIMATION_MS);
}

function collapseLiveBarToCapsule(el) {
  clearLiveBarAutoHideTimer();
  clearLiveBarAnimationTimer();
  clearLiveBarCapsuleStatusTransitionTimer();
  if (el.hidden || liveBarCapsule) return;
  liveBarCapsule = true;
  setLiveBarCapsuleA11y(el, true);
  // Mirror of expandLiveBarFromCapsule: commit the real capsule state up front so
  // the base .live-bar transition animates width/height/padding/roundness down to
  // the circle, exactly reversing the expand. The orb stays an in-flow flex item and
  // is carried to the capsule center by the shell's own shrinking width/padding — no
  // separate transform keyframe, so it can't fling past the shell or overlap the label.
  if (getLiveBarPrefersReducedMotion()) {
    el.dataset.collapsed = "capsule";
    delete el.dataset.capsuleMotion;
    return;
  }
  setLiveBarCapsuleMotion(el, "collapsing");
  el.dataset.collapsed = "capsule";
}

function expandLiveBarFromCapsule(el) {
  if (!liveBarCapsule) return;
  setLiveBarCapsuleMotion(el, "expanding");
  clearLiveBarCapsule(el);
  const model = window.RagentSessionStateModel;
  const status = (model && typeof model.getSessionVisualStatus === "function")
    ? model.getSessionVisualStatus(liveBarSession || {}, {})
    : null;
  scheduleLiveBarAutoHide(el, status);
}

function renderLiveBarStatusContent(el, status) {
  stopLiveBarOrbAnimation();
  el.replaceChildren();
  el.append(createLiveBarOrb());
  const label = document.createElement("span");
  label.className = "live-bar__label";
  const elapsed = document.createElement("span");
  elapsed.className = "live-bar__elapsed";
  elapsed.setAttribute("aria-hidden", "true");
  el.append(label, elapsed);
  const text = status?.label || "";
  if (window.RagentLiveActionTransition?.setText) {
    window.RagentLiveActionTransition.setText(label, text);
  } else {
    label.textContent = text;
  }
}

function updateLiveBarStatusLabel(el, status) {
  const label = el?.querySelector?.(".live-bar__label");
  if (!label) return false;
  const text = status?.label || "";
  if (window.RagentLiveActionTransition?.setText) {
    window.RagentLiveActionTransition.setText(label, text);
  } else {
    label.textContent = text;
  }
  return true;
}

function getLiveBarDisplayStatus(status) {
  const livePresentation = window.RagentRunActivity?.getLivePresentation?.();
  const actionPresentation = window.RagentRunActivity?.getPresentation?.();
  const liveRunId = String(liveBarSession?.activity?.run?.runId || "").trim();
  const progressRunId = String(livePresentation?.progress?.runId || "").trim();
  const progressMatchesRun = !!livePresentation?.progress
    && (!liveRunId || !progressRunId || liveRunId === progressRunId);
  const presentation = progressMatchesRun ? livePresentation : (actionPresentation || livePresentation);
  const statusKey = String(status?.key || "");
  const activityState = String(presentation?.activity?.state || "");
  const compatible = statusKey === "running"
    || (statusKey === "waiting_user" && activityState === "waiting_user");
  if (!presentation?.text || !compatible) {
    return status;
  }
  return {
    ...status,
    label: presentation.text,
    activitySourceSeq: presentation.sourceSeq,
    progressSourceSeq: presentation.progress?.sourceSeq || 0,
    progressActive: progressMatchesRun,
  };
}

function hasLiveBarProgress(status) {
  return status?.progressActive === true;
}

// Waiting-for-user states that demand the user's attention. These never
// auto-hide or auto-collapse: they stay full-width and prominent so the user
// knows exactly what is being asked of them (approve / answer).
function isLiveBarAttentionStatus(key) {
  return [
    "waiting_user",
    "approval_pending",
    "plan_pending",
    "danger_pending",
    "awaiting_answer",
  ].includes(String(key || ""));
}

// The Live Bar is a persistent, always-present status strip covering every
// state: idle shows a neutral "Ready" pill, attention states stay pinned, and
// only long-running work may fold to the compact capsule for breathing room.
function isLiveBarPersistent() {
  // Running stays a Live Bar on every viewport; nothing hides it entirely.
  return true;
}

// Prefer a concrete pending user action over the generic session status.
// When the current session has a live pending approval/question (fed by
// RagentDecisions), map it to the specific waiting subtype (plan / danger /
// approval / answer). Otherwise fall back to the session visual status.
function resolveLiveBarDisplayStatus(session, baseStatus) {
  const model = window.RagentSessionStateModel;
  const pending = liveBarPendingApproval && getLiveBarSessionKey(session)
    ? liveBarPendingApproval
    : null;
  if (pending && model && typeof model.resolveApprovalWaitingStatus === "function") {
    const approvedStatus = model.resolveApprovalWaitingStatus(pending);
    if (approvedStatus && approvedStatus.key) return approvedStatus;
  }
  const key = String(baseStatus?.key || "");
  // Idle but present -> a neutral persistent "Ready" pill instead of hiding.
  if (!key || key === "idle") {
    if (model && typeof model.createReadyStatus === "function") {
      return model.createReadyStatus();
    }
  }
  return baseStatus;
}

function transitionLiveBarCapsuleToStatus(el, status, key) {
  const motionHost = getLiveBarMotionHost(el);
  clearLiveBarAutoHideTimer();
  clearLiveBarAnimationTimer();
  clearLiveBarCapsuleStatusTransitionTimer();
  setLiveBarCapsuleA11y(el, false);
  setLiveBarCapsuleMotion(el, "");
  motionHost.classList.remove("is-revealing", "is-collapsing");
  motionHost.classList.add("is-capsule-exiting");
  liveBarCapsuleStatusTransitionTimer = setTimeout(() => {
    motionHost.classList.remove("is-capsule-exiting");
    liveBarCapsuleStatusTransitionTimer = null;
    clearLiveBarCapsule(el);
    el.hidden = true;
    el.dataset.state = String(key);
    renderLiveBarStatusContent(el, status);
    liveBarAutoHidden = false;
    revealLiveBar(el);
    scheduleLiveBarAutoHide(el, status);
    syncLiveBarMotionState();
    syncLiveBarOrbAnimation(el, status);
    renderLiveBarElapsed();
    scheduleLiveBarTimer();
  }, LIVE_BAR_ANIMATION_MS);
}

function scheduleLiveBarAutoHide(el, status) {
  clearLiveBarAutoHideTimer();
  // The status control now lives in the persistent Android-style chat header.
  // Keep the existing status transitions and click behavior, but do not fold
  // the header back into the legacy bottom-only capsule presentation.
  if (document.getElementById("chatStatusHeader")) return;
  // Attention states (approvals / questions / waiting_user) are persistent and
  // never collapse: they stay full-width until the user resolves them.
  if (isLiveBarAttentionStatus(status?.key)) return;
  if (status?.key !== "running") return;
  if (hasLiveBarProgress(status)) return;
  liveBarAutoHideTimer = setTimeout(() => collapseLiveBarToCapsule(el), LIVE_BAR_VISIBLE_MS);
}

function renderLiveBarElapsed() {
  const el = document.getElementById("liveBar");
  const elapsedEl = el?.querySelector?.(".live-bar__elapsed");
  if (!el || el.hidden || !elapsedEl || !liveBarSession) return;
  const model = window.RagentSessionStateModel;
  const status = model?.getSessionVisualStatus?.(liveBarSession, {});
  const startedAt = getLiveBarStartedAt(liveBarSession, status);
  elapsedEl.hidden = startedAt <= 0;
  elapsedEl.textContent = startedAt > 0
    ? formatLiveBarElapsed(Math.max(0, Date.now() - startedAt))
    : "";
}

function scheduleLiveBarTimer() {
  stopLiveBarTimer();
  const el = document.getElementById("liveBar");
  if (document.hidden || !liveBarSession || !el || el.hidden) return;
  const status = window.RagentSessionStateModel?.getSessionVisualStatus?.(liveBarSession, {});
  if (getLiveBarStartedAt(liveBarSession, status) <= 0) return;
  liveBarTimer = setInterval(renderLiveBarElapsed, 1000);
}

function syncLiveBarMotionState() {
  const el = document.getElementById("liveBar");
  if (!el) return;
  el.dataset.motionPaused = document.hidden ? "true" : "false";
}

function createLiveBarSvgElement(tagName, attrs = {}) {
  const el = typeof document.createElementNS === "function"
    ? document.createElementNS(LIVE_BAR_ORB_SVG_NS, tagName)
    : document.createElement(tagName);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
    if (key === "class" && typeof el.className === "string") {
      el.className = String(value);
    }
  }
  return el;
}

function createLiveBarOrbGradient(gradientId) {
  const defs = createLiveBarSvgElement("defs");
  const gradient = createLiveBarSvgElement("radialGradient", {
    id: gradientId,
    cx: "50%",
    cy: "50%",
    r: "58%",
  });
  gradient.append(
    createLiveBarSvgElement("stop", {
      class: "live-bar__orb-sphere-stop-main",
      offset: "56%",
    }),
    createLiveBarSvgElement("stop", {
      class: "live-bar__orb-sphere-stop-edge",
      offset: "100%",
    }),
  );
  defs.append(gradient);
  return defs;
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function getLiveBarOrbAngles(timeMs = LIVE_BAR_ORB_STATIC_TIME_MS) {
  const cycle = ((Number(timeMs) || 0) % LIVE_BAR_ORB_TUMBLE_MS) / LIVE_BAR_ORB_TUMBLE_MS;
  const fullTurn = cycle * 360;
  const phase = cycle * Math.PI * 2;
  return {
    rotateX: 64 + fullTurn + Math.sin(phase) * 58,
    rotateY: -28 + fullTurn + Math.cos(phase) * 74,
    rotateZ: 18 + fullTurn - Math.sin(phase) * 36,
  };
}

function projectLiveBarOrbRingPoint(theta, angles) {
  const rotateX = degreesToRadians(angles.rotateX);
  const rotateY = degreesToRadians(angles.rotateY);
  const rotateZ = degreesToRadians(angles.rotateZ);
  const cosX = Math.cos(rotateX);
  const sinX = Math.sin(rotateX);
  const cosY = Math.cos(rotateY);
  const sinY = Math.sin(rotateY);
  const cosZ = Math.cos(rotateZ);
  const sinZ = Math.sin(rotateZ);

  const baseX = Math.cos(theta) * LIVE_BAR_ORB_RING_RADIUS;
  const baseY = Math.sin(theta) * LIVE_BAR_ORB_RING_RADIUS;
  const baseZ = 0;
  const x1 = baseX;
  const y1 = baseY * cosX - baseZ * sinX;
  const z1 = baseY * sinX + baseZ * cosX;
  const x2 = x1 * cosY + z1 * sinY;
  const y2 = y1;
  const z2 = -x1 * sinY + z1 * cosY;
  const x3 = x2 * cosZ - y2 * sinZ;
  const y3 = x2 * sinZ + y2 * cosZ;

  return {
    x: LIVE_BAR_ORB_CENTER + x3,
    y: LIVE_BAR_ORB_CENTER + y3,
    z: z2,
  };
}

function formatLiveBarOrbCoord(value) {
  return Number(value).toFixed(2);
}

function buildLiveBarOrbRingPaths(angles) {
  const frontPath = [];
  const backPath = [];
  let previous = projectLiveBarOrbRingPoint(0, angles);
  for (let index = 1; index <= LIVE_BAR_ORB_RING_SEGMENTS; index += 1) {
    const theta = (index / LIVE_BAR_ORB_RING_SEGMENTS) * Math.PI * 2;
    const next = projectLiveBarOrbRingPoint(theta, angles);
    const target = ((previous.z + next.z) / 2) >= 0 ? frontPath : backPath;
    target.push(
      `M ${formatLiveBarOrbCoord(previous.x)} ${formatLiveBarOrbCoord(previous.y)} ` +
      `L ${formatLiveBarOrbCoord(next.x)} ${formatLiveBarOrbCoord(next.y)}`,
    );
    previous = next;
  }
  return {
    back: backPath.join(" "),
    front: frontPath.join(" "),
  };
}

function renderLiveBarOrb(orb, timeMs = LIVE_BAR_ORB_STATIC_TIME_MS) {
  const backRing = orb?.querySelector?.(".live-bar__ring--back");
  const frontRing = orb?.querySelector?.(".live-bar__ring--front");
  if (!backRing || !frontRing) return;
  const paths = buildLiveBarOrbRingPaths(getLiveBarOrbAngles(timeMs));
  backRing.setAttribute("d", paths.back);
  frontRing.setAttribute("d", paths.front);
}

function canAnimateLiveBarOrb() {
  return (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
    || typeof requestAnimationFrame === "function";
}

function requestLiveBarOrbAnimationFrame(callback) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return requestAnimationFrame(callback);
}

function getLiveBarOrbPrefersReducedMotion() {
  return getLiveBarPrefersReducedMotion();
}

function shouldAnimateLiveBarOrb(el, status) {
  return status?.key === "running"
    && !el?.hidden
    && !document.hidden
    && !getLiveBarOrbPrefersReducedMotion()
    && canAnimateLiveBarOrb();
}

function syncLiveBarOrbAnimation(el, status) {
  const orb = el?.querySelector?.(".live-bar__orb");
  if (!orb) {
    stopLiveBarOrbAnimation();
    return;
  }
  if (!shouldAnimateLiveBarOrb(el, status)) {
    stopLiveBarOrbAnimation();
    renderLiveBarOrb(orb);
    return;
  }
  if (liveBarOrbAnimationFrame) return;
  const tick = (timeMs) => {
    liveBarOrbAnimationFrame = null;
    const model = window.RagentSessionStateModel;
    const currentStatus = model?.getSessionVisualStatus?.(liveBarSession || {}, {}) || status;
    if (!shouldAnimateLiveBarOrb(el, currentStatus)) {
      renderLiveBarOrb(orb);
      return;
    }
    renderLiveBarOrb(orb, timeMs);
    liveBarOrbAnimationFrame = requestLiveBarOrbAnimationFrame(tick);
  };
  liveBarOrbAnimationFrame = requestLiveBarOrbAnimationFrame(tick);
}

function setLiveBarCapsuleA11y(el, enabled) {
  if (!el) return;
  if (enabled) {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    const labelEl = el.querySelector?.(".live-bar__label");
    el.setAttribute("aria-label", (labelEl?.textContent || "Live status").trim());
    el.removeAttribute("aria-haspopup");
  } else {
    // Keep role="status" so aria-live keeps announcing status changes. On mobile
    // the labeled bar also opens the Run Sheet, so make it keyboard-reachable and
    // advertise the dialog it controls without stealing the live-region role.
    el.setAttribute("role", "status");
    el.removeAttribute("aria-label");
  if (isLiveBarMobileViewport() || document.getElementById("chatStatusHeader")) {
      el.tabIndex = 0;
      el.setAttribute("aria-haspopup", "dialog");
    } else {
      el.tabIndex = -1;
      el.removeAttribute("aria-haspopup");
    }
  }
}

function isLiveBarMobileViewport() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 767px)").matches === true;
}

function openLiveBarDetails() {
  // Live Bar is decoupled from the Decision Sheet: clicking the Live Bar
  // primarily opens the top Run Sheet.
  if (typeof window.openRunSheet === "function") {
    window.openRunSheet();
    return;
  }
  // Fallback compatibility when run-sheet is not loaded:
  if (
    typeof window.RagentDecisionSheet?.reopen === "function"
    && typeof window.RagentDecisions?.getPending === "function"
    && window.RagentDecisions.getPending()
  ) {
    window.RagentDecisionSheet.reopen();
  }
}

function activateLiveBar(el) {
  // The capsule is the collapsed Live Bar, so its first activation only
  // restores the full status strip. The expanded bar remains the entry point
  // for the Run Sheet or pending Decision Sheet.
  if (liveBarCapsule) {
    expandLiveBarFromCapsule(el);
    return;
  }
  openLiveBarDetails();
}

function bindLiveBarClick(el) {
  if (el.dataset.clickBound === "true") return;
  el.dataset.clickBound = "true";
  el.addEventListener("click", () => activateLiveBar(el));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      activateLiveBar(el);
    }
  });
}

function createLiveBarOrb() {
  const orb = document.createElement("span");
  orb.className = "live-bar__orb";
  orb.setAttribute("aria-hidden", "true");
  const orbSvg = createLiveBarSvgElement("svg", {
    class: "live-bar__orb-svg",
    viewBox: `0 0 ${LIVE_BAR_ORB_VIEWBOX_SIZE} ${LIVE_BAR_ORB_VIEWBOX_SIZE}`,
    focusable: "false",
  });
  const gradientId = `live-bar-orb-sphere-gradient-${liveBarOrbId += 1}`;
  const defs = createLiveBarOrbGradient(gradientId);
  const backRing = createLiveBarSvgElement("path", {
    class: "live-bar__ring live-bar__ring--back",
  });
  const sphere = createLiveBarSvgElement("circle", {
    class: "live-bar__orb-sphere",
    cx: LIVE_BAR_ORB_CENTER,
    cy: LIVE_BAR_ORB_CENTER,
    r: LIVE_BAR_ORB_SPHERE_RADIUS,
    fill: `url(#${gradientId})`,
  });
  const frontRing = createLiveBarSvgElement("path", {
    class: "live-bar__ring live-bar__ring--front",
  });
  orbSvg.append(defs, backRing, sphere, frontRing);
  orb.append(orbSvg);
  renderLiveBarOrb(orb);
  return orb;
}

function updateLiveBar(session) {
  const el = document.getElementById("liveBar");
  if (!el) return;
  bindLiveBarClick(el);
  liveBarSession = session || null;
  const model = window.RagentSessionStateModel;
  if (!model || typeof model.getSessionVisualStatus !== "function") {
    clearLiveBarAutoHideTimer();
    clearLiveBarAnimationTimer();
    clearLiveBarCapsule(el);
    el.hidden = true;
    stopLiveBarOrbAnimation();
    stopLiveBarTimer();
    return;
  }
  const status = resolveLiveBarDisplayStatus(
    session,
    getLiveBarDisplayStatus(model.getSessionVisualStatus(session || {}, {})),
  );
  const key = status && status.key;
  const sessionKey = getLiveBarSessionKey(session);
  const progressActive = hasLiveBarProgress(status);
  const progressModeChanged = liveBarProgressActive !== progressActive;
  const statusSignature = `${String(key || "")}::${String(status?.label || "")}::${Number(status?.activitySourceSeq) || 0}::${progressActive ? "progress" : "activity"}::${Number(status?.progressSourceSeq) || 0}`;
  const enteredSession = liveBarSessionKey !== sessionKey;
  const visualStatusChanged = liveBarVisualKey !== String(key || "");
  const contentChanged = liveBarStatusSignature !== statusSignature;
  liveBarSessionKey = sessionKey;
  liveBarStatusSignature = statusSignature;
  liveBarVisualKey = String(key || "");
  liveBarProgressActive = progressActive;
  // The Live Bar is a persistent status strip: idle/ready states stay visible
  // (a neutral pill) instead of hiding the whole display. No branch ever hides
  // the bar entirely for an active session.
  if (!key || key === "idle") {
    const motionHost = getLiveBarMotionHost(el);
    clearLiveBarAutoHideTimer();
    clearLiveBarCapsuleStatusTransitionTimer();
    clearLiveBarCapsule(el);
    setLiveBarCapsuleMotion(el, "");
    el.dataset.state = String(key || "ready");
    if (enteredSession || visualStatusChanged || el.children.length === 0) {
      renderLiveBarStatusContent(el, status);
    } else if (contentChanged) {
      updateLiveBarStatusLabel(el, status);
    }
    motionHost.classList.remove("is-collapsing", "is-capsule-exiting");
    if (el.hidden || liveBarAutoHidden) {
      liveBarAutoHidden = false;
      revealLiveBar(el);
    }
    liveBarCapsule = false;
    liveBarProgressActive = false;
    stopLiveBarOrbAnimation();
    stopLiveBarTimer();
    syncLiveBarMotionState();
    return;
  }
  if (liveBarCapsule && visualStatusChanged && !enteredSession && key !== "running") {
    transitionLiveBarCapsuleToStatus(el, status, key);
    return;
  }
  if ((liveBarAutoHidden || liveBarCapsule) && !enteredSession && !visualStatusChanged) {
    if (!progressActive) {
      if (contentChanged) updateLiveBarStatusLabel(el, status);
      return;
    }
    if (liveBarCapsule) {
      setLiveBarCapsuleMotion(el, "expanding");
      clearLiveBarCapsule(el);
    }
    if (liveBarAutoHidden || el.hidden) {
      liveBarAutoHidden = false;
      revealLiveBar(el);
    }
  }
  el.dataset.state = String(key);
  if (enteredSession || visualStatusChanged || el.children.length === 0) {
    renderLiveBarStatusContent(el, status);
  } else if (contentChanged) {
    updateLiveBarStatusLabel(el, status);
  }
  if (enteredSession || visualStatusChanged || el.hidden) {
    clearLiveBarCapsule(el);
    liveBarAutoHidden = false;
    revealLiveBar(el);
    scheduleLiveBarAutoHide(el, status);
  }
  if (progressActive) {
    clearLiveBarAutoHideTimer();
  } else if (progressModeChanged) {
    scheduleLiveBarAutoHide(el, status);
  }
  syncLiveBarMotionState();
  syncLiveBarOrbAnimation(el, status);
  renderLiveBarElapsed();
  scheduleLiveBarTimer();
}

document.addEventListener("visibilitychange", () => {
  syncLiveBarMotionState();
  const el = document.getElementById("liveBar");
  const status = window.RagentSessionStateModel?.getSessionVisualStatus?.(liveBarSession || {}, {});
  syncLiveBarOrbAnimation(el, status);
  renderLiveBarElapsed();
  scheduleLiveBarTimer();
});

window.RagentRunActivity?.subscribe?.(() => {
  if (liveBarSession) updateLiveBar(liveBarSession);
});

// Keep the Live Bar in sync with the live pending approval / question for the
// current session (fed by RagentDecisions). When an approval lands, the bar
// re-renders into the concrete waiting subtype; when it resolves or the
// session switches (reset() notifies), it returns to the persistent status.
// Phase 5: a pending privileged batch (danger ops) counts as the pending
// approval too — and wins over a regular one (the sheet shows the same).
(function bindLiveBarDecisions() {
  const store = window.RagentDecisions;
  if (!store || typeof store.subscribe !== "function") return;
  function refreshLiveBarPending() {
    const batch = typeof store.getPendingBatch === "function"
      ? store.getPendingBatch()
      : null;
    liveBarPendingApproval = batch
      || (typeof store.getPending === "function" ? store.getPending() : null);
    if (liveBarSession) {
      updateLiveBar(liveBarSession);
      return;
    }
    if (!liveBarPendingApproval) {
      // No active session yet (e.g. boot + reset): clear any stale capsule.
      const el = document.getElementById("liveBar");
      if (el) {
        clearLiveBarAutoHideTimer();
        clearLiveBarCapsule(el);
        el.hidden = true;
        el.dataset.state = "";
        liveBarAutoHidden = false;
      }
    }
  }
  const unsub = store.subscribe(refreshLiveBarPending);
  const unsubBatch = typeof store.subscribeBatch === "function"
    ? store.subscribeBatch(refreshLiveBarPending)
    : null;
  if (typeof unsub === "function") liveBarUnsubscribes.push(unsub);
  if (typeof unsubBatch === "function") liveBarUnsubscribes.push(unsubBatch);
})();
