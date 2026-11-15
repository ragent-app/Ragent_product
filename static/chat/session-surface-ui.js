function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function getShortFolder(folder) {
  return (folder || "").replace(/^\/Users\/[^/]+/, "~");
}

function getFolderLabel(folder) {
  const shortFolder = getShortFolder(folder);
  return shortFolder.split("/").pop() || shortFolder || t("session.defaultName");
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || t("session.defaultName");
}

const sessionTodayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const sessionOlderDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function getSessionUpdatedStamp(session) {
  return Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt")
    ? (session?.lastActivityAt ?? session?.updatedAt ?? "")
    : (session?.lastEventAt || session?.updatedAt || "");
}

function formatSessionUpdatedTime(session) {
  const stamp = getSessionUpdatedStamp(session);
  const parsed = new Date(stamp);
  if (!stamp || !Number.isFinite(parsed.getTime())) return "";

  const now = new Date();
  const isToday = parsed.getFullYear() === now.getFullYear()
    && parsed.getMonth() === now.getMonth()
    && parsed.getDate() === now.getDate();
  return isToday
    ? sessionTodayTimeFormatter.format(parsed)
    : sessionOlderDateFormatter.format(parsed);
}

function formatQueuedMessageTimestamp(stamp) {
  if (!stamp) return t("queue.timestamp.default");
  const parsed = new Date(stamp).getTime();
  if (!Number.isFinite(parsed)) return t("queue.timestamp.default");
  return t("queue.timestamp.withTime", { time: messageTimeFormatter.format(parsed) });
}

function getQueuedMessageText(item) {
  const text = typeof item?.text === "string" ? item.text.trim() : "";
  return text || t("queue.attachmentOnly");
}

function getQueuedMessageRequestId(item) {
  return typeof item?.requestId === "string" ? item.requestId.trim() : "";
}

function getQueuedMessageAttachments(item) {
  return Array.isArray(item?.attachments) && item.attachments.length > 0
    ? item.attachments
    : (Array.isArray(item?.images) ? item.images : []);
}

function getQueuedMessageIndex(items, item) {
  const requestId = getQueuedMessageRequestId(item);
  if (requestId) {
    return items.findIndex((entry) => getQueuedMessageRequestId(entry) === requestId);
  }
  return items.indexOf(item);
}

function getQueuedMessageRemovalRequestIds(session, item, { clear = false, truncateFrom = false } = {}) {
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  if (clear) {
    return items.map(getQueuedMessageRequestId).filter(Boolean);
  }
  if (truncateFrom) {
    const itemIndex = getQueuedMessageIndex(items, item);
    return itemIndex >= 0
      ? items.slice(itemIndex).map(getQueuedMessageRequestId).filter(Boolean)
      : [];
  }
  const requestId = getQueuedMessageRequestId(item);
  return requestId ? [requestId] : [];
}

function clearQueuedMessagePendingFeedback(session, item, { clear = false, truncateFrom = false } = {}) {
  const requestIds = getQueuedMessageRemovalRequestIds(session, item, { clear, truncateFrom });
  if (requestIds.length === 0) return false;

  const pendingSend = typeof getComposerPendingSendState === "function"
    ? getComposerPendingSendState()
    : (typeof getComposerPendingSendSnapshot === "function" ? getComposerPendingSendSnapshot() : null);
  const sessionId = session?.id || (typeof currentSessionId === "string" ? currentSessionId : "");
  if (!(pendingSend?.requestId && pendingSend?.sessionId === sessionId)) {
    return false;
  }
  if (!requestIds.includes(pendingSend.requestId)) {
    return false;
  }

  if (typeof clearComposerPendingSendState === "function") {
    clearComposerPendingSendState(pendingSend.requestId);
  }
  if (typeof syncComposerPendingUi === "function") {
    syncComposerPendingUi();
  } else if (typeof syncComposerPendingTurnFeedback === "function") {
    syncComposerPendingTurnFeedback();
  }
  return true;
}

function getSessionQueuedToolId(session) {
  const sessionTool = typeof session?.tool === "string" ? session.tool.trim().toLowerCase() : "";
  if (sessionTool) return sessionTool;
  return typeof selectedTool === "string" ? selectedTool.trim().toLowerCase() : "";
}

function getSessionQueuedRuntimeFamily(session) {
  const runtimeFamily = session?.activity?.run?.runtimeFamily || session?.runtimeFamily || "";
  return typeof runtimeFamily === "string" ? runtimeFamily.trim() : "";
}

function getSessionQueuedCapabilities(session) {
  const capabilities = session?.activity?.run?.providerCapabilities || session?.providerCapabilities || null;
  return capabilities && typeof capabilities === "object" ? capabilities : null;
}

function shouldRenderQueuedSteerActions(session) {
  const tool = getSessionQueuedToolId(session);
  const capabilities = getSessionQueuedCapabilities(session);
  // Queue editing is an Ragent control-plane operation and does not require
  // a provider stdin/control channel. AgY explicitly advertises this split:
  // delete/edit/clear are available while steer remains hidden.
  if (capabilities?.supportsQueuedMessageMutations === true || tool === "agy") return true;
  if (capabilities) return capabilities.supportsSteer === true;
  return getSessionQueuedRuntimeFamily(session) === "codex-app-server-json";
}

function shouldAllowQueuedSteer(session) {
  const capabilities = getSessionQueuedCapabilities(session);
  if (capabilities) return capabilities.supportsSteer === true;
  return getSessionQueuedRuntimeFamily(session) === "codex-app-server-json";
}

function cloneSessionWithQueuedMessages(session, queuedMessages) {
  const next = {
    ...session,
    activity: {
      ...(session?.activity || {}),
      queue: {
        ...(session?.activity?.queue || {}),
        state: queuedMessages.length > 0 ? "queued" : "idle",
        count: queuedMessages.length,
      },
    },
  };
  if (queuedMessages.length > 0) {
    next.queuedMessages = queuedMessages;
  } else {
    delete next.queuedMessages;
  }
  return next;
}

function upsertQueuedSessionSnapshot(session) {
  if (!session?.id) return;
  if (typeof upsertSession === "function") {
    upsertSession(session);
  } else if (typeof upsertChatSessionState === "function") {
    upsertChatSessionState(session, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  }
  if (typeof updateStatus === "function") {
    updateStatus("connected", session);
  }
}

function closeQueuedSteerMenu() {
  if (queuedSteerMenuBackEntryId) {
    window.RagentBackHandler?.pop?.(queuedSteerMenuBackEntryId);
    queuedSteerMenuBackEntryId = null;
  }
  const menus = typeof document.querySelectorAll === "function"
    ? document.querySelectorAll(".queued-steer-menu")
    : [];
  menus.forEach((menu) => menu.remove());
  if (!queuedPanel) return;
  const expandedButtons = typeof queuedPanel.querySelectorAll === "function"
    ? queuedPanel.querySelectorAll(".queued-steer-action--more[aria-expanded=\"true\"]")
    : [];
  expandedButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
}

function setQueuedSteerRowBusy(row, busy) {
  if (!row) return;
  row.classList.toggle("is-updating", busy === true);
  row.setAttribute("aria-busy", busy === true ? "true" : "false");
}

function setQueuedMessageIntoComposer(item) {
  if (!msgInput) return false;
  const text = typeof item?.text === "string" ? item.text : "";
  msgInput.value = text;
  if (typeof writeStoredDraft === "function") {
    writeStoredDraft(currentSessionId, text);
  }
  const attachments = getQueuedMessageAttachments(item)
    .map((attachment) => ({
      ...attachment,
      uploadState: attachment?.uploadState || "ready",
    }));
  if (attachments.length > 0 && typeof replaceComposerAttachmentsSnapshot === "function") {
    replaceComposerAttachmentsSnapshot(currentSessionId, attachments);
  }
  if (typeof autoResizeInput === "function") {
    autoResizeInput();
  }
  try {
    msgInput.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    // Best-effort draft sync for very small DOM test shims.
  }
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: false });
  } else if (typeof msgInput.focus === "function") {
    msgInput.focus();
  }
  if (typeof msgInput.setSelectionRange === "function") {
    const cursor = msgInput.value.length;
    msgInput.setSelectionRange(cursor, cursor);
  }
  return true;
}

function renderQueuedMessageOptimistically(session, item, { clear = false, truncateFrom = false } = {}) {
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  const itemIndex = getQueuedMessageIndex(items, item);
  if (!clear && itemIndex < 0) {
    return session;
  }
  const nextItems = clear
    ? []
    : (truncateFrom ? items.slice(0, Math.max(0, itemIndex)) : items.filter((_, index) => index !== itemIndex));
  const nextSession = cloneSessionWithQueuedMessages(session, nextItems);
  upsertQueuedSessionSnapshot(nextSession);
  renderQueuedMessagePanel(nextSession);
  return nextSession;
}

