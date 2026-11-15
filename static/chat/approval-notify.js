"use strict";

// approval-notify.js — in-page Notification fallback for pending approvals.
//
// Why this exists: the server already fires a web push (history.mjs ->
// maybeNotifyApprovalPending -> sendUserAttentionPush) when an approval lands,
// but web push only reaches the user once a push SUBSCRIPTION exists, and the
// only code path that ever requested Notification permission was the standalone
// PWA install flow (shouldPromptForInstalledNotifications). A normal mobile
// browser tab never prompts, so permission stayed "default", no subscription
// was ever created, and pushes fired into the void.
//
// This module closes that gap from the client side:
//  - A gesture-backed permission entry point (requestPermissionFromGesture)
//    that the Decision Sheet exposes at the exact high-intent moment an
//    approval is waiting. On grant it also bootstraps the web-push
//    subscription, so both channels come up together.
//  - An in-page Notification for approvals the user is not already looking at:
//    a background session that just turned "needs action", or the current
//    session while the tab is hidden. This works with Notification permission
//    alone (no subscription round-trip), so it covers the open-but-backgrounded
//    case the moment permission is granted.
//
// Navigation on click reuses the live session-http helpers (applyNavigationState
// + queueForegroundRefresh); this file is a classic script sharing their global
// scope, so no event plumbing is needed.
(function attachApprovalNotify(root) {
  const DANGER_VALUES = new Set([
    "high", "critical", "danger", "dangerous", "severe", "elevated",
  ]);

  // One notification per (session, approval/waiting period). A stamp is the
  // most specific id we have: the approval id for the current session, or the
  // workflowStateChangedAt/lastEventAt for a background-session transition.
  const notifiedKeys = new Set();
  // The user dismissed the sheet's "enable notifications" pill this session;
  // don't nag them again until the sheet is re-opened for a new approval.
  let enableDismissed = false;

  function supported() {
    return typeof root !== "undefined" && typeof root.Notification === "function";
  }
  function permission() {
    return supported() ? root.Notification.permission : "denied";
  }
  function tabVisible() {
    const doc = typeof document !== "undefined" ? document : root.document;
    if (!doc) return true;
    return doc.visibilityState ? doc.visibilityState === "visible" : !doc.hidden;
  }
  function ownerFeaturesEnabled() {
    return typeof shouldEnableOwnerPushFeatures === "function"
      ? shouldEnableOwnerPushFeatures()
      : true;
  }
  function t(key, vars) {
    return typeof root.ragentT === "function" ? root.ragentT(key, vars) : key;
  }

  function isProgressPlan(input = {}) {
    const kind = String(input?.kind || "").trim().toLowerCase();
    const type = String(input?.type || "").trim().toLowerCase();
    if (kind !== "plan" && type !== "plan") return false;
    const intent = String(input?.planIntent || "").trim().toLowerCase();
    if (intent) return intent === "progress";
    return String(input?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  // Map an approval event OR a bare session record to { kind, label }.
  // Mirrors server-side attention-push.mjs describeApproval so the in-page
  // notification and the web push read identically. Labels come from i18n so
  // the body localizes; background sessions without a kind fall back to the
  // generic "approval" label.
  function describeWaiting(input = {}) {
    const kind = String(input?.kind || "").trim().toLowerCase();
    const risk = String(
      input?.risk ?? input?.riskLevel ?? input?.severity ?? input?.level ?? input?.tier ?? "",
    ).trim().toLowerCase();
    const isQuestion = kind === "question"
      || !!input?.question
      || (Array.isArray(input?.questions) && input.questions.length > 0);
    if (kind === "plan") return { kind: "plan", label: t("notify.waiting.plan") };
    if (kind === "permissions" || kind === "permission" || input?.permissions) {
      return { kind: "permission", label: t("notify.waiting.permission") };
    }
    if (isQuestion) return { kind: "answer", label: t("notify.waiting.answer") };
    if (DANGER_VALUES.has(risk)) return { kind: "danger", label: t("notify.waiting.danger") };
    return { kind: "approval", label: t("notify.waiting.approval") };
  }

  function sessionName(session = {}) {
    const folder = String(session?.folder || "").split("/").pop();
    return String(session?.name || folder || t("notify.genericSession"));
  }

  function dedupKey(session, stamp) {
    const id = String(session?.id || "");
    return `${id}:${String(stamp || session?.workflowStateChangedAt || session?.lastEventAt || "")}`;
  }

  // Pure gate, exported for tests. Decides whether a notification should fire
  // given the runtime conditions, BEFORE dedup. isCurrent means the approval
  // belongs to the session the user is viewing right now.
  function shouldFire({ isSupported, perm, isCurrent, visible }) {
    if (!isSupported || perm !== "granted") return false;
    // Viewing the approval's own session with the tab focused -> the Decision
    // Sheet is on screen, a notification would just duplicate it.
    if (isCurrent && visible) return false;
    return true;
  }

  function fire(session, detail = {}) {
    if (!session?.id) return false;
    const isCurrent = isCurrentSession(session.id);
    const ok = shouldFire({
      isSupported: supported(),
      perm: permission(),
      isCurrent,
      visible: tabVisible(),
    });
    if (!ok) return false;
    const key = dedupKey(session, detail?.stamp);
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.add(key);
    try {
      const n = new root.Notification(t("notify.title"), {
        body: `${sessionName(session)} — ${detail?.label || t("notify.waiting.approval")}`,
        tag: `ragent-approval:${session.id}`,
      });
      n.onclick = () => {
        try {
          root.focus?.();
          if (typeof applyNavigationState === "function") {
            applyNavigationState({ sessionId: session.id, tab: "sessions" });
          }
          if (typeof queueForegroundRefresh === "function") {
            queueForegroundRefresh({
              forceFresh: true,
              viewportIntent: "session_entry_bottom",
            }).catch(() => {});
          }
        } catch {}
        n.close?.();
      };
    } catch (err) {
      // Some browsers throw if the tag/option shape is unsupported; roll back
      // the dedup so a future, well-formed call can still fire.
      notifiedKeys.delete(key);
      return false;
    }
    return true;
  }

  function isCurrentSession(sessionId) {
    const cur = typeof currentSessionId === "string"
      ? currentSessionId
      : (typeof root.currentSessionId === "string" ? root.currentSessionId : "");
    return !!cur && cur === sessionId;
  }

  // Gesture-backed: call ONLY from a click/tap handler (iOS Safari otherwise
  // rejects the request). On grant, bootstrap the web-push subscription in the
  // same gesture so the closed-app channel comes up alongside the in-page one.
  async function requestPermissionFromGesture() {
    if (!supported() || !ownerFeaturesEnabled()) return "unsupported";
    if (permission() === "granted") {
      bootstrapPush();
      return "granted";
    }
    if (permission() === "denied") return "denied";
    try {
      const perm = await root.Notification.requestPermission();
      if (perm === "granted") bootstrapPush();
      return perm;
    } catch {
      return "denied";
    }
  }

  function bootstrapPush() {
    // setupPushNotifications is a top-level declaration in session-http.js
    // (loaded before this file); feature-detect so a stripped/visitor build
    // does not throw.
    if (typeof setupPushNotifications === "function") {
      try { setupPushNotifications(); } catch {}
    }
  }

  // Should the Decision Sheet render the "enable notifications" pill? Only when
  // we could still usefully ask (permission "default"), the owner can use push,
  // and the user has not dismissed it this session.
  function enableAffordanceShouldShow() {
    if (enableDismissed) return false;
    if (!supported() || !ownerFeaturesEnabled()) return false;
    return permission() === "default";
  }
  function dismissEnable() { enableDismissed = true; }
  function resetEnableDismissal() { enableDismissed = false; }

  // Hook 1: current-session approval via the decisions store. Fires only when
  // the user is not viewing the sheet (tab hidden). The store's subscribe
  // delivers an immediate snapshot on subscribe, which is naturally suppressed
  // (visible + current -> shouldFire false).
  function onDecisionsSnap(snap) {
    if (!snap?.pending || !snap.evt) return;
    if (isProgressPlan(snap.evt)) return;
    const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
    if (!session?.id) return;
    const detail = describeWaiting(snap.evt);
    detail.stamp = String(snap.evt.approvalId || "");
    fire(session, detail);
  }

  // Hook 1b: privileged batch approval via the decisions store's batch channel
  // (Phase 5). A danger-tier batch (other/delete groups) fires the same in-page
  // notification so the pending approval is not silently stranded when the
  // user is away from the sheet. describeWaiting already maps the batch's
  // top-level risk ("danger") to the danger label.
  function onBatchSnap(snap) {
    if (!snap?.pending || !snap.evt) return;
    const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
    if (!session?.id) return;
    const detail = describeWaiting(snap.evt);
    detail.stamp = String(snap.evt.batchId || "");
    fire(session, detail);
  }

  // Hook 2: background-session list refresh. Detects a non-current session that
  // just transitioned INTO needs-action (was not waiting, or is new) and fires.
  function onSessionsApplied(previousMap, nextSessions) {
    if (!supported() || permission() !== "granted") return;
    const model = root.RagentSessionStateModel;
    const needsAction = (s) => typeof model?.hasSessionNeedsAction === "function"
      ? model.hasSessionNeedsAction(s)
      : String(s?.workflowState || "").toLowerCase() === "waiting_user";
    for (const next of Array.isArray(nextSessions) ? nextSessions : []) {
      if (!next?.id) continue;
      // The current session is owned by the decisions-store hook; skip it here
      // so the two hooks never both fire for the same approval.
      if (isCurrentSession(next.id)) continue;
      if (!needsAction(next)) continue;
      const prev = previousMap && typeof previousMap.get === "function" ? previousMap.get(next.id) : null;
      if (prev && needsAction(prev)) continue; // already waiting before -> not a new transition
      fire(next, {
        ...describeWaiting(next),
        stamp: next.workflowStateChangedAt || next.lastEventAt || "",
      });
    }
  }

  function init() {
    if (root.RagentApprovalNotify) return;
    if (root.RagentDecisions && typeof root.RagentDecisions.subscribe === "function") {
      root.RagentDecisions.subscribe(onDecisionsSnap);
    }
    if (root.RagentDecisions && typeof root.RagentDecisions.subscribeBatch === "function") {
      root.RagentDecisions.subscribeBatch(onBatchSnap);
    }
    root.RagentApprovalNotify = Object.freeze({
      // hot paths
      fire,
      onSessionsApplied,
      requestPermissionFromGesture,
      // sheet affordance
      enableAffordanceShouldShow,
      dismissEnable,
      resetEnableDismissal,
      // pure (for tests)
      describeWaiting,
      shouldFire,
      dedupKey,
      // test reset
      _reset() { notifiedKeys.clear(); enableDismissed = false; },
      _notifiedCount() { return notifiedKeys.size; },
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
  } else {
    // Non-browser (tests): attach lazily so tests can drive init/reset.
    init();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
