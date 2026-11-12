"use strict";

// Cross-session notification bridge.
//
// The public bridge is intentionally small and stable. Event ingestion stays
// here so background-session notifications do not depend on the open-session
// renderer, while the visual surface is a standalone Material 3 brief /
// detailed notification. The old attention-popup DOM is deliberately not
// reused.
(function attachOneUiNotifications(root) {
  const doc = root.document;
  if (!doc) return;

  const queue = new Map();
  const AUTO_DISMISS_MS = 12000;
  const EXIT_MS = 280;
  const SWIPE_THRESHOLD_RATIO = 0.42;
  const HORIZONTAL_SWIPE_THRESHOLD_RATIO = 0.35;
  const HORIZONTAL_SWIPE_VELOCITY = 0.45;
  let host = null;
  let activeId = "";
  let queueSequence = 0;
  let dismissTimer = null;
  let dismissItemId = "";
  let transitionTimer = null;
  let gesture = null;
  let gestureFrame = null;
  let snapBackTimer = null;
  let returnFocusEl = null;
  let keydownBound = false;
  // A response can arrive before a replay of the corresponding request on a
  // later invalidation. Keep bounded per-session tombstones so the background
  // notification surface cannot resurrect an already-resolved card.
  const MAX_RESOLVED_KEYS = 512;
  const resolvedKeys = new Map();

  // Session invalidations can replay the same approval event while the run is
  // waiting for the owner. Keep a content fingerprint so an idempotent replay
  // does not replace the live card and restart its enter animation.
  function stableRenderSignature(value) {
    const seen = new Set();
    const normalize = (input, key = "") => {
      if (["timestamp", "createdAt", "updatedAt", "seq", "startSeq", "endSeq", "eventId"].includes(key)) {
        return undefined;
      }
      if (input === null || typeof input !== "object") return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      let normalized;
      if (Array.isArray(input)) {
        normalized = input.map((entry) => normalize(entry));
      } else {
        normalized = {};
        for (const childKey of Object.keys(input).sort()) {
          const child = normalize(input[childKey], childKey);
          if (child !== undefined) normalized[childKey] = child;
        }
      }
      seen.delete(input);
      return normalized;
    };
    try {
      return JSON.stringify(normalize(value));
    } catch {
      return "";
    }
  }

  function tr(key, vars) {
    return typeof root.agentocT === "function" ? root.agentocT(key, vars) : key;
  }

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function rememberReturnFocus() {
    const active = doc.activeElement;
    if (active && active !== doc.body && !host?.contains?.(active)) returnFocusEl = active;
  }

  function restoreReturnFocus() {
    const target = returnFocusEl;
    returnFocusEl = null;
    if (!target?.isConnected || typeof target.focus !== "function") return;
    target.focus({ preventScroll: true });
  }

  function currentSessionId() {
    const snapshot = typeof root.getChatStoreStateSnapshot === "function"
      ? root.getChatStoreStateSnapshot()
      : null;
    return String(snapshot?.currentSessionId || root.currentSessionId || "").trim();
  }

  function isCurrentSession(sessionId) {
    return currentSessionId() === String(sessionId || "").trim();
  }

  function shouldSurface(sessionId) {
    return Boolean(sessionId) && !isCurrentSession(sessionId);
  }

  function sessionFor(sessionId, fallback = null) {
    if (typeof root.getChatStoreSession === "function") {
      return root.getChatStoreSession(sessionId) || fallback || { id: sessionId };
    }
    return fallback || { id: sessionId };
  }

  function normalizeKind(event, type = "") {
    const kind = String(event?.kind || "").trim().toLowerCase();
    const risk = String(
      event?.risk ?? event?.riskLevel ?? event?.severity ?? event?.level ?? event?.tier ?? "",
    ).trim().toLowerCase();
    if (type === "privileged_batch_request" || type === "approved_action_batch_request"
      || ["high", "critical", "danger", "dangerous", "severe", "elevated"].includes(risk)) return "danger";
    if (kind === "plan") return "plan";
    if (kind === "permissions" || kind === "permission" || event?.permissions) return "permission";
    if (kind === "question" || event?.question || (Array.isArray(event?.questions) && event.questions.length)) return "question";
    return "approval";
  }

  function compactText(value, maxLength = 92) {
    const text = String(value || "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, "")
      .trim()
      .replace(/\s+/g, " ");
    if (!text || text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }

  function compactPlainText(value, maxLength = 92) {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
  }

  function meaningfulText(value) {
    const text = compactText(value, 160);
    if (!text || /run a shell command|execute a command|request permission|approval required|approval needed/i.test(text)) return "";
    return text;
  }

  function titleFor(event, kind, type) {
    if (type === "completion") return tr("attention.completion.title");
    if (type === "privileged_batch_request" || type === "approved_action_batch_request") {
      const ops = ["other", "delete"]
        .flatMap((category) => Array.isArray(event?.[category]) ? event[category] : []);
      const actions = Array.isArray(event?.actions) ? event.actions : [];
      const all = ops.length ? ops : actions;
      if (all.length !== 1) return tr("attention.danger.title");
      const op = all[0];
      const explained = typeof root.agentocApprovalExplanation === "function"
        ? root.agentocApprovalExplanation(op?.explanation, tr) : op?.explanation;
      if (explained?.operation && explained?.summary) return compactPlainText(explained.summary, 92);
      return compactText(op?.description || op?.summary || op?.reason || event?.reason, 92) || tr("attention.danger.title");
    }
    const explained = typeof root.agentocApprovalExplanation === "function"
      ? root.agentocApprovalExplanation(event?.explanation, tr) : event?.explanation;
    if (kind !== "question" && explained?.operation && explained?.summary) return compactPlainText(explained.summary, 92);
    const question = Array.isArray(event?.questions) ? event.questions[0] : event;
    const human = kind === "question"
      ? meaningfulText(question?.question || question?.prompt || event?.question)
      : meaningfulText(event?.summary || event?.reason || event?.bodyMarkdown || event?.description);
    if (human) return compactText(human, 92);
    const explicit = meaningfulText(event?.title);
    // The question text is the title. A provider tool name ("AskUserQuestion")
    // is never user-facing copy, so it falls through to the generic label.
    if (explicit && !(kind === "question" && /^(ask\s*user(\s*question)?|question)$/i.test(explicit))) return explicit;
    if (kind === "plan") return tr("attention.plan.title");
    if (kind === "permission") return tr("attention.permission.title");
    if (kind === "question") return tr("attention.question.title");
    return tr("attention.approval.title");
  }

  function eventKey(sessionId, event, type) {
    // Never use a transport timestamp (or Date.now) as identity.  A session
    // invalidation can replay the same harness request without an explicit
    // provider id; timestamp-based keys then manufacture a new queue item on
    // every replay and restart the enter animation indefinitely.  Prefer the
    // protocol ids, then fall back to the same canonical payload fingerprint
    // used by the replay guards above.
    const explicitIdentity = [
      event?.approvalId,
      event?.batchId,
      event?.planId,
      event?.planEventRef?.planId,
      event?.providerRequestId,
      event?.providerItemId,
      event?.requestId,
      event?.id,
      event?.runId,
    ].map((value) => String(value || "").trim()).find(Boolean) || "";
    const identity = explicitIdentity || `fingerprint:${stableRenderSignature({ type, event }) || "unknown"}`;
    return `${sessionId}:${type}:${identity}`;
  }

  function rememberResolved(sessionId, event, type) {
    const key = eventKey(sessionId, event, type);
    const runId = String(event?.runId || "").trim();
    resolvedKeys.delete(key);
    resolvedKeys.set(key, runId);
    while (resolvedKeys.size > MAX_RESOLVED_KEYS) resolvedKeys.delete(resolvedKeys.keys().next().value);
  }

  function wasResolved(sessionId, event, type) {
    const key = eventKey(sessionId, event, type);
    if (!resolvedKeys.has(key)) return false;
    const resolvedRunId = String(resolvedKeys.get(key) || "").trim();
    const requestRunId = String(event?.runId || "").trim();
    if (resolvedRunId && requestRunId && resolvedRunId !== requestRunId) {
      resolvedKeys.delete(key);
      return false;
    }
    return true;
  }

  function batchRequestIdentitySet(event) {
    const ids = new Set();
    const add = (value) => {
      const normalized = String(value || "").trim();
      if (normalized) ids.add(normalized);
    };
    add(event?.approvalId);
    add(event?.batchId);
    add(event?.id);
    add(event?.requestId);
    add(event?.providerRequestId);
    add(event?.providerItemId);
    for (const category of ["other", "delete", "installAuto", "actions"]) {
      for (const operation of Array.isArray(event?.[category]) ? event[category] : []) {
        add(operation?.id);
        add(operation?.approvalId);
        add(operation?.actionId);
        add(operation?.opId);
        add(operation?.requestId);
        add(operation?.providerRequestId);
        add(operation?.providerItemId);
      }
    }
    return ids;
  }

  function regularRequestIsRepresentedByBatch(event, batchEvents) {
    const requestIds = [
      event?.approvalId,
      event?.requestId,
      event?.providerRequestId,
      event?.providerItemId,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const runId = String(event?.runId || "").trim();
    return batchEvents.some((batch) => {
      const batchIds = batchRequestIdentitySet(batch);
      if (requestIds.some((id) => batchIds.has(id))) return true;
      // A privileged batch is the single approval surface for its run.  Use
      // the run id only when the regular request has no stable cross-provider
      // id, which is how older harness adapters represented approvals.
      return !requestIds.length && runId && runId === String(batch?.runId || "").trim();
    });
  }

  function isProgressPlan(event) {
    const type = String(event?.type || "").trim();
    const kind = String(event?.kind || "").trim().toLowerCase();
    if (type !== "plan" && !(type === "approval_request" && kind === "plan")) return false;
    const intent = String(event?.planIntent || "").trim().toLowerCase();
    if (intent) return intent === "progress";
    return String(event?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  function planApproval(event) {
    if (isProgressPlan(event)) return null;
    const planId = String(event?.planId || event?.planEventRef?.planId || "").trim();
    if (!planId) return null;
    return {
      ...event,
      type: "approval_request",
      approvalId: String(event?.approvalId || `plan:${planId}`),
      kind: "plan",
      planEventRef: { planId },
      reason: String(event?.bodyMarkdown || event?.reason || "").trim(),
    };
  }

  function enqueue(sessionId, event, { fallbackSession = null, completion = false } = {}) {
    if (!shouldSurface(sessionId) || !event) return;
    const type = completion ? "completion" : String(event.type || "approval_request");
    const normalized = completion ? { type: "completion", state: event?.state || "completed" } : event;
    const id = eventKey(sessionId, normalized, type);
    if (!completion && wasResolved(sessionId, normalized, type)) return;
    if (type === "privileged_batch_request" || type === "approved_action_batch_request") {
      // The provider's generic approval can arrive in an earlier WS/HTTP
      // delta than the risk-gated batch projection. Remove that shadow item
      // before selecting the active item, so the notification never remains
      // stuck on the non-actionable provider card.
      for (const [key, item] of queue) {
        if (item.sessionId !== sessionId || item.type !== "approval_request") continue;
        if (!regularRequestIsRepresentedByBatch(item.event, [normalized])) continue;
        queue.delete(key);
        if (activeId === key) activeId = "";
      }
    }
    const previous = queue.get(id);
    const renderSignature = stableRenderSignature({ type, event: normalized });
    if (previous && previous.renderSignature === renderSignature) {
      // Keep the freshest session label for a background refresh, but do not
      // re-render the card: replacing it would restart the enter animation and
      // make a still-pending approval visibly flash.
      previous.session = sessionFor(sessionId, fallbackSession);
      return;
    }
    queue.set(id, {
      ...(previous || {}),
      id,
      sessionId,
      session: sessionFor(sessionId, fallbackSession),
      event: normalized,
      type,
      kind: completion ? "completion" : normalizeKind(normalized, type),
      title: titleFor(normalized, completion ? "completion" : normalizeKind(normalized, type), type),
      createdAt: previous?.createdAt || Date.now(),
      queueOrder: previous?.queueOrder || ++queueSequence,
      interacted: previous?.interacted === true,
      resolvedCategories: previous?.resolvedCategories || new Set(),
      renderSignature,
    });
    for (const [key, item] of queue) {
      if (item.sessionId === sessionId && item.event?.syntheticWaiting === true && !normalized.syntheticWaiting) queue.delete(key);
    }
    if (!activeId || !queue.has(activeId)) activeId = id;
    render();
  }

  function clearDismissTimer() {
    if (dismissTimer) root.clearTimeout?.(dismissTimer);
    dismissTimer = null;
    dismissItemId = "";
  }

  function scheduleDismiss(item) {
    if (!item || item.interacted || (dismissTimer && dismissItemId === item.id)) return;
    clearDismissTimer();
    dismissItemId = item.id;
    dismissTimer = root.setTimeout(() => {
      dismissTimer = null;
      dismissItemId = "";
      remove(item.id, "up");
    }, AUTO_DISMISS_MS);
    dismissTimer?.unref?.();
  }

  function setMotion(card, transform, opacity) {
    card?.style?.setProperty?.("transform", transform);
    if (opacity != null) card?.style?.setProperty?.("opacity", String(opacity));
  }

  function clearMotion(card) {
    card?.style?.removeProperty?.("transform");
    card?.style?.removeProperty?.("opacity");
  }

  function cancelGestureFrame() {
    if (gestureFrame === null) return;
    root.cancelAnimationFrame?.(gestureFrame);
    gestureFrame = null;
  }

  function cancelSnapBack() {
    if (snapBackTimer === null) return;
    root.clearTimeout?.(snapBackTimer);
    snapBackTimer = null;
  }

  function interruptMotion(card) {
    if (!card) return;
    cancelSnapBack();
    cancelGestureFrame();
    const computed = typeof root.getComputedStyle === "function" ? root.getComputedStyle(card) : null;
    if (computed?.transform && computed.transform !== "none") card.style.transform = computed.transform;
    if (computed?.opacity && computed.opacity !== "1") card.style.opacity = computed.opacity;
    card.classList.remove("oneui-notification--entering", "oneui-notification--leaving-up", "oneui-notification--leaving-right", "oneui-notification--leaving-action", "oneui-notification--snap-back");
    card.classList.add("oneui-notification--dragging");
  }

  function cardHeight(card) {
    const height = card?.getBoundingClientRect?.()?.height || card?.offsetHeight || 150;
    return Number.isFinite(height) && height > 0 ? height : 150;
  }

  function beginGesture(event, item, card) {
    if (!event || !item || !card || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (gesture) return;
    if (event.target?.closest?.("button, input, textarea, label")) return;
    const contentTarget = item.interacted && event.target?.closest?.(".oneui-notification__content");
    if (!queue.has(item.id)) {
      queue.set(item.id, item);
      activeId = item.id;
      if (transitionTimer) root.clearTimeout?.(transitionTimer);
      transitionTimer = null;
    }
    interruptMotion(card);
    const rect = card.getBoundingClientRect?.();
    gesture = {
      item,
      card,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now(),
      offsetX: 0,
      offsetY: 0,
      cardWidth: Number.isFinite(rect?.width) && rect.width > 0 ? rect.width : 520,
      cardHeight: Number.isFinite(rect?.height) && rect.height > 0 ? rect.height : 150,
      allowVertical: !contentTarget,
      moved: false,
      axis: "",
    };
    try { card.setPointerCapture?.(event.pointerId); } catch {}
  }

  function applyGestureMotion(current) {
    if (!current || gesture !== current || !current.axis) return;
    if (current.axis === "horizontal") {
      const progress = Math.min(1, Math.max(0, current.offsetX / Math.max(96, current.cardWidth * HORIZONTAL_SWIPE_THRESHOLD_RATIO)));
      setMotion(current.card, `translate3d(${current.offsetX}px, 0, 0) scale(${(1 - progress * 0.012).toFixed(4)})`, 1 - progress * 0.18);
      return;
    }
    const progress = Math.min(1, Math.max(0, -current.offsetY / Math.max(96, current.cardHeight * 0.72)));
    setMotion(current.card, `translate3d(0, ${current.offsetY}px, 0) scale(${(1 - progress * 0.035).toFixed(4)})`, 1 - progress * 0.22);
  }

  function scheduleGestureMotion() {
    if (!gesture || gestureFrame !== null) return;
    if (typeof root.requestAnimationFrame !== "function") {
      applyGestureMotion(gesture);
      return;
    }
    const current = gesture;
    gestureFrame = root.requestAnimationFrame(() => {
      gestureFrame = null;
      applyGestureMotion(current);
    });
  }

  function updateGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        gesture.axis = dx > 0 ? "horizontal" : "cancelled";
      } else if (gesture.allowVertical) {
        gesture.axis = "vertical";
      } else {
        // Detailed notification bodies remain native vertical scrollers. A
        // vertical drag there cancels the dismissal gesture without calling
        // preventDefault, while a horizontal right drag remains dismissible.
        gesture.axis = "cancelled";
      }
    }
    if (gesture.axis === "cancelled") {
      gesture.moved = true;
      if (gesture.allowVertical) event.preventDefault?.();
      return;
    }
    if (!gesture.axis) return;
    if (gesture.axis === "horizontal") {
      gesture.moved = dx > 8;
      gesture.offsetX = Math.max(0, Math.min(gesture.cardWidth, dx));
      gesture.lastX = event.clientX;
      gesture.lastTime = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
      scheduleGestureMotion();
      event.preventDefault?.();
      return;
    }
    gesture.moved = Math.abs(dy) > 8;
    gesture.offsetY = Math.max(-Math.max(220, gesture.cardHeight * 1.45), Math.min(40, dy < 0 ? dy : dy * 0.18));
    gesture.lastY = event.clientY;
    gesture.lastX = event.clientX;
    gesture.lastTime = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
    scheduleGestureMotion();
    event.preventDefault?.();
  }

  function snapBack(card) {
    if (!card) return;
    cancelSnapBack();
    cancelGestureFrame();
    card.classList.remove("oneui-notification--dragging");
    card.classList.add("oneui-notification--snap-back");
    setMotion(card, "translate3d(0, 0, 0) scale(1)", 1);
    snapBackTimer = root.setTimeout?.(() => {
      snapBackTimer = null;
      card.classList.remove("oneui-notification--snap-back");
      clearMotion(card);
    }, 320);
    snapBackTimer?.unref?.();
  }

  function finishGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    cancelGestureFrame();
    applyGestureMotion(current);
    gesture = null;
    try { current.card.releasePointerCapture?.(event.pointerId); } catch {}
    if (current.axis === "horizontal" && current.moved) {
      current.card.__oneUiSuppressClick = true;
      const now = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
      const velocity = (current.lastX - event.clientX) / Math.max(1, now - current.lastTime);
      const threshold = Math.max(88, Math.min(220, current.cardWidth * HORIZONTAL_SWIPE_THRESHOLD_RATIO));
      if (current.offsetX >= threshold || velocity > HORIZONTAL_SWIPE_VELOCITY) {
        event.preventDefault?.();
        remove(current.item.id, "right", { preserveMotion: true, offsetX: current.offsetX });
        return;
      }
      snapBack(current.card);
      event.preventDefault?.();
      return;
    }
    if (current.axis !== "vertical" || !current.moved) {
      if (current.moved) current.card.__oneUiSuppressClick = true;
      current.card.classList.remove("oneui-notification--dragging");
      clearMotion(current.card);
      return;
    }
    current.card.__oneUiSuppressClick = true;
    const now = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
    const velocity = (current.lastY - event.clientY) / Math.max(1, now - current.lastTime);
    const threshold = Math.max(64, Math.min(140, current.cardHeight * SWIPE_THRESHOLD_RATIO));
    if (current.offsetY <= -threshold || velocity > 0.45) {
      event.preventDefault?.();
      remove(current.item.id, "up", { preserveMotion: true, offsetY: current.offsetY });
      return;
    }
    snapBack(current.card);
    event.preventDefault?.();
  }

  function cancelGesture(event) {
    if (!gesture || (event.pointerId != null && event.pointerId !== gesture.pointerId)) return;
    const current = gesture;
    gesture = null;
    cancelGestureFrame();
    try { current.card.releasePointerCapture?.(current.pointerId); } catch {}
    snapBack(current.card);
  }

  function remove(id, motion = "up", { preserveMotion = false, offsetX = 0, offsetY = 0 } = {}) {
    if (!id || !queue.has(id)) return;
    queue.delete(id);
    if (activeId !== id) {
      render();
      return;
    }
    clearDismissTimer();
    cancelSnapBack();
    cancelGestureFrame();
    const card = host?.querySelector?.(".oneui-notification");
    if (!card) {
      activeId = "";
      render();
      return;
    }
    if (gesture?.item?.id === id) gesture = null;
    card.classList.remove("oneui-notification--dragging", "oneui-notification--snap-back", "oneui-notification--entering", "oneui-notification--leaving-right");
    if (preserveMotion) {
      const horizontal = motion === "right";
      const horizontalWidth = card.getBoundingClientRect?.()?.width || 520;
      const horizontalProgress = Math.min(1, Math.max(0, offsetX / Math.max(96, horizontalWidth * HORIZONTAL_SWIPE_THRESHOLD_RATIO)));
      const horizontalScale = (1 - horizontalProgress * 0.012).toFixed(4);
      setMotion(card, horizontal
        ? `translate3d(${offsetX}px, 0, 0) scale(${horizontalScale})`
        : `translate3d(0, ${offsetY}px, 0) scale(1)`, card.style.opacity || 1);
      card.classList.add(horizontal
        ? "oneui-notification--leaving-right"
        : (motion === "action" ? "oneui-notification--leaving-action" : "oneui-notification--leaving-up"));
      const animate = () => setMotion(card, horizontal
        ? "translate3d(110%, 0, 0) scale(1)"
        : "translate3d(0, -120%, 0) scale(.985)", 0);
      if (typeof root.requestAnimationFrame === "function") root.requestAnimationFrame(animate);
      else root.setTimeout?.(animate, 0);
    } else {
      clearMotion(card);
      card.classList.add(motion === "right"
        ? "oneui-notification--leaving-right"
        : (motion === "action" ? "oneui-notification--leaving-action" : "oneui-notification--leaving-up"));
    }
    transitionTimer = root.setTimeout(() => {
      transitionTimer = null;
      if (activeId === id) activeId = "";
      render();
    }, EXIT_MS);
    transitionTimer?.unref?.();
  }

  function resolveApproval(sessionId, approvalId) {
    const id = String(approvalId || "").trim();
    for (const item of queue.values()) {
      if (item.sessionId === sessionId && String(item.event?.approvalId || "") === id) {
        rememberResolved(sessionId, item.event, item.type);
        remove(item.id);
      }
    }
  }

  function resolveBatch(sessionId, event) {
    const batchId = String(event?.batchId || "").trim();
    const category = String(event?.category || "").trim().replace("privileged_", "").replace("destructive_", "");
    for (const item of queue.values()) {
      if (item.sessionId !== sessionId || String(item.event?.batchId || "") !== batchId) continue;
      item.resolvedCategories.add(category);
      const hasOther = Array.isArray(item.event?.other) && item.event.other.length;
      const hasDelete = Array.isArray(item.event?.delete) && item.event.delete.length;
      if ((!hasOther || item.resolvedCategories.has("other")) && (!hasDelete || item.resolvedCategories.has("delete"))) {
        rememberResolved(sessionId, item.event, item.type);
        remove(item.id);
      }
      else render();
    }
  }

  function resolveApprovedActionBatch(sessionId, event) {
    const batchId = String(event?.batchId || "").trim();
    if (!batchId) return;
    // Record the tombstone before walking the queue so a response that races
    // ahead of the request cannot let the subsequent replay re-open a card.
    rememberResolved(sessionId, event, "approved_action_batch_request");
    for (const item of queue.values()) {
      if (item.sessionId !== sessionId || item.type !== "approved_action_batch_request") continue;
      if (String(item.event?.batchId || "").trim() !== batchId) continue;
      rememberResolved(sessionId, item.event, item.type);
      remove(item.id, "action");
    }
  }

  function onRealtimeEvents(sessionId, events) {
    const list = Array.isArray(events) ? events : [];
    const batchEvents = list.filter((event) => event?.type === "privileged_batch_request");
    for (const event of list) {
      if (!event || !sessionId) continue;
      if (event.type === "approval_response") {
        resolveApproval(sessionId, event.approvalId);
        continue;
      }
      if (event.type === "privileged_batch_response") {
        resolveBatch(sessionId, event);
        continue;
      }
      if (event.type === "approved_action_batch_response") {
        resolveApprovedActionBatch(sessionId, event);
        continue;
      }
      if (event.type === "approved_action_state") {
        const state = String(event.state || "").trim().toLowerCase();
        if (["denied", "cancelled", "expired", "completed", "failed"].includes(state)) {
          for (const item of queue.values()) {
            if (item.sessionId === sessionId && String(item.event?.batchId || "") === String(event.batchId || "")) {
              const actions = Array.isArray(item.event?.actions) ? item.event.actions.map((action) => (
                String(action?.actionId || "") === String(event.actionId || "")
                  ? { ...action, state }
                  : action
              )) : [];
              item.event = { ...item.event, actions };
              const allTerminal = actions.length > 0 && actions.every((action) => ["denied", "cancelled", "expired", "completed", "failed"].includes(String(action?.state || "").toLowerCase()));
              if (allTerminal) {
                rememberResolved(sessionId, item.event, item.type);
                remove(item.id, "action");
              } else {
                item.renderSignature = stableRenderSignature({ type: item.type, event: item.event });
                render();
              }
            }
          }
        }
        continue;
      }
      if (isProgressPlan(event)) continue;
      if (event.type === "approval_request" && regularRequestIsRepresentedByBatch(event, batchEvents)) {
        // The server emits a provider approval record followed by its
        // privileged batch projection.  Showing both in one WS payload makes
        // the card replace itself in the same frame; only the batch is user
        // actionable, so suppress the redundant regular card.
        continue;
      }
      if (event.type === "privileged_batch_request"
        || event.type === "approved_action_batch_request"
        || event.type === "approval_request") {
        enqueue(sessionId, event);
        continue;
      }
      if (event.type === "plan" && String(event.state || "").trim().toLowerCase() === "awaiting_decision") {
        const approval = planApproval(event);
        if (approval) enqueue(sessionId, approval);
      }
      if (event.type === "plan" && ["executing", "revising", "completed", "cancelled"].includes(String(event.state || "").trim().toLowerCase())) {
        const planId = String(event.planId || event.planEventRef?.planId || "");
        for (const item of queue.values()) {
          if (item.sessionId === sessionId && String(item.event?.planEventRef?.planId || "") === planId) {
            rememberResolved(sessionId, item.event, item.type);
            remove(item.id);
          }
        }
      }
    }
  }

  function activityState(session) {
    return String(session?.activity?.run?.state || session?.run?.state || "").trim().toLowerCase();
  }

  function workflowState(session) {
    return String(session?.workflowState || session?.workState?.workflow?.state || "").trim().toLowerCase();
  }

  function hasUnread(session) {
    if (typeof root.AgentoCSessionStateModel?.hasSessionUnreadUpdate === "function") return root.AgentoCSessionStateModel.hasSessionUnreadUpdate(session);
    return Boolean(session?.unread || session?.unreadAt || session?.lastEventAt);
  }

  function onSessionsApplied(previousMap, sessions) {
    for (const next of Array.isArray(sessions) ? sessions : []) {
      if (!next?.id) continue;
      const previous = previousMap?.get?.(next.id) || null;
      const before = activityState(previous);
      const after = activityState(next);
      if (before === "running" && after && after !== "running" && hasUnread(next) && workflowState(next) !== "waiting_user") {
        enqueue(next.id, {
          type: "completion",
          state: after,
          runId: String(next?.activity?.run?.runId || next?.activity?.run?.id || next?.lastEventAt || ""),
        }, { fallbackSession: next, completion: true });
      }
    }
  }

  function collapseSidebar() {
    const overlay = doc.getElementById?.("sidebarOverlay");
    const close = doc.getElementById?.("closeSidebar");
    if (!close?.click) return;
    const desktop = root.matchMedia?.("(min-width: 768px)")?.matches === true;
    const open = desktop ? !doc.body?.classList?.contains?.("sessions-sidebar-collapsed") : overlay?.classList?.contains?.("open") === true;
    if (open) close.click();
  }

  function openSession(item) {
    if (!item?.sessionId) return;
    root.applyNavigationState?.({ sessionId: item.sessionId, tab: "sessions" });
    root.queueForegroundRefresh?.({ forceFresh: true, viewportIntent: "session_entry_bottom" })?.catch?.(() => {});
    remove(item.id, "action");
  }

  function appendDetail(parent, label, value, code = false) {
    const text = String(value || "").trim();
    if (!text) return;
    const row = el("div", "oneui-notification__detail");
    row.appendChild(el("div", "oneui-notification__detail-label", label));
    row.appendChild(el(code ? "pre" : "div", code ? "oneui-notification__code" : "oneui-notification__detail-value", text));
    parent.appendChild(row);
  }

  function questionGroups(event) {
    return (Array.isArray(event?.questions) ? event.questions : [{ question: event?.question, options: event?.options || event?.choices }])
      .filter(Boolean);
  }

  function questionOptionLabel(option) {
    return option?.label || option?.title || option?.text || option;
  }

  function questionOptions(group) {
    const options = Array.isArray(group?.options || group?.choices) ? (group.options || group.choices) : [];
    return Array.isArray(options) ? options : [];
  }

  // Collapsed ask-user cards disclose through their first option: the row shows
  // that option plus a right-facing chevron, expands to the full option list,
  // and turns the chevron down as a collapse affordance. The row never answers;
  // only an explicit option tap or typed reply does.
  function appendQuestionDisclosure(parent, item, card) {
    const first = questionOptions(questionGroups(item.event || {})[0])[0];
    if (first == null) return;
    const detailed = card.classList.contains("oneui-notification--detailed");
    const row = el("button", "oneui-notification__optrow");
    row.type = "button";
    row.setAttribute("aria-expanded", String(detailed));
    row.setAttribute("aria-label", tr(detailed ? "attention.question.optrow.collapse" : "attention.question.optrow.expand"));
    const label = el("span", "oneui-notification__optrow-label", questionOptionLabel(first));
    label.setAttribute("dir", "auto");
    const chevron = el("span", "oneui-notification__disclosure");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = root.AgentoCIcons?.render?.("chevron-right", {
      className: "oneui-notification__disclosure-icon",
    }) || "";
    row.append(label, chevron);
    row.addEventListener("click", () => {
      const expanded = !card.classList.contains("oneui-notification--detailed");
      card.classList.toggle("oneui-notification--detailed", expanded);
      card.dataset.state = expanded ? "detailed" : "brief";
      card.setAttribute("aria-expanded", String(expanded));
      row.setAttribute("aria-expanded", String(expanded));
      row.setAttribute("aria-label", tr(expanded ? "attention.question.optrow.collapse" : "attention.question.optrow.expand"));
      if (expanded) {
        item.interacted = true;
        clearDismissTimer();
      }
    });
    parent.appendChild(row);
  }

  // The full option list. Tapping an option is the approval: it submits that
  // choice for its question immediately (other questions stay unanswered).
  function appendQuestionDetails(parent, item) {
    const groups = questionGroups(item.event || {});
    const wrap = el("div", "oneui-notification__choices");
    groups.forEach((group, questionIndex) => {
      if (groups.length > 1 && (group?.question || group?.prompt)) {
        wrap.appendChild(el("div", "oneui-notification__choice-question", group.question || group.prompt));
      }
      questionOptions(group).forEach((option, optionIndex) => {
        const label = questionOptionLabel(option);
        const button = el("button", "oneui-notification__choice", label);
        button.type = "button";
        button.setAttribute("aria-label", tr("attention.question.answerWith", { label: String(label ?? "") }));
        button.addEventListener("click", () => {
          if (button.disabled) return;
          const choices = groups.map((_, index) => (index === questionIndex ? optionIndex : -1));
          void submit(item, "approve", button, { choices, customAnswer: "" });
        });
        wrap.appendChild(button);
      });
    });
    if (wrap.children.length) parent.appendChild(wrap);
  }

  // The footer answer rail replaces the old approve/submit pair: the typed
  // reply fills the rail and Enter (desktop) or the IME send action (mobile)
  // submits it, while deny stays as a compact quiet button on the right.
  function buildAnswerForm(item) {
    const form = el("form", "oneui-notification__answer");
    const input = doc.createElement("input");
    input.type = "text";
    input.className = "oneui-notification__answer-input";
    input.maxLength = 8000;
    input.enterKeyHint = "send";
    input.autocomplete = "off";
    input.placeholder = tr("approval.customAnswer.placeholder");
    input.setAttribute("aria-label", tr("approval.customAnswer.label"));
    input.setAttribute("dir", "auto");
    // Typing means the user is mid-answer; the auto-dismiss clock must not
    // remove the card underneath them.
    input.addEventListener("focus", () => {
      item.interacted = true;
      clearDismissTimer();
    });
    const deny = el("button", "oneui-notification__action oneui-notification__answer-deny", tr("attention.action.deny"));
    deny.type = "button";
    deny.addEventListener("click", () => {
      if (!deny.disabled) void submit(item, "deny", deny);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = String(input.value || "").trim().slice(0, 8000);
      // An empty send must never become a no-answer approval.
      if (!text || input.disabled) return;
      void submit(item, "approve", deny, { choices: [], customAnswer: text });
    });
    form.append(input, deny);
    return form;
  }

  function appendBatchDetails(parent, item, footerActions = null) {
    const event = item.event || {};
    const unavailable = event.executorUnavailableReasonCode === "macos_administrator_unavailable";
    if (unavailable) {
      const zh = String(root.agentocGetActiveUiLanguage?.() || "").toLowerCase().startsWith("zh");
      parent.appendChild(el("p", "oneui-notification__batch-unavailable", zh
        ? "此 Mac 暂不支持托管管理员执行，无法批准执行；你可以拒绝该请求。"
        : "Managed administrator execution is not available on this Mac. You can decline this request."));
    }
    const categories = [];
    const defaultSelected = event.defaultSelected && typeof event.defaultSelected === "object"
      ? event.defaultSelected
      : {};
    const defaultsFor = (category) => {
      const keys = category === "other"
        ? ["other", "privileged_other"]
        : ["delete", "destructive_delete"];
      for (const key of keys) {
        if (Array.isArray(defaultSelected[key])) return defaultSelected[key].map((id) => String(id));
      }
      return category === "other"
        ? (Array.isArray(event[category]) ? event[category].map((operation) => String(operation?.opId || "")) : [])
        : [];
    };
    for (const category of ["other", "delete"]) {
      const operations = Array.isArray(event[category]) ? event[category] : [];
      if (!operations.length) continue;
      categories.push(category);
      const section = el("section", "oneui-notification__batch");
      section.dataset.category = category;
      section.appendChild(el("div", "oneui-notification__batch-title", category === "delete" ? tr("attention.danger.delete") : tr("attention.danger.privileged")));
      for (const operation of operations) {
        const label = el("label", "oneui-notification__operation");
        const check = doc.createElement("input");
        check.type = "checkbox";
        check.checked = defaultsFor(category).includes(String(operation?.opId || ""));
        check.disabled = unavailable;
        check.value = String(operation?.opId || "");
        check.dataset.category = category;
        check.addEventListener("change", () => syncBatchNotificationState(section));
        label.appendChild(check);
        const explained = typeof root.agentocApprovalExplanation === "function"
          ? root.agentocApprovalExplanation(operation?.explanation, tr) : operation?.explanation;
        label.appendChild(el("span", "oneui-notification__code", (explained?.operation && explained?.summary) || operation?.description || operation?.command || ""));
        section.appendChild(label);
        if (operation?.description && operation.description !== explained?.summary) appendDetail(section, tr("decisionSheet.providerDescription"), operation.description);
        if (explained?.reason) appendDetail(section, tr("decisionSheet.explanation.reason"), explained.reason);
        if (operation?.command) appendDetail(section, tr("attention.detail.command"), operation.command, true);
      }
      // A danger batch carries separate decisions for each category. Keep the
      // pair with the operations it governs instead of flattening multiple
      // identical "approve / deny" pairs into one ambiguous footer rail.
      if (!item.resolvedCategories.has(category)) {
        const actions = el("div", "oneui-notification__actions oneui-notification__batch-actions");
        if (!unavailable) addAction(actions, tr("attention.action.approve"), item, "batch-approve", "oneui-notification__action--primary", category);
        addAction(actions, tr("attention.action.deny"), item, "batch-deny", "oneui-notification__action--quiet", category);
        if (footerActions) {
          const group = el("div", "oneui-notification__batch-footer-group");
          group.dataset.category = category;
          group.appendChild(el("div", "oneui-notification__batch-footer-label", category === "delete" ? tr("attention.danger.delete") : tr("attention.danger.privileged")));
          group.appendChild(actions);
          footerActions.appendChild(group);
        } else {
          section.appendChild(actions);
        }
        syncBatchNotificationState(section);
      }
      parent.appendChild(section);
    }
    return categories;
  }

  function syncBatchNotificationState(section) {
    const category = String(section?.dataset?.category || "");
    const approve = section?.querySelector?.('.oneui-notification__action[data-action="batch-approve"]');
    if (!approve) return;
    const checked = section.querySelectorAll?.(`input[data-category="${category}"]:checked`) || [];
    approve.disabled = checked.length === 0;
  }

  function syncApprovedActionNotificationState(card) {
    const approve = card?.querySelector?.('button[data-approved-action-approve="true"]');
    if (!approve) return;
    approve.disabled = !Array.from(card.querySelectorAll("input[data-approved-action-id]:checked"))
      .some((input) => !input.disabled && String(input.value || "").trim());
  }

  function appendApprovedActionDetails(parent, item) {
    const actions = Array.isArray(item.event?.actions) ? item.event.actions : [];
    if (!actions.length) return;
    const section = el("section", "oneui-notification__batch");
    section.appendChild(el("div", "oneui-notification__batch-title", tr("attention.danger.privileged")));
    for (const action of actions) {
      const label = el("label", "oneui-notification__operation");
      const check = doc.createElement("input");
      check.type = "checkbox";
      check.checked = ["proposed", "classified", "waiting_user"].includes(String(action?.state || "waiting_user"));
      check.value = String(action?.actionId || "");
      check.dataset.approvedActionId = check.value;
      check.addEventListener("change", () => syncApprovedActionNotificationState(check.closest(".oneui-notification")));
      const explained = typeof root.agentocApprovalExplanation === "function"
        ? root.agentocApprovalExplanation(action?.explanation, tr) : action?.explanation;
      label.append(check, el("span", "oneui-notification__code", (explained?.operation && explained?.summary) || action?.description || action?.summary || action?.command || ""));
      section.appendChild(label);
      if (action?.description && action.description !== explained?.summary) appendDetail(section, tr("decisionSheet.providerDescription"), action.description);
      if (explained?.reason) appendDetail(section, tr("decisionSheet.explanation.reason"), explained.reason);
      if (action?.command) appendDetail(section, tr("attention.detail.command"), action.command, true);
    }
    parent.appendChild(section);
  }

  function appendDetails(parent, item, footerActions = null) {
    if (item.type === "completion") {
      // Completion already states the outcome in its title and identifies the
      // source session immediately below it. Repeating a generic "new result"
      // sentence here adds no decision value and makes the compact popup noisy.
      return [];
    }
    const event = item.event || {};
    const details = el("div", "oneui-notification__details");
    const reason = String(event.reason || event.bodyMarkdown || event.description || "").trim();
    const explained = typeof root.agentocApprovalExplanation === "function"
      ? root.agentocApprovalExplanation(event.explanation, tr) : event.explanation;
    if (item.kind === "plan") appendDetail(details, tr("attention.detail.proposed"), reason);
    else {
      if (explained?.operation && explained.summary && explained.summary !== item.title) appendDetail(details, tr("decisionSheet.explanation.summary"), explained.summary);
      if (explained?.reason) appendDetail(details, tr("decisionSheet.explanation.reason"), explained.reason);
      if (explained?.saferAlternative) appendDetail(details, tr("decisionSheet.explanation.safer"), explained.saferAlternative);
      if (reason && reason !== item.title) appendDetail(details, tr("decisionSheet.providerDescription"), reason);
    }
    appendDetail(details, tr("attention.detail.command"), event.command, true);
    appendDetail(details, tr("attention.detail.cwd"), event.cwd || event.grantRoot);
    const permissions = typeof root.describeApprovalPermissions === "function" ? root.describeApprovalPermissions(event.permissions) : "";
    appendDetail(details, tr("attention.detail.permissions"), permissions);
    const categories = item.type === "privileged_batch_request" ? appendBatchDetails(details, item, footerActions) : [];
    if (item.type === "approved_action_batch_request") appendApprovedActionDetails(details, item);
    if (item.kind === "question") appendQuestionDetails(details, item);
    if (details.children.length) parent.appendChild(details);
    return categories;
  }

  async function submit(item, decision, button, { category = "", choices = null, customAnswer = "" } = {}) {
    const card = button?.closest?.(".oneui-notification");
    card?.querySelectorAll("button").forEach((node) => { node.disabled = true; });
    card?.querySelectorAll("input, textarea").forEach((node) => { node.disabled = true; });
    button?.setAttribute("aria-busy", "true");
    let ok = false;
    let alreadyEnded = false;
    try {
      const event = item.event || {};
      if (item.type === "privileged_batch_request") {
        const ids = Array.from(card?.querySelectorAll(`input[data-category="${category}"]:checked`) || []).map((node) => node.value).filter(Boolean);
        const result = await root.AgentoCDecisionSheet?.submitPrivilegedBatchCategory?.(event, category, decision, ids);
        ok = result === true || result?.ok === true;
        alreadyEnded = result?.alreadyEnded === true;
      } else if (item.type === "approved_action_batch_request") {
        const ids = decision === "deny"
          ? []
          : Array.from(card?.querySelectorAll("input[data-approved-action-id]:checked") || []).map((node) => node.value).filter(Boolean);
        ok = typeof root.AgentoCDecisionSheet?.submitApprovedActionDecision === "function"
          && await root.AgentoCDecisionSheet.submitApprovedActionDecision(event, button, decision === "deny" ? "deny" : "approve", ids);
      } else if (item.kind === "plan") {
        const planId = String(event?.planEventRef?.planId || event?.planId || "");
        ok = typeof root.dispatchAction === "function" && await root.dispatchAction({ action: "plan_action", sessionId: item.sessionId, planId, planAction: "execute", requestId: `oneui-${Date.now()}` });
      } else if (typeof root.dispatchAction === "function") {
        const confirmation = typeof root.isSessionConfirmationApproval === "function" && root.isSessionConfirmationApproval(event);
        ok = await root.dispatchAction(confirmation
          ? { action: "session_confirmation", sessionId: item.sessionId, approvalId: event.approvalId, decision }
          : { action: "runtime_approval", runId: String(event.runId || ""), approvalId: event.approvalId, decision, ...(item.kind === "question" ? { choices: choices || [], customAnswer } : {}) });
      }
    } catch (error) {
      root.showSystemToast?.(tr("attention.submitFailed", { message: error?.message || "" }), "error");
    }
    if (ok) {
      if (item.type === "privileged_batch_request") {
        // Batch groups settle independently. Preserve the disclosed card until
        // every group has a response, rather than making a successful first
        // decision hide the remaining group.
        if (alreadyEnded) {
          // A stale background card can receive a 404/terminal response after
          // the whole run was already closed. There is no meaningful category
          // left to preserve in that case: remove the complete card and leave
          // a tombstone in the decision store to block replay resurrection.
          remove(item.id, "action");
        } else {
          item.resolvedCategories.add(category);
          const hasOther = Array.isArray(item.event?.other) && item.event.other.length;
          const hasDelete = Array.isArray(item.event?.delete) && item.event.delete.length;
          if ((!hasOther || item.resolvedCategories.has("other")) && (!hasDelete || item.resolvedCategories.has("delete"))) {
            remove(item.id, "action");
          } else {
            render();
          }
        }
      } else {
        remove(item.id, "action");
      }
      root.refreshSidebarSession?.(item.sessionId, { forceFresh: true })?.catch?.(() => {});
      return;
    }
    card?.querySelectorAll("button").forEach((node) => {
      node.disabled = node.dataset.action === "batch-approve"
        ? (card.querySelectorAll?.(`input[data-category="${node.dataset.category}"]:checked`) || []).length === 0
        : false;
    });
    card?.querySelectorAll("input, textarea").forEach((node) => { node.disabled = false; });
    button?.removeAttribute("aria-busy");
  }

  function addAction(parent, label, item, decision, className = "", category = "") {
    const button = el("button", `oneui-notification__action ${className}`.trim(), label);
    button.type = "button";
    button.dataset.action = decision;
    if (category) button.dataset.category = category;
    const submittedDecision = decision === "batch-approve" ? "approve" : decision === "batch-deny" ? "deny" : decision;
    button.addEventListener("click", () => {
      if (decision === "open") openSession(item);
      else void submit(item, submittedDecision, button, { category });
    });
    parent.appendChild(button);
    return button;
  }

  function render() {
    if (!host || transitionTimer) return;
    const ordered = Array.from(queue.values()).sort((left, right) => left.queueOrder - right.queueOrder);
    const item = queue.get(activeId) || ordered[0];
    if (!item) {
      clearDismissTimer();
      host.replaceChildren();
      host.hidden = true;
      activeId = "";
      restoreReturnFocus();
      return;
    }
    if (host.hidden) rememberReturnFocus();
    activeId = item.id;
    const renderKey = `${item.id}:${item.renderSignature || ""}:${item.interacted ? "detailed" : "brief"}:${Array.from(item.resolvedCategories || []).sort().join(",")}`;
    if (!host.hidden && host.dataset.renderKey === renderKey && host.querySelector?.(".oneui-notification")) {
      scheduleDismiss(item);
      return;
    }
    host.hidden = false;
    host.setAttribute("aria-live", item.type === "completion" ? "polite" : "assertive");
    const isCompletion = item.type === "completion";
    const card = el("section", `oneui-notification oneui-notification--${item.kind}${item.interacted ? " oneui-notification--detailed" : ""}`);
    card.dataset.kind = item.kind;
    card.dataset.state = item.interacted ? "detailed" : "brief";
    card.setAttribute("role", isCompletion ? "status" : "dialog");
    card.setAttribute("aria-labelledby", "attentionPopupTitle");
    if (!isCompletion) {
      card.setAttribute("aria-describedby", "attentionPopupContent");
      card.setAttribute("aria-expanded", String(item.interacted));
    }
    // A completion card is a status plus one explicit navigation action. It
    // must not add an inert card stop to the keyboard order or imply that its
    // empty body can be expanded.
    card.tabIndex = isCompletion ? -1 : 0;
    const expand = () => {
      item.interacted = true;
      clearDismissTimer();
      card.classList.add("oneui-notification--detailed");
      card.dataset.state = "detailed";
      card.setAttribute("aria-expanded", "true");
      if (isCompletion) collapseSidebar();
    };
    card.addEventListener("pointerdown", (event) => { if (item.type === "completion") collapseSidebar(); beginGesture(event, item, card); });
    card.addEventListener("pointermove", updateGesture);
    card.addEventListener("pointerup", finishGesture);
    card.addEventListener("pointercancel", cancelGesture);
    card.addEventListener("keydown", (event) => {
      if (isCompletion || event.target !== card || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      expand();
    });
    card.addEventListener("click", (event) => {
      if (isCompletion || event.target?.closest?.("button, input, textarea, label")) return;
      if (card.__oneUiSuppressClick) {
        card.__oneUiSuppressClick = false;
        return;
      }
      expand();
    });

    const header = el("header", "oneui-notification__header");
    const summary = el("div", "oneui-notification__summary");
    const title = el("div", "oneui-notification__title", item.title);
    title.id = "attentionPopupTitle";
    summary.appendChild(title);
    if (!isCompletion && item.kind !== "question") {
      // Ask-user cards disclose through their option row instead; its chevron
      // belongs beside the first option, not in the title.
      const disclosure = el("span", "oneui-notification__disclosure");
      disclosure.setAttribute("aria-hidden", "true");
      disclosure.innerHTML = root.AgentoCIcons?.render?.("chevron-right", {
        className: "oneui-notification__disclosure-icon",
      }) || "";
      summary.appendChild(disclosure);
    }
    const close = el("button", "oneui-notification__close");
    close.type = "button";
    close.setAttribute("aria-label", tr("attention.action.dismiss"));
    close.title = tr("attention.action.dismiss");
    close.innerHTML = root.AgentoCIcons?.render?.("close", {
      className: "oneui-notification__close-icon",
    }) || "";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      remove(item.id, "up");
    });
    summary.appendChild(close);
    header.appendChild(summary);
    if (item.type === "approval_request" && item.kind !== "question" && !(typeof root.agentocApprovalExplanation === "function" && root.agentocApprovalExplanation(item.event?.explanation, tr)?.operation) && item.event?.reason && meaningfulText(item.event.reason)) {
      header.appendChild(el("div", "oneui-notification__detail-label", tr("decisionSheet.providerDescription")));
    }
    const sessionName = compactText(item.session?.name || item.session?.title, 72);
    if (sessionName) {
      const session = el("div", "oneui-notification__session");
      session.appendChild(el("span", "oneui-notification__session-label", tr("attention.session")));
      const sessionValue = el("span", "oneui-notification__session-value", sessionName);
      sessionValue.setAttribute("dir", "auto");
      session.appendChild(sessionValue);
      header.appendChild(session);
    }
    if (item.event?.syntheticWaiting === true) {
      const brief = el("p", "oneui-notification__brief", tr("attention.waiting.body"));
      brief.setAttribute("dir", "auto");
      header.appendChild(brief);
    }
    const content = el("div", "oneui-notification__content");
    content.id = "attentionPopupContent";
    const batchFooterActions = el("div", "oneui-notification__batch-footer-actions");
    if (item.kind === "question") appendQuestionDisclosure(content, item, card);
    appendDetails(content, item, batchFooterActions);
    const footer = el("footer", "oneui-notification__footer");
    const actions = el("div", "oneui-notification__actions");
    const synthetic = item.event?.syntheticWaiting === true;
    if (item.type === "completion" || synthetic) {
      addAction(actions, tr("attention.action.detail"), item, "open", "oneui-notification__action--secondary");
    } else if (item.type === "privileged_batch_request") {
      // Category-specific decisions are already in the fixed footer rail;
      // only the operation list remains inside the expandable content area.
    } else if (item.type === "approved_action_batch_request") {
      const approve = addAction(actions, tr("attention.action.approve"), item, "approve", "oneui-notification__action--primary");
      approve.dataset.approvedActionApprove = "true";
      addAction(actions, tr("attention.action.deny"), item, "deny", "oneui-notification__action--quiet");
    } else if (item.kind === "plan") {
      addAction(actions, tr("attention.action.execute"), item, "approve", "oneui-notification__action--primary");
    } else if (item.kind === "question") {
      // Options answer directly and the answer rail owns the footer, so the
      // generic approve/submit pair has no place on an ask-user card.
      footer.appendChild(buildAnswerForm(item));
    } else {
      addAction(actions, tr("attention.action.approve"), item, "approve", "oneui-notification__action--primary");
      addAction(actions, tr("attention.action.deny"), item, "deny", "oneui-notification__action--quiet");
    }
    // Every actionable notification keeps an explicit route to the source
    // session. The notification is a complete decision surface, while this
    // affordance remains available for context and audit review.
    if (!isCompletion && !synthetic) {
      addAction(actions, tr("attention.action.detail"), item, "open", "oneui-notification__action--secondary");
    }
    if (batchFooterActions.children.length) footer.appendChild(batchFooterActions);
    if (actions.children.length) footer.appendChild(actions);
    card.append(header, content);
    if (footer.children.length) card.appendChild(footer);
    card.classList.add("oneui-notification--entering");
    host.replaceChildren(card);
    if (item.type === "approved_action_batch_request") syncApprovedActionNotificationState(card);
    host.dataset.renderKey = renderKey;
    const settle = () => { if (queue.get(activeId) === item && host.contains?.(card)) card.classList.remove("oneui-notification--entering"); };
    if (typeof root.requestAnimationFrame === "function") root.requestAnimationFrame(settle);
    else root.setTimeout?.(settle, 0);
    scheduleDismiss(item);
  }

  function ensureHost() {
    if (host && doc.body.contains(host)) return host;
    host = doc.createElement("div");
    host.id = "attentionPopupHost";
    host.hidden = true;
    // Approval requests need immediate announcement; a completed background
    // run is informative and should not interrupt the user's current task.
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-atomic", "true");
    doc.body.appendChild(host);
    if (!keydownBound) {
      keydownBound = true;
      doc.addEventListener?.("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !host || host.hidden) return;
        event.preventDefault();
        const item = queue.get(activeId);
        if (item) remove(item.id, "up");
      });
    }
    doc.addEventListener?.("pointerdown", (event) => {
      const item = queue.get(activeId);
      if (!item?.interacted || !host || host.contains?.(event.target)) return;
      remove(item.id, "up");
    });
    return host;
  }

  ensureHost();
  root.AgentoCAttentionPopup = Object.freeze({
    onRealtimeEvents,
    onSessionsApplied,
    _reset() {
      queue.clear();
      resolvedKeys.clear();
      activeId = "";
      if (host) delete host.dataset.renderKey;
      clearDismissTimer();
      if (transitionTimer) root.clearTimeout?.(transitionTimer);
      transitionTimer = null;
      gesture = null;
      cancelGestureFrame();
      cancelSnapBack();
      render();
    },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