async function updateQueuedMessageOnServer(session, item, { clear = false, truncateFrom = false } = {}) {
  const sessionId = session?.id || currentSessionId;
  if (!sessionId || typeof fetchJsonOrRedirect !== "function") return null;
  const requestId = getQueuedMessageRequestId(item);
  if (!clear && !requestId) return null;
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clear
      ? { action: "clear" }
      : { action: truncateFrom ? "truncate_from" : "delete", requestId }),
    revalidate: false,
  });
  if (data?.session) {
    upsertQueuedSessionSnapshot(data.session);
    renderQueuedMessagePanel(data.session);
  }
  return data?.session || null;
}

async function steerQueuedMessageOnServer(session, item, { row = null } = {}) {
  const sessionId = session?.id || currentSessionId;
  const requestId = getQueuedMessageRequestId(item);
  if (!sessionId || !requestId || typeof fetchJsonOrRedirect !== "function") return null;
  setQueuedSteerRowBusy(row, true);
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "steer", requestId }),
      revalidate: false,
    });
    if (data?.session) {
      if (data.steered === true || data.queued !== true) {
        clearQueuedMessagePendingFeedback(session, item);
      }
      upsertQueuedSessionSnapshot(data.session);
      renderQueuedMessagePanel(data.session);
    }
    return data || null;
  } finally {
    setQueuedSteerRowBusy(row, false);
  }
}

function removeQueuedMessage(session, item, { clear = false, truncateFrom = false, row = null } = {}) {
  setQueuedSteerRowBusy(row, true);
  clearQueuedMessagePendingFeedback(session, item, { clear, truncateFrom });
  renderQueuedMessageOptimistically(session, item, { clear, truncateFrom });
  void updateQueuedMessageOnServer(session, item, { clear, truncateFrom })
    .catch((error) => {
      console.error("Failed to update queued follow-ups:", error?.message || error);
      if (typeof refreshCurrentSession === "function") {
        return refreshCurrentSession();
      }
      return null;
    })
    .finally(() => setQueuedSteerRowBusy(row, false));
}

function submitQueuedMessage(session, item, row = null) {
  void steerQueuedMessageOnServer(session, item, { row })
    .catch((error) => {
      console.error("Failed to steer queued follow-up:", error?.message || error);
      if (typeof refreshCurrentSession === "function") {
        return refreshCurrentSession();
      }
      return null;
    });
  return true;
}

function handleQueuedSteerAction(action, session, item, row = null) {
  closeQueuedSteerMenu();
  if (action === "steer") {
    submitQueuedMessage(session, item, row);
    return;
  }
  if (action === "edit") {
    setQueuedMessageIntoComposer(item);
    removeQueuedMessage(session, item, { truncateFrom: true, row });
    return;
  }
  if (action === "delete") {
    removeQueuedMessage(session, item, { row });
    return;
  }
  if (action === "clear") {
    removeQueuedMessage(session, item, { clear: true, row });
  }
}

function renderQueuedSteerMenuItem(action, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `queued-steer-menu-item queued-steer-menu-item--${action}`;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function openQueuedSteerMenu(anchor, session, item, row) {
  if (!row) return;
  const existing = typeof document.querySelector === "function"
    ? document.querySelector(".queued-steer-menu")
    : null;
  closeQueuedSteerMenu();
  if (existing) return;

  const menu = document.createElement("div");
  menu.className = "queued-steer-menu";
  menu.setAttribute("role", "menu");
  menu.appendChild(renderQueuedSteerMenuItem("edit", t("queue.editMessage")));
  menu.appendChild(renderQueuedSteerMenuItem("clear", t("queue.turnOffQueueing")));
  menu.addEventListener("click", (event) => {
    const target = event.target?.closest?.(".queued-steer-menu-item");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    handleQueuedSteerAction(target.dataset.action, session, item, row);
  });

  document.body.appendChild(menu);
  queuedSteerMenuBackEntryId = window.RagentBackHandler?.push?.({
    id: "queued-steer-menu",
    onBack: () => {
      closeQueuedSteerMenu();
      return true;
    },
  }) || null;
  const anchorRect = anchor.getBoundingClientRect();
  menu.style.top = `${anchorRect.bottom - 1}px`;
  menu.style.right = `${document.documentElement.clientWidth - anchorRect.right + 10}px`;
  anchor.setAttribute("aria-expanded", "true");
  const closeOnOutsidePointer = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeQueuedSteerMenu();
    document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    document.removeEventListener("keydown", closeOnEscape, true);
  };
  const closeOnEscape = (event) => {
    if (event.key !== "Escape") return;
    closeQueuedSteerMenu();
    document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    document.removeEventListener("keydown", closeOnEscape, true);
  };
  document.addEventListener("pointerdown", closeOnOutsidePointer, true);
  document.addEventListener("keydown", closeOnEscape, true);
}

function renderQueuedSteerAction(action, label, { text = "", disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `queued-steer-action queued-steer-action--${action}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.action = action;
  if (disabled) {
    button.setAttribute("aria-disabled", "true");
    button.disabled = true;
  }
  if (text) {
    const textNode = document.createElement("span");
    textNode.className = "queued-steer-action-label";
    textNode.textContent = text;
    button.appendChild(textNode);
  }
  return button;
}

function getQueuedMessageKey(item, index) {
  const requestId = getQueuedMessageRequestId(item);
  return requestId ? `request:${requestId}` : `index:${index}`;
}

function isQueuedPanelChild(node) {
  if (!queuedPanel || !node) return false;
  if (node.parentNode === queuedPanel) return true;
  return Array.from(queuedPanel.children || []).includes(node);
}

function placeQueuedPanelChild(node, index) {
  if (!queuedPanel || !node) return;
  const reference = queuedPanel.children?.[index] || null;
  if (reference === node) return;
  if (typeof queuedPanel.insertBefore === "function") {
    queuedPanel.insertBefore(node, reference);
    return;
  }
  // Tiny DOM shims used by focused tests do not always implement insertBefore.
  // Keep the fallback deterministic without changing the browser path.
  if (Array.isArray(queuedPanel.children)) {
    queuedPanel.children = queuedPanel.children.filter((child) => child !== node);
    queuedPanel.children.splice(Math.min(index, queuedPanel.children.length), 0, node);
    node.parentNode = queuedPanel;
    return;
  }
  queuedPanel.appendChild(node);
}

function createQueuedSteerActions(row, canSteer) {
  const actions = document.createElement("div");
  actions.className = "queued-steer-actions";
  if (canSteer) {
    const steerButton = renderQueuedSteerAction("steer", t("queue.steerAction"), {
      text: t("queue.steerAction"),
    });
    steerButton.addEventListener("click", (event) => {
      event.preventDefault();
      handleQueuedSteerAction("steer", row.__queuedSession, row.__queuedItem, row);
    });
    actions.appendChild(steerButton);
  }
  const deleteButton = renderQueuedSteerAction("delete", t("action.delete"));
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    handleQueuedSteerAction("delete", row.__queuedSession, row.__queuedItem, row);
  });
  const moreButton = renderQueuedSteerAction("more", t("action.more"));
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", "false");
  moreButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openQueuedSteerMenu(moreButton, row.__queuedSession, row.__queuedItem, row);
  });
  actions.appendChild(deleteButton);
  actions.appendChild(moreButton);
  return actions;
}

function syncQueuedMessageRowActions(row, session, item, canSteer) {
  const supportsActions = shouldRenderQueuedSteerActions(session);
  const existingActions = row.querySelector?.(".queued-steer-actions") || null;
  const actionsChanged = row.__queuedSupportsActions !== supportsActions
    || row.__queuedCanSteer !== canSteer
    || (supportsActions && !existingActions)
    || (!supportsActions && !!existingActions);
  if (!actionsChanged) return;

  existingActions?.remove?.();
  if (supportsActions) {
    row.appendChild(createQueuedSteerActions(row, canSteer));
  }
  row.__queuedSupportsActions = supportsActions;
  row.__queuedCanSteer = canSteer;
}

function updateQueuedMessageRow(row, session, item, {
  canSteer = false,
  optimistic = false,
  key = "",
} = {}) {
  if (!row) return row;
  const wasOptimistic = row.__queuedOptimistic;
  row.__queuedSession = session;
  row.__queuedItem = item;
  row.__queuedKey = key || getQueuedMessageKey(item, 0);
  row.__queuedOptimistic = optimistic === true;
  row.classList.remove("is-entering");
  row.className = `queued-steer-row${canSteer ? " queued-steer-row--active" : " queued-steer-row--waiting"}${optimistic ? " queued-steer-row--optimistic" : ""}`;
  row.dataset.requestId = getQueuedMessageRequestId(item);
  if (optimistic) {
    row.setAttribute("aria-busy", "true");
  } else {
    row.removeAttribute?.("aria-busy");
  }

  const text = row.querySelector?.(".queued-steer-text");
  if (text) {
    const messageText = getQueuedMessageText(item);
    text.textContent = messageText;
    text.title = messageText;
    delete text.dataset.attachments;
    const imageNames = getQueuedMessageAttachments(item)
      .map((image) => getAttachmentDisplayName(image))
      .filter(Boolean);
    if (imageNames.length > 0) {
      text.dataset.attachments = t("queue.attachments", { names: imageNames.join(", ") });
    }
  }

  // A server ACK updates the optimistic row in place. The row never re-enters;
  // only its semantic state and controls change, which is the visual handoff
  // between transport and the durable queue projection.
  if (wasOptimistic === true && !optimistic) {
    row.classList.add("is-confirming");
    const clearConfirming = () => row.classList.remove("is-confirming");
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(clearConfirming);
    } else {
      clearConfirming();
    }
  }
  syncQueuedMessageRowActions(row, session, item, canSteer);
  return row;
}

function renderQueuedMessageRow(session, item, {
  canSteer = false,
  optimistic = false,
  key = "",
} = {}) {
  const row = document.createElement("div");
  const content = document.createElement("div");
  content.className = "queued-steer-content";

  const icon = document.createElement("span");
  icon.className = "queued-steer-leading-icon";
  icon.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  text.className = "queued-steer-text";

  content.appendChild(icon);
  content.appendChild(text);
  row.appendChild(content);
  updateQueuedMessageRow(row, session, item, { canSteer, optimistic, key });
  row.classList.add("is-entering");
  return row;
}

function renderQueuedMessageSummary(count, existingSummary = null) {
  const summary = existingSummary || document.createElement("button");
  summary.type = "button";
  summary.className = "queued-summary";
  summary.setAttribute("aria-expanded", queuedPanel?.classList.contains("is-expanded") ? "true" : "false");

  if (!existingSummary) {
    const icon = document.createElement("span");
    icon.className = "queued-summary__icon";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "queued-summary__label";
    const chevron = document.createElement("span");
    chevron.className = "queued-summary__chevron";
    chevron.setAttribute("aria-hidden", "true");
    summary.appendChild(icon);
    summary.appendChild(label);
    summary.appendChild(chevron);
  }

  const label = summary.querySelector?.(".queued-summary__label");
  if (label) {
    label.textContent = count === 1
      ? t("queue.single")
      : t("queue.multiple", { count });
  }
  if (!summary.__queuedClickBound) {
    summary.addEventListener("click", () => {
      if (!queuedPanel) return;
      const expanded = queuedPanel.classList.toggle("is-expanded");
      summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
    summary.__queuedClickBound = true;
  }
  return summary;
}

function getQueuedPendingSendSnapshot() {
  if (typeof getComposerPendingSendSnapshot === "function") {
    return getComposerPendingSendSnapshot();
  }
  if (typeof getComposerPendingSendState === "function") {
    return getComposerPendingSendState();
  }
  return null;
}

function shouldRenderOptimisticQueuedMessage(session, items) {
  const pendingSend = getQueuedPendingSendSnapshot();
  if (!pendingSend || pendingSend.sessionId !== session?.id) return null;
  if (pendingSend.stage !== "sending" && pendingSend.stage !== "uploading") return null;
  const requestId = getQueuedMessageRequestId(pendingSend);
  if (!requestId || items.some((item) => getQueuedMessageRequestId(item) === requestId)) return null;
  if (!pendingSend.baselineActivity || typeof composerSendWillQueue !== "function") return null;
  if (!composerSendWillQueue({ ...session, activity: pendingSend.baselineActivity })) return null;
  return {
    requestId,
    text: pendingSend.text || "",
    images: Array.isArray(pendingSend.images) ? pendingSend.images : [],
    __optimistic: true,
  };
}

function clearQueuedPanelContent() {
  if (!queuedPanel) return;
  for (const child of Array.from(queuedPanel.children || [])) {
    child.remove?.();
  }
  queuedPanel.__queuedRows = new Map();
  queuedPanel.__queuedSummary = null;
}

function cancelQueuedPanelExit() {
  if (!queuedPanel?.__queuedExitTimer) return;
  const clearTimer = typeof window !== "undefined" && typeof window.clearTimeout === "function"
    ? window.clearTimeout.bind(window)
    : (typeof clearTimeout === "function" ? clearTimeout : null);
  clearTimer?.(queuedPanel.__queuedExitTimer);
  queuedPanel.__queuedExitTimer = null;
}

function scheduleQueuedPanelExit() {
  if (!queuedPanel) return;
  cancelQueuedPanelExit();
  const hasContent = (queuedPanel.children?.length || 0) > 0;
  queuedPanel.classList.remove("visible", "is-expanded");
  if (!hasContent) {
    queuedPanel.classList.remove("is-exiting");
    return;
  }
  closeQueuedSteerMenu();
  queuedPanel.classList.add("is-exiting");
  const removeAfterExit = () => {
    queuedPanel.__queuedExitTimer = null;
    if (!queuedPanel.classList.contains("is-exiting")) return;
    clearQueuedPanelContent();
    queuedPanel.classList.remove("is-exiting");
  };
  const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
    ? window.setTimeout.bind(window)
    : (typeof setTimeout === "function" ? setTimeout : null);
  queuedPanel.__queuedExitTimer = setTimer
    ? setTimer(removeAfterExit, 180)
    : null;
  if (!setTimer) removeAfterExit();
}

function renderQueuedMessagePanel(session) {
  if (!queuedPanel) return;
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  if (!session?.id || session.id !== currentSessionId) {
    scheduleQueuedPanelExit();
    return;
  }

  const entries = items.map((item, index) => ({
    item,
    key: getQueuedMessageKey(item, index),
    optimistic: item?.__optimistic === true,
  }));
  const optimisticItem = shouldRenderOptimisticQueuedMessage(session, items);
  if (optimisticItem) {
    entries.push({
      item: optimisticItem,
      key: getQueuedMessageKey(optimisticItem, entries.length),
      optimistic: true,
    });
  }
  if (entries.length === 0) {
    scheduleQueuedPanelExit();
    return;
  }

  cancelQueuedPanelExit();
  const wasExpanded = queuedPanel.classList.contains("is-expanded");
  queuedPanel.classList.remove("is-exiting");
  queuedPanel.classList.toggle("is-expanded", wasExpanded);
  queuedPanel.classList.add("visible");
  queuedPanel.setAttribute("aria-live", "polite");
  queuedPanel.removeAttribute?.("aria-hidden");

  const previousSummary = isQueuedPanelChild(queuedPanel.__queuedSummary)
    ? queuedPanel.__queuedSummary
    : null;
  const summary = entries.length >= 2
    ? renderQueuedMessageSummary(entries.length, previousSummary)
    : null;
  if (!summary) previousSummary?.remove?.();
  queuedPanel.__queuedSummary = summary;
  if (summary) placeQueuedPanelChild(summary, 0);

  const previousRows = queuedPanel.__queuedRows instanceof Map
    ? queuedPanel.__queuedRows
    : new Map();
  const nextRows = new Map();
  const activeNodes = new Set(summary ? [summary] : []);
  let hasStaleRows = false;
  entries.forEach(({ item, key, optimistic }, index) => {
    const canSteer = index === 0 && !optimistic && shouldAllowQueuedSteer(session);
    let row = previousRows.get(key);
    if (!isQueuedPanelChild(row)) {
      row = renderQueuedMessageRow(session, item, { canSteer, optimistic, key });
    } else {
      updateQueuedMessageRow(row, session, item, { canSteer, optimistic, key });
    }
    nextRows.set(key, row);
    activeNodes.add(row);
    placeQueuedPanelChild(row, index + 1);
  });

  for (const [key, row] of previousRows.entries()) {
    if (nextRows.has(key)) continue;
    hasStaleRows = true;
    row.remove?.();
  }
  if (hasStaleRows && document.querySelector?.(".queued-steer-menu")) {
    closeQueuedSteerMenu();
  }
  for (const child of Array.from(queuedPanel.children || [])) {
    if (!activeNodes.has(child)) child.remove?.();
  }
  queuedPanel.__queuedRows = nextRows;
}

function getSessionMetaStatusInfo(session) {
  const liveStatus = getSessionStatusSummary(session).primary;
  if (liveStatus?.key && liveStatus.key !== "idle") {
    return liveStatus;
  }
  const workflowStatus = typeof window !== "undefined"
    && window.RagentSessionStateModel
    && typeof window.RagentSessionStateModel.getWorkflowStatusInfo === "function"
    ? window.RagentSessionStateModel.getWorkflowStatusInfo(session?.workflowState)
    : null;
  return workflowStatus || liveStatus;
}

function getSessionReviewStatusInfo(session) {
  return typeof window !== "undefined"
    && window.RagentSessionStateModel
    && typeof window.RagentSessionStateModel.getSessionReviewStatusInfo === "function"
    ? window.RagentSessionStateModel.getSessionReviewStatusInfo(session)
    : null;
}

function isSessionCompleteAndReviewed(session) {
  return typeof window !== "undefined"
    && window.RagentSessionStateModel
    && typeof window.RagentSessionStateModel.isSessionCompleteAndReviewed === "function"
    ? window.RagentSessionStateModel.isSessionCompleteAndReviewed(session)
    : false;
}

function getFilteredSessionEmptyText({ archived = false } = {}) {
  if (archived) return t("sidebar.noArchived");
  if (activeSourceFilter !== FILTER_ALL_VALUE) {
    return t("sidebar.noSessionsFiltered");
  }
  return t("sidebar.noSessions");
}

function getSessionStatusItemClass(statusInfo) {
  const key = typeof statusInfo?.key === "string" ? statusInfo.key.trim().toLowerCase() : "";
  if (!key || key === "idle") return "";
  return `session-status-${key.replace(/[^a-z0-9_-]+/g, "-")}`;
}

function getSessionRunStateItemClass(session) {
  const model = typeof globalThis !== "undefined" ? globalThis.RagentSessionStateModel : null;
  const activity = typeof model?.normalizeSessionActivity === "function"
    ? model.normalizeSessionActivity(session)
    : null;
  return activity?.run?.state === "running" ? "session-is-running" : "";
}

function getSessionListIndicatorInfo(session) {
  const model = typeof globalThis !== "undefined" ? globalThis.RagentSessionStateModel : null;
  const activity = typeof model?.normalizeSessionActivity === "function"
    ? model.normalizeSessionActivity(session)
    : null;
  if (activity?.run?.state === "running") {
    const statusInfo = getSessionStatusSummary(session).primary;
    const label = statusInfo?.label || t("status.running");
    return {
      className: "session-item-status--running",
      label,
      title: statusInfo?.title || label,
    };
  }

  // A session blocked on the user (approval or question) carries the strongest
  // "you must act" signal: amber dot, ranked above the unread blue dot (mirrors
  // getSessionAttentionBand: unread+waiting = band 0, waiting = band 2). The
  // dot clears once the owner has opened the session after the waiting state
  // began — hasSessionNeedsAction compares workflowStateChangedAt against the
  // review stamp, like the unread dot (raw state check below when the model is
  // missing).
  let needsAction = false;
  if (typeof model?.hasSessionNeedsAction === "function") {
    needsAction = model.hasSessionNeedsAction(session);
  } else {
    const workflowState = typeof model?.normalizeSessionWorkflowState === "function"
      ? model.normalizeSessionWorkflowState(session?.workflowState || "")
      : String(session?.workflowState || "").trim().toLowerCase();
    needsAction = workflowState === "waiting_user";
  }
  if (needsAction) {
    const label = t("status.needsAction");
    return {
      className: "session-item-status--needs-action",
      label,
      title: t("status.needsActionTitle"),
    };
  }

  const reviewStatus = getSessionReviewStatusInfo(session);
  if (reviewStatus) {
    const label = reviewStatus.label || t("workflow.status.unread");
    return {
      className: "session-item-status--unread",
      label,
      title: reviewStatus.title || label,
    };
  }

  // Background AI status (DS-04): only problem states claim the dot (after
  // running/needs-action/unread), so the marker never hides a stronger
  // signal. queued/running/succeeded/idle/disabled are transient or benign
  // and stay out of the list dot; the full projection is always in
  // session.backgroundAi.
  const bgAi = session?.backgroundAi;
  const bgAiProblemStatuses = ["cooldown", "unsupported", "code_error", "failed", "skipped"];
  if (bgAi && bgAiProblemStatuses.includes(bgAi.status)) {
    const shortKey = bgAi.status === "code_error" ? "bgai.status.codeErrorShort" : `bgai.status.${bgAi.status}Short`;
    const longKey = `bgai.status.${bgAi.status}`;
    const label = t(shortKey);
    const retryHint = bgAi.retryAfterMs
      ? ` (${Math.ceil(bgAi.retryAfterMs / 1000)}s)`
      : "";
    return {
      className: "session-item-status--bg-ai",
      label,
      title: `${t(longKey)}${retryHint}`,
    };
  }

  return null;
}

let _activeContextMenu = null;
let sessionContextMenuBackEntryId = null;
let sidebarActionSheetTrigger = null;
let sidebarActionSheetState = null;
let sidebarActionSheetContentTransitionToken = 0;
let sidebarActionSheetContentAnimation = null;
let sidebarActionSheetBackgroundLock = null;
let queuedSteerMenuBackEntryId = null;

function prefersSidebarReducedMotion() {
  return window.RagentMotion?.prefersReducedMotion?.()
    || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function getSidebarActionTargetName(state) {
  if (state?.kind === "session") {
    return typeof getSessionDisplayName === "function"
      ? getSessionDisplayName(state.target)
      : String(state.target?.name || state.target?.tool || t("sidebar.session"));
  }
  return String(state?.target?.name || t("sidebar.project.untitled"));
}

function releaseSidebarActionSheetBackgroundLock(sheet = null) {
  const lock = sidebarActionSheetBackgroundLock;
  if (!lock || (sheet && lock.sheet !== sheet)) return;
  sidebarActionSheetBackgroundLock = null;
  for (const record of lock.records) {
    if (!record.node.isConnected) continue;
    try {
      record.node.inert = record.inert;
    } catch {}
    if (record.hasInertAttribute) {
      record.node.setAttribute("inert", record.inertAttributeValue ?? "");
    } else {
      record.node.removeAttribute("inert");
    }
    if (record.hasAriaHidden) {
      record.node.setAttribute("aria-hidden", record.ariaHiddenValue ?? "");
    } else {
      record.node.removeAttribute("aria-hidden");
    }
  }
  document.body?.classList.remove("sidebar-action-sheet-open");
}

function lockSidebarActionSheetBackground(sheet) {
  if (!sheet || !document.body) return;
  releaseSidebarActionSheetBackgroundLock();
  const records = [];
  for (const node of Array.from(document.body.children)) {
    if (node === sheet) continue;
    records.push({
      node,
      inert: node.inert === true,
      hasInertAttribute: node.hasAttribute("inert"),
      inertAttributeValue: node.getAttribute("inert"),
      hasAriaHidden: node.hasAttribute("aria-hidden"),
      ariaHiddenValue: node.getAttribute("aria-hidden"),
    });
    try {
      node.inert = true;
    } catch {}
    node.setAttribute("inert", "");
    node.setAttribute("aria-hidden", "true");
  }
  document.body.classList.add("sidebar-action-sheet-open");
  sidebarActionSheetBackgroundLock = { sheet, records };
}

function cancelSidebarActionSheetContentAnimation(panel = null) {
  if (sidebarActionSheetContentAnimation) {
    sidebarActionSheetContentAnimation.cancel?.();
    sidebarActionSheetContentAnimation = null;
  }
  panel?.style.removeProperty("height");
}

function normalizeSidebarProjectId(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^prj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : "";
}

function normalizeSidebarProjectRoot(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function getSidebarActionErrorStatus(error) {
  const explicit = Number(error?.status);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const match = String(error?.message || "").match(/\((\d{3})\)/);
  return match ? Number(match[1]) : 0;
}

async function resolveSidebarProjectTarget(project) {
  const target = project && typeof project === "object" ? project : {};
  const targetId = normalizeSidebarProjectId(target.id);
  const targetRoot = normalizeSidebarProjectRoot(target.rootPath);
  if (typeof window.ragentEnsureProjectsReady !== "function") {
    return targetId ? { ...target, id: targetId } : null;
  }

  let catalog;
  try {
    const refreshed = await window.ragentEnsureProjectsReady({ force: true });
    catalog = Array.isArray(refreshed)
      ? refreshed
      : (typeof window.ragentGetProjects === "function" ? window.ragentGetProjects() : []);
  } catch (error) {
    if (targetId) return { ...target, id: targetId };
    throw error;
  }

  const current = catalog.find((entry) => normalizeSidebarProjectId(entry?.id) === targetId)
    || (targetRoot
      ? catalog.find((entry) => normalizeSidebarProjectRoot(entry?.rootPath) === targetRoot)
      : null)
    || (!targetId && target.name
      ? catalog.find((entry) => String(entry?.name || "").trim() === String(target.name).trim())
      : null);
  if (current) return { ...target, ...current, id: normalizeSidebarProjectId(current.id) };
  return targetId ? { ...target, id: targetId } : null;
}

function getSidebarActionSheetIcon(state) {
  return renderUiIcon(state?.kind === "project" ? "folder-solid" : "sidebar");
}

function closeSidebarActionSheet({ restoreFocus = true, immediate = false } = {}) {
  if (!_activeContextMenu) {
    if (immediate) releaseSidebarActionSheetBackgroundLock();
    return;
  }
  if (sessionContextMenuBackEntryId) {
    window.RagentBackHandler?.pop?.(sessionContextMenuBackEntryId);
    sessionContextMenuBackEntryId = null;
  }
  const sheet = _activeContextMenu;
  _activeContextMenu = null;
  sidebarActionSheetState = null;
  sidebarActionSheetContentTransitionToken += 1;
  cancelSidebarActionSheetContentAnimation(sheet.querySelector?.(".sidebar-action-sheet-panel"));
  document.removeEventListener("pointerdown", _ctxOutsideHandler, true);
  document.removeEventListener("keydown", _ctxKeyHandler, true);
  sheet.classList.add("is-closing");
  const trigger = sidebarActionSheetTrigger;
  sidebarActionSheetTrigger = null;
  const removeSheet = () => {
    releaseSidebarActionSheetBackgroundLock(sheet);
    sheet.remove();
  };
  if (immediate || prefersSidebarReducedMotion()) removeSheet();
  else window.setTimeout(removeSheet, 220);
  if (restoreFocus && trigger?.isConnected) {
    window.setTimeout(() => trigger.focus({ preventScroll: true }), immediate ? 0 : 220);
  }
}

function closeSessionContextMenu(options = {}) {
  closeSidebarActionSheet(options);
}

function _ctxOutsideHandler(e) {
  if (!_activeContextMenu) return;
  if (e.target?.closest?.(".sidebar-action-sheet-backdrop")) {
    closeSidebarActionSheet();
    return;
  }
  if (!_activeContextMenu.contains(e.target)) closeSidebarActionSheet();
}

function getSidebarActionSheetFocusableElements() {
  if (!_activeContextMenu) return [];
  return Array.from(_activeContextMenu.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getClientRects().length > 0);
}

function _ctxKeyHandler(e) {
  if (e.key === "Escape") {
    closeSidebarActionSheet();
    return;
  }
  if (e.key !== "Tab" || !_activeContextMenu) return;

  const focusable = getSidebarActionSheetFocusableElements();
  if (!focusable.length) {
    e.preventDefault();
    _activeContextMenu.querySelector(".sidebar-action-sheet-panel")?.focus({ preventScroll: true });
    return;
  }
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = e.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
  if (currentIndex === -1 || nextIndex !== currentIndex + (e.shiftKey ? -1 : 1)) {
    e.preventDefault();
    focusable[nextIndex].focus({ preventScroll: true });
  }
}

function focusSidebarActionSheet() {
  const focusable = getSidebarActionSheetFocusableElements();
  focusable[0]?.focus({ preventScroll: true });
}

function createSidebarActionButton({ icon, label, hint = "", action, danger = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `sidebar-action-sheet-action${danger ? " is-danger" : ""}`;
  button.dataset.action = action;
  const iconEl = document.createElement("span");
  iconEl.className = "sidebar-action-sheet-action-icon";
  iconEl.innerHTML = icon;
  const copy = document.createElement("span");
  copy.className = "sidebar-action-sheet-action-copy";
  const labelEl = document.createElement("span");
  labelEl.className = "sidebar-action-sheet-action-label";
  labelEl.textContent = label;
  copy.appendChild(labelEl);
  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "sidebar-action-sheet-action-hint";
    hintEl.textContent = hint;
    copy.appendChild(hintEl);
  }
  button.append(iconEl, copy);
  return button;
}

function setSidebarActionSheetError(message) {
  const panel = _activeContextMenu?.querySelector(".sidebar-action-sheet-panel");
  if (!panel) return;
  const old = panel.querySelector(".sidebar-action-sheet-error");
  old?.remove();
  if (!message) return;
  const error = document.createElement("p");
  error.className = "sidebar-action-sheet-error";
  error.setAttribute("role", "alert");
  error.textContent = message;
  panel.appendChild(error);
}

async function runSidebarActionSheetTask(task) {
  const state = sidebarActionSheetState;
  if (!state || state.busy) return;
  state.busy = true;
  state.error = "";
  renderSidebarActionSheet();
  try {
    const result = await task();
    if (result === false) throw new Error(t("sidebar.actionFailed"));
    closeSidebarActionSheet();
  } catch (error) {
    if (!sidebarActionSheetState) return;
    state.busy = false;
    state.error = error?.message || t("sidebar.actionFailed");
    renderSidebarActionSheet();
  }
}

async function refreshSidebarAfterProjectMutation() {
  if (typeof window.ragentEnsureProjectsReady === "function") {
    await window.ragentEnsureProjectsReady({ force: true });
  }
  if (typeof fetchSessionsList === "function") {
    await fetchSessionsList({ forceFresh: true });
  } else if (typeof window.ragentRefreshWorkspaceSessions === "function") {
    await window.ragentRefreshWorkspaceSessions();
  }
  window.refreshProjectsView?.();
}

async function updateProjectFromSidebarAction(project, patch) {
  const projectId = String(project?.id || "").trim();
  if (!projectId || typeof fetchJsonOrRedirect !== "function") return false;
  const data = await fetchJsonOrRedirect(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await refreshSidebarAfterProjectMutation();
  return !!data?.project;
}

async function deleteProjectFromSidebarAction(project, deleteSessions) {
  if (typeof fetchJsonOrRedirect !== "function") return false;
  const resolvedProject = await resolveSidebarProjectTarget(project);
  const projectId = normalizeSidebarProjectId(resolvedProject?.id);
  if (!projectId) throw new Error(t("sidebar.project.notFound"));
  const body = JSON.stringify({ deleteSessions: deleteSessions === true });
  try {
    await fetchJsonOrRedirect(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (error) {
    const status = getSidebarActionErrorStatus(error);
    if (status !== 404) throw error;

    // A project can disappear in another tab between the long press and the
    // action. Treat that state as already complete after one authoritative
    // catalog refresh; it is the desired end state of this operation.
    let catalog = [];
    if (typeof window.ragentEnsureProjectsReady === "function") {
      const refreshed = await window.ragentEnsureProjectsReady({ force: true });
      catalog = Array.isArray(refreshed)
        ? refreshed
        : (typeof window.ragentGetProjects === "function" ? window.ragentGetProjects() : []);
    }
    const stillExists = catalog.some((entry) => normalizeSidebarProjectId(entry?.id) === projectId);
    if (!stillExists) {
      await refreshSidebarAfterProjectMutation();
      return true;
    }

    // A paired P2P host can still be running an older router. First retry the
    // canonical operation through the current HTTP control plane, explicitly
    // bypassing P2P; only if that route is genuinely absent do we use the
    // POST compatibility endpoint. Without this, both attempts can hit the
    // same stale P2P host and surface the original 404 forever.
    try {
      await fetchJsonOrRedirect(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body,
        skipP2P: true,
      });
    } catch (retryError) {
      if (getSidebarActionErrorStatus(retryError) !== 404) throw retryError;
      await fetchJsonOrRedirect(`/api/projects/${encodeURIComponent(projectId)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        skipP2P: true,
      });
    }
  }
  await refreshSidebarAfterProjectMutation();
  return true;
}

function renderSidebarRenameView(panel, state) {
  const form = document.createElement("form");
  form.className = "sidebar-action-sheet-rename-form";
  const label = document.createElement("label");
  label.className = "sidebar-action-sheet-field-label";
  label.textContent = state.kind === "project" ? t("sidebar.project.name") : t("sidebar.session.name");
  const input = document.createElement("input");
  input.id = "sidebarActionSheetName";
  input.className = "sidebar-action-sheet-name-input";
  input.type = "text";
  input.name = "name";
  input.maxLength = 100;
  input.autocomplete = "off";
  input.enterKeyHint = "done";
  input.value = typeof state.draftName === "string"
    ? state.draftName
    : getSidebarActionTargetName(state);
  state.draftName = input.value;
  input.setAttribute("aria-label", label.textContent);
  label.htmlFor = input.id;
  const actions = document.createElement("div");
  actions.className = "sidebar-action-sheet-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "sidebar-action-sheet-secondary";
  cancel.textContent = t("action.cancel");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "sidebar-action-sheet-primary";
  save.textContent = t("action.save");
  actions.append(cancel, save);
  form.append(label, input, actions);
  cancel.addEventListener("click", () => {
    state.view = "actions";
    state.error = "";
    renderSidebarActionSheet();
  });
  const submitRename = () => {
    // Keep the latest value independent of blur/change ordering. Mobile
    // browsers may keep the input focused while activating the submit button,
    // and a failed request re-renders this form with a fresh input element.
    state.draftName = input.value;
    const name = input.value.trim();
    if (!name) {
      state.error = t("sidebar.renameRequired");
      setSidebarActionSheetError(state.error);
      input.focus();
      return;
    }
    void runSidebarActionSheetTask(async () => {
      if (state.kind === "session") {
        return dispatchAction({ action: "rename", sessionId: state.target.id, name });
      }
      const updated = await updateProjectFromSidebarAction(state.target, { name });
      if (updated) state.target.name = name;
      return updated;
    });
  };
  input.addEventListener("input", () => {
    state.draftName = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (typeof form.requestSubmit === "function") form.requestSubmit(save);
    else submitRename();
  });
  save.addEventListener("click", (event) => {
    // Own this path so a focused input never relies on the browser first
    // committing a change event before the button's form submission.
    event.preventDefault();
    submitRename();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRename();
  });
  panel.appendChild(form);
  window.requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
}

function renderSidebarActionSheet() {
  const state = sidebarActionSheetState;
  const sheet = _activeContextMenu;
  const panel = sheet?.querySelector(".sidebar-action-sheet-panel");
  if (!state || !sheet || !panel) return;
  const previousView = state._renderedView;
  const shouldAnimateContent = !!previousView
    && previousView !== state.view
    && !prefersSidebarReducedMotion();
  const previousPanelHeight = shouldAnimateContent
    ? panel.getBoundingClientRect().height
    : 0;
  const transitionToken = shouldAnimateContent ? ++sidebarActionSheetContentTransitionToken : 0;
  cancelSidebarActionSheetContentAnimation(panel);
  panel.classList.remove("is-content-switching");
  if (shouldAnimateContent) void panel.offsetWidth;
  panel.innerHTML = "";
  panel.dataset.view = state.view;

  const header = document.createElement("div");
  header.className = "sidebar-action-sheet-header";
  const headerIcon = document.createElement("span");
  headerIcon.className = "sidebar-action-sheet-header-icon";
  headerIcon.innerHTML = getSidebarActionSheetIcon(state);
  const titleBlock = document.createElement("div");
  titleBlock.className = "sidebar-action-sheet-title-block";
  const title = document.createElement("h2");
  title.className = "sidebar-action-sheet-title";
  title.id = "sidebarActionSheetTitle";
  const subtitle = document.createElement("p");
  subtitle.className = "sidebar-action-sheet-subtitle";
  const busyIndicator = document.createElement("span");
  busyIndicator.className = "sidebar-action-sheet-busy-indicator";
  busyIndicator.setAttribute("aria-hidden", "true");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sidebar-action-sheet-close";
  close.setAttribute("aria-label", t("action.close"));
  close.title = t("action.close");
  close.innerHTML = renderUiIcon("close");
  close.addEventListener("click", () => closeSidebarActionSheet());
  titleBlock.append(title, subtitle);
  header.append(headerIcon, titleBlock, busyIndicator, close);
  panel.appendChild(header);

  if (state.view !== "actions") {
    title.textContent = state.view === "rename"
      ? t("sidebar.renameTitle")
      : (state.kind === "session"
        ? t("sidebar.session.deleteTitle")
        : t("sidebar.project.deleteTitle"));
    subtitle.textContent = getSidebarActionTargetName(state);
  } else {
    title.textContent = state.kind === "project" ? t("sidebar.project.actions") : t("sidebar.session.actions");
    subtitle.textContent = getSidebarActionTargetName(state);
  }

  if (state.view === "rename") {
    renderSidebarRenameView(panel, state);
  } else if (state.view === "delete") {
    const body = document.createElement("p");
    body.className = "sidebar-action-sheet-confirm-copy";
    body.textContent = state.kind === "session"
      ? t("sidebar.session.deleteBody")
      : t("sidebar.project.deleteBody", {
        count: Number.isInteger(state.target.sessionCount) ? state.target.sessionCount : 0,
      });
    panel.appendChild(body);
    const list = document.createElement("div");
    list.className = "sidebar-action-sheet-actions";
    if (state.kind === "session") {
      const confirmDelete = createSidebarActionButton({
        icon: renderUiIcon("trash"),
        label: t("action.delete"),
        action: "confirm-delete-session",
        danger: true,
      });
      confirmDelete.addEventListener("click", () => {
        void runSidebarActionSheetTask(() => dispatchAction({ action: "delete", sessionId: state.target.id }));
      });
      list.appendChild(confirmDelete);
    } else {
      const deleteAll = createSidebarActionButton({
        icon: renderUiIcon("trash"),
        label: t("sidebar.project.deleteAll"),
        hint: t("sidebar.project.deleteAllHint"),
        action: "delete-all-sessions",
        danger: true,
      });
      const keepSessions = createSidebarActionButton({
        icon: renderUiIcon("archive"),
        label: t("sidebar.project.keepSessions"),
        hint: t("sidebar.project.keepSessionsHint"),
        action: "keep-sessions-inbox",
      });
      deleteAll.addEventListener("click", () => {
        void runSidebarActionSheetTask(() => deleteProjectFromSidebarAction(state.target, true));
      });
      keepSessions.addEventListener("click", () => {
        void runSidebarActionSheetTask(() => deleteProjectFromSidebarAction(state.target, false));
      });
      list.append(deleteAll, keepSessions);
    }
    panel.appendChild(list);
  } else {
    const list = document.createElement("div");
    list.className = "sidebar-action-sheet-actions";
    const target = state.target;
    const pin = createSidebarActionButton({
      icon: renderUiIcon(target.pinned ? "pinned" : "pin"),
      label: target.pinned ? t("action.unpin") : t("action.pin"),
      action: "pin",
    });
    const rename = createSidebarActionButton({
      icon: renderUiIcon("edit"),
      label: t("action.rename"),
      action: "rename",
    });
    list.append(pin, rename);
    pin.addEventListener("click", () => {
      void runSidebarActionSheetTask(async () => {
        if (state.kind === "session") {
          return dispatchAction({ action: target.pinned ? "unpin" : "pin", sessionId: target.id });
        }
        return updateProjectFromSidebarAction(target, { pinned: target.pinned !== true });
      });
    });
    rename.addEventListener("click", () => {
      state.view = "rename";
      state.error = "";
      renderSidebarActionSheet();
    });
    if (state.kind === "session") {
      const remove = createSidebarActionButton({
        icon: renderUiIcon("trash"),
        label: t("action.delete"),
        action: "delete",
        danger: true,
      });
      remove.addEventListener("click", () => {
        state.view = "delete";
        state.error = "";
        renderSidebarActionSheet();
      });
      list.appendChild(remove);
    } else {
      const deleteButton = createSidebarActionButton({
        icon: renderUiIcon("trash"),
        label: t("action.delete"),
        action: "delete-project",
        danger: true,
      });
      deleteButton.addEventListener("click", () => {
        state.view = "delete";
        state.error = "";
        renderSidebarActionSheet();
      });
      list.appendChild(deleteButton);
    }
    panel.appendChild(list);
  }

  if (state.view !== "actions") {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "sidebar-action-sheet-back";
    back.innerHTML = `${renderUiIcon("chevron-left")}<span>${esc(t("action.back"))}</span>`;
    back.addEventListener("click", () => {
      state.view = "actions";
      state.error = "";
      renderSidebarActionSheet();
    });
    panel.appendChild(back);
  }
  sheet.dataset.busy = state.busy ? "true" : "false";
  sheet.setAttribute("aria-busy", String(state.busy));
  panel.setAttribute("aria-busy", String(state.busy));
  if (state.busy) {
    panel.querySelectorAll("button, input").forEach((node) => { node.disabled = true; });
  }
  if (state.error) setSidebarActionSheetError(state.error);
  state._renderedView = state.view;
  if (state.view === "delete" && state.kind === "session" && !state.busy) {
    // The delete row is replaced during the transition. Move keyboard focus
    // to the visible close action so it never silently drops to the page or
    // lands on the destructive confirmation button.
    window.requestAnimationFrame(() => {
      panel.querySelector(".sidebar-action-sheet-close")?.focus({ preventScroll: true });
    });
  }
  if (shouldAnimateContent) {
    panel.classList.add("is-content-switching");
    const nextPanelHeight = panel.getBoundingClientRect().height;
    if (previousPanelHeight > 0
      && Math.abs(nextPanelHeight - previousPanelHeight) > 1
      && typeof panel.animate === "function") {
      panel.style.height = `${previousPanelHeight}px`;
      sidebarActionSheetContentAnimation = panel.animate(
        [
          { height: `${previousPanelHeight}px` },
          { height: `${nextPanelHeight}px` },
        ],
        {
          duration: 240,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "forwards",
        },
      );
      const heightAnimation = sidebarActionSheetContentAnimation;
      heightAnimation.finished
        ?.then(() => {
          if (heightAnimation === sidebarActionSheetContentAnimation) {
            panel.style.removeProperty("height");
            sidebarActionSheetContentAnimation = null;
          }
        })
        .catch(() => {});
    }
    window.setTimeout(() => {
      if (transitionToken === sidebarActionSheetContentTransitionToken) {
        panel.classList.remove("is-content-switching");
        if (state.view !== "rename") {
          panel.querySelector("button:not([disabled]), input:not([disabled])")
            ?.focus?.({ preventScroll: true });
        }
      }
    }, 260);
  }
}

function openSidebarActionSheet(kind, target, anchorEl, initialView = "actions") {
  closeSidebarActionSheet({ restoreFocus: false, immediate: true });
  // A previous sheet can still be finishing its exit animation after its
  // active reference has been cleared. Release that stale lock before a new
  // sheet becomes the sole interactive surface.
  releaseSidebarActionSheetBackgroundLock();
  // A just-closed sheet may still be finishing its exit animation. Remove it
  // before opening the next sheet so rapid long-presses never stack two
  // interactive dialogs in the DOM.
  document.querySelectorAll(".sidebar-action-sheet.is-closing").forEach((sheet) => sheet.remove());
  const sheet = document.createElement("div");
  sheet.className = "sidebar-action-sheet";
  sheet.innerHTML = `
    <div class="sidebar-action-sheet-backdrop" aria-hidden="true"></div>
    <section class="sidebar-action-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sidebarActionSheetTitle" tabindex="-1"></section>`;
  document.body.appendChild(sheet);
  lockSidebarActionSheetBackground(sheet);
  _activeContextMenu = sheet;
  sidebarActionSheetTrigger = anchorEl || null;
  sidebarActionSheetState = {
    kind,
    target: { ...(target || {}) },
    view: ["actions", "rename", "delete"].includes(initialView) ? initialView : "actions",
    busy: false,
    error: "",
    _renderedView: "",
  };
  renderSidebarActionSheet();
  sessionContextMenuBackEntryId = window.RagentBackHandler?.push?.({
    // Keep the historical id so browser-back behavior and existing shell
    // coverage remain stable while the surface itself becomes a sheet.
    id: "session-context-menu",
    onBack: () => {
      closeSessionContextMenu();
      return true;
    },
  }) || null;
  document.addEventListener("pointerdown", _ctxOutsideHandler, true);
  document.addEventListener("keydown", _ctxKeyHandler, true);
  window.requestAnimationFrame(() => {
    sheet.classList.add("is-open");
    focusSidebarActionSheet();
  });
  return sheet;
}

function openSessionContextMenu(session, anchorEl, renameWrapper) {
  void renameWrapper;
  return openSidebarActionSheet("session", session, anchorEl);
}

window.ragentOpenSidebarActionSheet = openSidebarActionSheet;
window.ragentOpenSessionRename = function openSessionRename(session, anchorEl) {
  return openSidebarActionSheet("session", session, anchorEl, "rename");
};
window.ragentOpenSessionDelete = function openSessionDelete(session, anchorEl) {
  return openSidebarActionSheet("session", session, anchorEl, "delete");
};
window.ragentOpenProjectActionSheet = function openProjectActionSheet(project, anchorEl) {
  return openSidebarActionSheet("project", project, anchorEl);
};

function bindSidebarLongPress(target, onLongPress) {
  if (!target || typeof onLongPress !== "function") return;
  // Deliberate two-second hold (owner preference for the sidebar, slower
  // than the platform idiom so a resting finger never opens the sheet by
  // accident). The hold wash in chat-sidebar.css (.session-item.is-pressing)
  // transitions over the same duration so press → long-press reads as one
  // continuous gesture.
  const LONG_PRESS_MS = 2000;
  // Finger drift while holding still is normal; only a real scroll (movement
  // beyond the tolerance) should cancel the gesture.
  const MOVE_TOLERANCE_PX = 24;
  let timer = null;
  let startX = 0;
  let startY = 0;
  let longPressTriggered = false;
  // Alive from pointerdown until the gesture ends — not just until the timer
  // fires — so the pan guard below keeps protecting an armed hold while the
  // finger is still down.
  let holdActive = false;
  const isDesktopViewport = () => window.matchMedia?.("(min-width: 768px)")?.matches === true;
  const cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = null;
    holdActive = false;
    target.classList.remove("is-pressing", "is-long-press");
  };
  const liftOrCancel = (event) => {
    // After the threshold the hold is armed; if the platform claims the pan
    // right then (slow drift finally crossing scroll slop), the gesture ends
    // with pointercancel/touchcancel and pointerup never fires — treat that
    // cancel as the lift so an armed hold still opens.
    const armed = longPressTriggered && !timer;
    cancel();
    if (armed) onLongPress(event);
  };
  target.addEventListener("pointerdown", (event) => {
    // Desktop rows use the native context menu affordance. This also keeps a
    // touchscreen attached to a desktop viewport from opening actions on hold.
    if (isDesktopViewport() || event.pointerType === "mouse") return;
    if (event.pointerType && event.pointerType !== "touch") return;
    if (event.button && event.button !== 0) return;
    cancel();
    longPressTriggered = false;
    holdActive = true;
    startX = event.clientX;
    startY = event.clientY;
    target.classList.add("is-pressing");
    timer = window.setTimeout(() => {
      timer = null;
      longPressTriggered = true;
      // Arm on threshold, open on lift: the row deepens into the long-press
      // wash (plus a haptic tick), the sheet only appears once the finger is
      // up and the row has restored — the way the gesture reads on mobile.
      target.classList.remove("is-pressing");
      target.classList.add("is-long-press");
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate(12); } catch {}
      }
    }, LONG_PRESS_MS);
  });
  target.addEventListener("pointermove", (event) => {
    if (!timer) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) cancel();
  });
  target.addEventListener("pointerup", liftOrCancel);
  target.addEventListener("pointerleave", cancel);
  target.addEventListener("pointercancel", liftOrCancel);
  target.addEventListener("touchcancel", liftOrCancel);
  // Non-passive on purpose: a real finger always drifts a few pixels during a
  // two-second hold. Once that drift crosses the platform's scroll slop the
  // browser claims the pan and fires pointercancel — the press dies long
  // before the (deliberately slow) threshold and the sheet never opens on
  // phones. While the drift stays inside our tolerance, block the pan so the
  // gesture stays ours; past the tolerance we release it and the list scrolls
  // as usual. The guard spans the whole hold (holdActive), including the time
  // after the threshold, where losing the pan would end an armed hold with a
  // cancel instead of a lift.
  target.addEventListener("touchmove", (event) => {
    if (!holdActive) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) return;
    if (event.cancelable && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  }, { passive: false });
  target.addEventListener("contextmenu", (event) => {
    // Mobile browsers may emit contextmenu during a touch hold. Suppress the
    // browser menu, but let the explicit 3-second timer own the action sheet.
    const touchContextMenu = event.pointerType === "touch"
      || event.sourceCapabilities?.firesTouchEvents === true;
    const rightClick = !touchContextMenu && event.button === 2;
    if (!rightClick) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    cancel();
    onLongPress(event);
  });
  // A long-press on a button can otherwise synthesize a click on pointerup;
  // consume that click without affecting normal taps.
  target.addEventListener("click", (event) => {
    if (!longPressTriggered) return;
    longPressTriggered = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

window.ragentBindSidebarLongPress = bindSidebarLongPress;

// --- delegated long-press for session rows ----------------------------------
// renderSessionList() rebuilds every row element on each render (it clears
// the list container and recreates the items), and realtime invalidations
// re-render continuously while any session is running. A hold bound to one
// row element therefore dies mid-gesture whenever that row is replaced — on
// a phone this reads as "the long-press does nothing at all", with zero
// feedback. The gesture state lives here instead, bound once at the document
// level, and resolves the pressed row per event via closest(), so rebuilds
// under a still finger no longer cancel the hold. Threshold, tolerance and
// the arm-on-threshold/open-on-lift contract match bindSidebarLongPress,
// which remains for elements that are not rebuilt per render (project
// folder heads).
const SESSION_ROW_LONG_PRESS_MS = 2000;
const SESSION_ROW_MOVE_TOLERANCE_PX = 24;

let sessionRowHold = null;
let sessionRowClickGuard = false;
let sessionRowLongPressDelegationBound = false;

function isDesktopViewportWidth() {
  return window.matchMedia?.("(min-width: 768px)")?.matches === true;
}

function findSessionRowFromEvent(event) {
  const target = event.target;
  return target instanceof Element ? target.closest(".session-item") : null;
}

function cancelSessionRowHold() {
  if (sessionRowHold?.timer) window.clearTimeout(sessionRowHold.timer);
  sessionRowHold?.row?.classList.remove("is-pressing", "is-long-press");
  sessionRowHold = null;
  sessionRowClickGuard = false;
}

function openSessionRowContextMenu(session, fallbackRow) {
  if (!session || typeof openSessionContextMenu !== "function") return;
  // Re-anchor to the row currently in the DOM for this session: the pressed
  // element may have been replaced by a list rebuild during the hold.
  let anchor = fallbackRow;
  if (session.id) {
    anchor = document.querySelector(
      `.session-item[data-session-id="${CSS.escape(String(session.id))}"]`,
    ) || fallbackRow;
  }
  openSessionContextMenu(session, anchor);
}

function ensureSessionListLongPressDelegation() {
  if (sessionRowLongPressDelegationBound) return;
  sessionRowLongPressDelegationBound = true;

  document.addEventListener("pointerdown", (event) => {
    // Same gates as the per-row binder: desktop rows use the native context
    // menu, and only touch holds arm the sheet.
    if (isDesktopViewportWidth() || event.pointerType === "mouse") return;
    if (event.pointerType && event.pointerType !== "touch") return;
    if (event.button && event.button !== 0) return;
    const row = findSessionRowFromEvent(event);
    const session = row?.__ragentSessionModel;
    if (!row || !session) return;
    cancelSessionRowHold();
    sessionRowHold = {
      row,
      session,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      armed: false,
    };
    row.classList.add("is-pressing");
    sessionRowHold.timer = window.setTimeout(() => {
      if (!sessionRowHold) return;
      sessionRowHold.timer = 0;
      sessionRowHold.armed = true;
      // Arm on threshold, open on lift: the row deepens into the long-press
      // wash (plus a haptic tick), the sheet only appears once the finger is
      // up and the row has restored.
      sessionRowHold.row.classList.remove("is-pressing");
      sessionRowHold.row.classList.add("is-long-press");
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate(12); } catch {}
      }
    }, SESSION_ROW_LONG_PRESS_MS);
  });

  document.addEventListener("pointermove", (event) => {
    if (!sessionRowHold || !sessionRowHold.timer) return;
    const dx = event.clientX - sessionRowHold.startX;
    const dy = event.clientY - sessionRowHold.startY;
    if (dx * dx + dy * dy > SESSION_ROW_MOVE_TOLERANCE_PX * SESSION_ROW_MOVE_TOLERANCE_PX) {
      cancelSessionRowHold();
      return;
    }
    // The pressed row may have been replaced by a background list rebuild
    // under the finger. Keep the hold on whichever element now carries this
    // session; if the finger now rests over a different row, it is over.
    const row = findSessionRowFromEvent(event);
    if (!row || row === sessionRowHold.row) return;
    if (row.getAttribute("data-session-id") === sessionRowHold.row.getAttribute("data-session-id")) {
      sessionRowHold.row.classList.remove("is-pressing", "is-long-press");
      row.classList.add("is-pressing");
      sessionRowHold.row = row;
      sessionRowHold.session = row.__ragentSessionModel || sessionRowHold.session;
      return;
    }
    cancelSessionRowHold();
  });

  const finishSessionRowHold = () => {
    if (!sessionRowHold) return;
    // After the threshold the hold is armed; if the platform claims the pan
    // right then, the gesture ends with pointercancel/touchcancel and
    // pointerup never fires — treat that cancel as the lift so an armed hold
    // still opens (same contract as the per-row binder).
    const armed = sessionRowHold.armed && !sessionRowHold.timer;
    const { session, row } = sessionRowHold;
    cancelSessionRowHold();
    if (armed) {
      sessionRowClickGuard = true;
      window.setTimeout(() => { sessionRowClickGuard = false; }, 500);
      openSessionRowContextMenu(session, row);
    }
  };
  document.addEventListener("pointerup", finishSessionRowHold);
  document.addEventListener("pointercancel", finishSessionRowHold);
  document.addEventListener("touchcancel", finishSessionRowHold);

  // Non-passive on purpose: a real finger always drifts a few pixels during
  // a two-second hold. Once that drift crosses the platform's scroll slop the
  // browser claims the pan and fires pointercancel — the press dies long
  // before the (deliberately slow) threshold and the sheet never opens on
  // phones. While the drift stays inside the tolerance, block the pan so the
  // gesture stays ours; past it we release it and the list scrolls as usual.
  document.addEventListener("touchmove", (event) => {
    if (!sessionRowHold) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    const dx = touch.clientX - sessionRowHold.startX;
    const dy = touch.clientY - sessionRowHold.startY;
    if (dx * dx + dy * dy > SESSION_ROW_MOVE_TOLERANCE_PX * SESSION_ROW_MOVE_TOLERANCE_PX) return;
    if (event.cancelable && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("contextmenu", (event) => {
    const row = findSessionRowFromEvent(event);
    if (!row) return;
    // Mobile browsers may emit contextmenu during a touch hold. Suppress the
    // browser menu; the explicit two-second timer owns the action sheet.
    const touchContextMenu = event.pointerType === "touch"
      || event.sourceCapabilities?.firesTouchEvents === true;
    const rightClick = !touchContextMenu && event.button === 2;
    event.preventDefault();
    if (!rightClick) return;
    cancelSessionRowHold();
    openSessionRowContextMenu(row.__ragentSessionModel, row);
  });

  // A long-press must not synthesize a navigation click on pointerup; the
  // guard also survives the row being replaced between the lift and the
  // click, because it is checked at the document level in capture phase.
  document.addEventListener("click", (event) => {
    if (!sessionRowClickGuard) return;
    if (!findSessionRowFromEvent(event)) return;
    sessionRowClickGuard = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function createActiveSessionItem(session, { showGroup = false } = {}) {
  const statusInfo = getSessionMetaStatusInfo(session);
  const statusItemClass = getSessionStatusItemClass(statusInfo);
  const runStateItemClass = getSessionRunStateItemClass(session);
  const completeRead = isSessionCompleteAndReviewed(session);
  const indicatorInfo = getSessionListIndicatorInfo(session);
  const button = document.createElement("button");
  button.type = "button";
  // Stable id for FLIP reorder matching across full-list rebuilds. The id is
  // read back via getAttribute on re-render; harmless for project-view items.
  if (typeof session?.id === "string" && session.id) {
    button.setAttribute("data-session-id", session.id);
    // Current row model for the delegated long-press (see
    // ensureSessionListLongPressDelegation): rebuilt rows carry fresh data,
    // so a hold that survives a rebuild re-anchors to up-to-date state.
    button.__ragentSessionModel = session;
  }
  button.className =
    "session-item"
    + (session.pinned ? " pinned" : "")
    + (session.id === currentSessionId ? " active" : "")
    + (completeRead ? " is-complete-read" : "")
    + (statusItemClass ? ` ${statusItemClass}` : "")
    + (runStateItemClass ? ` ${runStateItemClass}` : "")
    + (statusInfo.itemClass ? ` ${statusInfo.itemClass}` : "");

  const displayName = getSessionDisplayName(session);
  const updatedTime = formatSessionUpdatedTime(session);
  const updatedTimeMarkup = updatedTime
    ? `<time class="session-item-time" datetime="${esc(getSessionUpdatedStamp(session))}" title="${esc(t("sidebar.sessionUpdated", { time: updatedTime }))}">${esc(updatedTime)}</time>`
    : `<span class="session-item-time" aria-hidden="true"></span>`;
  const indicatorMarkup = indicatorInfo
    ? `<span class="session-item-status ${esc(indicatorInfo.className)}" title="${esc(indicatorInfo.title)}" aria-label="${esc(indicatorInfo.label)}"></span>`
    : `<span class="session-item-status" aria-hidden="true"></span>`;
  void showGroup;

  button.innerHTML = `
    <span class="session-item-info">
      <span class="session-item-name" title="${esc(displayName)}">${esc(displayName)}</span>
    </span>
    ${updatedTimeMarkup}
    ${indicatorMarkup}`;

  // Route every click through the navigation coordinator. The row can be
  // rendered from a fresh sidebar snapshot a few milliseconds before the
  // canonical sessions array is replaced, so pass the exact row model as the
  // optimistic target while the coordinator owns the async generation guard.
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (typeof navigateToSession === "function") {
      void navigateToSession(session.id, {
        session,
        tab: "sessions",
        historyMode: "push",
      }).catch((error) => {
        console.warn("[sessions] Failed to navigate to clicked session:", error?.message || error);
      });
    } else if (typeof attachSession === "function") {
      attachSession(session.id, session);
      if (typeof syncBrowserState === "function") {
        syncBrowserState({ sessionId: session.id, tab: "sessions", historyMode: "push" });
      }
    } else if (typeof applyNavigationState === "function") {
      // Legacy/fixture fallback: keep the existing navigation contract when
      // attachSession is not present in a reduced runtime.
      applyNavigationState({ sessionId: session.id, tab: "sessions" });
    }
    if (!isDesktop && typeof closeSidebarFn === "function") closeSidebarFn();
  });

  // The long-press is bound once at the document level (delegation); rows
  // only carry the model + id above. A per-row binding here would die with
  // the element on the next list rebuild.
  ensureSessionListLongPressDelegation();

  return button;
}
