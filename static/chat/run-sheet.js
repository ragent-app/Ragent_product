"use strict";

// Run Sheet — the single run-detail surface. It is a bottom sheet on mobile and
// a modal on desktop, backed by the dedicated lightweight run-sheet projection.
(function attachRunSheet(root) {
  if (root.__ragentRunSheetAttached === true) return;
  root.__ragentRunSheetAttached = true;
  const MAX_FILES = 8;
  const MAX_FILES_DETAILED = 16;
  const BACKGROUND_REFRESH_DELAY_MS = 140;
  const BACKGROUND_MIN_INTERVAL_MS = 1000;
  const BACKGROUND_RUNNING_POLL_MS = 10000;
  const BACKGROUND_IDLE_POLL_MS = 30000;
  const MODEL_CACHE_LIMIT = 12;
  const MODEL_CACHE_MAX_AGE_MS = 5000;
  // Push is the primary update channel (RagentRunActivity / chat store
  // subscriptions refresh immediately on new activity). The model also stays
  // warm while the sheet is closed: entering a conversation preloads the
  // projection in the background and update hooks keep landing, so opening
  // the sheet paints cached content instead of waiting on a fetch-and-rebuild
  // cycle. These polls are a disconnected/fallback safety net only — frequent
  // polling made the sheet visibly flicker as it re-fetched and rebuilt every
  // cycle while open.

  // Android back button: registered while the sheet is open. The reader
  // (a layer inside the sheet) collapses first, mirroring the Escape order.
  let backEntryId = null;
  function registerBackEntry() {
    backEntryId = window.RagentBackHandler?.push?.({
      id: "run-sheet",
      onBack: () => {
        if (state.readerOpen) {
          closeMarkdownPreview();
          return true;
        }
        close();
        return true;
      },
    }) || null;
  }
  function unregisterBackEntry() {
    if (!backEntryId) return;
    window.RagentBackHandler?.pop?.(backEntryId);
    backEntryId = null;
  }

  const state = {
    open: false,
    expanded: false,
    dragging: false,
    moved: false,
    dragPointerId: null,
    dragStartY: 0,
    dragStartHeight: 0,
    requestSeq: 0,
    targetSessionId: "",
    modelState: "empty",
    model: null,
    error: "",
    readerOpen: false,
    readerRequestSeq: 0,
  };

  const dom = {
    backdrop: null,
    sheet: null,
    launchButton: null,
    handleZone: null,
    closeBtn: null,
    content: null,
    reader: null,
    readerTitle: null,
    readerStatus: null,
    readerContent: null,
    readerRawLink: null,
    readerDownloadLink: null,
  };

  let unsubscribeActivity = null;
  let unsubscribeStore = null;
  let unsubscribeMotion = null;
  let lastFocusedElement = null;
  let focusScopeDeactivate = null;
  let readerFocusScopeDeactivate = null;
  let readerTrigger = null;
  let snapTimer = null;
  let motionTimer = null;
  let dragFrame = null;
  let pendingDragHeight = null;
  let refreshTimer = null;
  let backgroundPollTimer = null;
  let refreshInFlight = null;
  let pendingRefreshOptions = null;
  let lastBackgroundRefreshAt = 0;
  const modelCache = new Map();
  const terminalSessionRefreshes = new Set();

  function tr(key, vars = {}) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fileName(path) {
    const p = String(path || "");
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function toneForStatus(key) {
    switch (key) {
      case "running": return "running";
      case "waiting_user": return "waiting";
      case "done": return "done";
      case "failed": return "failed";
      case "queued":
      case "uploading":
      case "sending":
      case "checking":
      case "processing":
      case "compacting":
        return "queued";
      default: return "idle";
    }
  }

  function open() {
    if (state.open) return;
    if (motionTimer) {
      clearTimeout(motionTimer);
      motionTimer = null;
    }
    state.open = true;
    state.expanded = true;
    lastFocusedElement = document.activeElement;
    syncDOM();
    dom.sheet.classList.remove("run-sheet--closing");
    dom.sheet.classList.add("run-sheet--opening");
    motionTimer = setTimeout(() => {
      motionTimer = null;
      dom.sheet?.classList.remove("run-sheet--opening");
    }, 230);
    focusScopeDeactivate = root.RagentFocusScope?.activate?.(dom.sheet, {
      containmentRoot: dom.sheet,
      initialFocus: dom.closeBtn,
      restoreFocus: () => lastFocusedElement,
      modal: false,
      onEscape: () => {
        if (state.readerOpen) closeMarkdownPreview();
        else close();
      },
    }) || null;
    renderResolvedContent();
    scheduleContentRefresh({ forceFresh: true, delay: 0 });
    // Move focus into the dialog so keyboard/screen-reader users land inside.
    requestAnimationFrame(() => dom.closeBtn?.focus?.());
    registerBackEntry();
  }

  function close() {
    if (!state.open) return;
    if (motionTimer) {
      clearTimeout(motionTimer);
      motionTimer = null;
    }
    state.open = false;
    if (state.readerOpen) {
      closeMarkdownPreview();
    }
    unregisterBackEntry();
    // Keep the background cadence alive after closing: only the immediate
    // open-state refresh is cancelled, and the next background poll is armed
    // so the cached model stays warm for the next open.
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    pendingRefreshOptions = null;
    if (focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
    }
    syncDOM();
    dom.sheet.classList.remove("run-sheet--opening");
    dom.sheet.classList.add("run-sheet--closing");
    motionTimer = setTimeout(() => {
      motionTimer = null;
      dom.sheet?.classList.remove("run-sheet--closing");
    }, 190);
    scheduleBackgroundPoll();
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  }

  function toggleExpanded() {
    state.expanded = !state.expanded;
    syncDOM();
    // Expanded reveals more of the real activity, so re-render at the new caps.
    renderContent();
  }

  function syncDOM() {
    if (!dom.backdrop || !dom.sheet) return;
    dom.backdrop.classList.toggle("run-sheet-backdrop--visible", state.open || state.readerOpen);
    dom.sheet.classList.toggle("run-sheet--open", state.open);
    dom.sheet.classList.toggle("run-sheet--compact", state.open && !state.expanded);
    dom.sheet.classList.toggle("run-sheet--expanded", state.open && state.expanded);
    // When closed the sheet stays in the DOM (translated off-screen for the
    // slide animation), so hide it from assistive tech and the tab order.
    dom.sheet.setAttribute("aria-hidden", state.open ? "false" : "true");
    if (state.open) {
      dom.sheet.removeAttribute("inert");
    } else {
      dom.sheet.setAttribute("inert", "");
    }
    dom.launchButton?.setAttribute("aria-expanded", state.open ? "true" : "false");
  }

  function syncLaunchButton() {
    if (!dom.launchButton) return;
    dom.launchButton.hidden = !resolveRunSheetTargetSession()?.id;
  }

  function handleKeydown(event) {
    if (!state.open && !state.readerOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.readerOpen) {
        closeMarkdownPreview();
      } else {
        close();
      }
    }
  }

  function visualStatus(session) {
    const model = root.RagentSessionStateModel;
    if (model && typeof model.getSessionVisualStatus === "function") {
      try {
        return model.getSessionVisualStatus(session, {}) || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function normalizeActivity(session) {
    const model = root.RagentSessionStateModel;
    if (model && typeof model.normalizeSessionActivity === "function") {
      try {
        return model.normalizeSessionActivity(session || {});
      } catch {
        return {};
      }
    }
    return session?.activity || {};
  }

  function isRunningSession(session) {
    return normalizeActivity(session)?.run?.state === "running";
  }

  function reconcileTerminalSessionSnapshot(sessionId, projectedSession) {
    const id = String(sessionId || "").trim();
    if (!id || id !== String(currentSessionId || "").trim()) return false;
    const localSession = knownSessions().find((entry) => String(entry?.id || "") === id);
    if (!localSession || !isRunningSession(localSession)) return false;
    if (!projectedSession || String(projectedSession.id || "") !== id) return false;

    const projectedRun = normalizeActivity(projectedSession)?.run || {};
    if (projectedRun.state === "running") return false;
    const activeRun = normalizeActivity(localSession)?.run || {};
    const activeRunId = String(activeRun.runId || activeRun.id || "").trim();
    const projectedRunId = String(projectedRun.runId || projectedRun.id || "").trim();
    if (activeRunId && projectedRunId && activeRunId !== projectedRunId) return false;
    if (terminalSessionRefreshes.has(id) || typeof root.refreshCurrentSession !== "function") return false;

    // The detail projection and composer read separate client models. If this
    // authoritative snapshot says the current run is over, refresh the full
    // session snapshot so the stop button and live-message presentation settle
    // from the same session state. A mismatched run id is ignored above to
    // avoid an older projection clearing a newer run.
    terminalSessionRefreshes.add(id);
    Promise.resolve(root.refreshCurrentSession({ forceFresh: true, essential: true }))
      .catch((error) => {
        console.warn("[run-sheet] Failed to reconcile terminal session state:", error?.message || error);
      })
      .finally(() => terminalSessionRefreshes.delete(id));
    return true;
  }

  function sessionSortTime(session) {
    const model = root.RagentSessionStateModel;
    if (model && typeof model.getSessionSortTime === "function") {
      try {
        return model.getSessionSortTime(session || {});
      } catch {
        return 0;
      }
    }
    const stamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt")
      ? (session?.lastActivityAt ?? session?.updatedAt ?? session?.created ?? "")
      : (session?.lastEventAt || session?.updatedAt || session?.created || "");
    const parsed = new Date(stamp).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function knownSessions() {
    if (typeof getChatStoreStateSnapshot === "function") {
      const snapshot = getChatStoreStateSnapshot();
      if (Array.isArray(snapshot?.sessions)) return snapshot.sessions;
    }
    if (typeof sessions !== "undefined" && Array.isArray(sessions)) return sessions;
    return [];
  }

  function resolveRunSheetTargetSession() {
    const candidates = knownSessions()
      .filter((session) => session && session.isInternalSession !== true);
    // The Run Sheet is opened from the Live Bar, which tracks the conversation
    // the user is currently viewing. Pin to that conversation so the sheet shows
    // THIS chat's status / plan / docs / files — not whatever background session
    // happens to be running or most recent globally. Without this pin, a running
    // background child session would take over the sheet, surfacing another
    // session's content and hiding the current conversation's documents.
    const currentId = typeof currentSessionId !== "undefined"
      ? String(currentSessionId || "").trim()
      : "";
    if (currentId) {
      const current = candidates.find((session) => String(session?.id || "") === currentId);
      if (current) return current;
      // The current conversation isn't in the local catalog yet (e.g. just
      // opened via a deep link). Still pin to it so the sheet fetches its own
      // data instead of jumping to a different session.
      return { id: currentId };
    }
    const running = candidates
      .filter(isRunningSession)
      .sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
    if (running.length > 0) return running[0];
    const active = candidates
      .filter((session) => session.archived !== true)
      .sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
    return active[0] || candidates.slice().sort((a, b) => sessionSortTime(b) - sessionSortTime(a))[0] || null;
  }

  function isCurrentAttachedSession(session) {
    return !!session?.id
      && typeof currentSessionId !== "undefined"
      && session.id === currentSessionId;
  }

  function isProgressPlan(artifact) {
    if (!Array.isArray(artifact?.items) || artifact.items.length === 0) return false;
    const planIntent = String(artifact?.planIntent || "").trim().toLowerCase();
    if (planIntent) return planIntent === "progress";
    return String(artifact?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  function selectProgressPlan(model) {
    const plans = (model.artifacts || []).filter(isProgressPlan);
    if (plans.length === 0) return null;
    const activeRunId = activeRunningRunId(model);
    if (activeRunId) {
      return findLatestPlanForRun(plans, activeRunId);
    }
    const latestRunId = latestEventRunId(model);
    if (latestRunId) {
      return findLatestPlanForRun(plans, latestRunId);
    }
    const latestPlanRun = latestPlanRunId(plans);
    if (latestPlanRun) {
      return findLatestPlanForRun(plans, latestPlanRun);
    }
    return latestPlanWithoutRunBoundary(plans);
  }

  function eventBoundary(event) {
    for (const key of ["endSeq", "blockEndSeq", "mergedEndSeq", "seq"]) {
      if (Number.isInteger(event?.[key]) && event[key] > 0) return event[key];
    }
    return 0;
  }

  function planBoundary(plan) {
    return Number.isInteger(plan?.seq) && plan.seq > 0 ? plan.seq : 0;
  }

  function planRunId(plan) {
    return String(plan?.sourceRunId || "").trim();
  }

  function activeRunningRunId(model) {
    const activity = normalizeActivity(model?.session);
    if (activity?.run?.state !== "running") return "";
    return String(activity?.run?.runId || "").trim();
  }

  function latestEventRunId(model) {
    const events = Array.isArray(model?.events) ? model.events : [];
    const ordered = events.slice().sort((a, b) => eventBoundary(b) - eventBoundary(a));
    for (const event of ordered) {
      const runId = String(event?.runId || "").trim();
      if (runId) return runId;
    }
    return "";
  }

  function findLatestPlanForRun(plans, runId) {
    const targetRunId = String(runId || "").trim();
    if (!targetRunId) return null;
    return plans
      .filter((plan) => planRunId(plan) === targetRunId)
      .sort((a, b) => planBoundary(b) - planBoundary(a))[0] || null;
  }

  function latestPlanRunId(plans) {
    const latestPlan = plans
      .filter((plan) => planRunId(plan))
      .sort((a, b) => planBoundary(b) - planBoundary(a))[0] || null;
    return planRunId(latestPlan);
  }

  function latestPlanWithoutRunBoundary(plans) {
    return plans
      .filter((plan) => !planRunId(plan))
      .sort((a, b) => planBoundary(b) - planBoundary(a))[0] || null;
  }

  function modelSessionId(model) {
    return String(model?.session?.id || state.targetSessionId || "").trim();
  }

  function artifactSessionId(artifact) {
    return String(artifact?.sessionId || "").trim();
  }

  function scopedMarkdownArtifacts(model) {
    const targetSessionId = modelSessionId(model);
    return (model?.artifactFiles || [])
      .filter(isMarkdownArtifact)
      .filter((artifact) => {
        const sessionId = artifactSessionId(artifact);
        return !targetSessionId || !sessionId || sessionId === targetSessionId;
      });
  }

  function planItemText(item) {
    if (typeof item === "string") return item.trim();
    return String(item?.text || item?.title || item?.step || "").trim();
  }

  function planItemStatus(item) {
    const status = String(item?.status || item?.state || (item?.completed === true ? "completed" : "pending"))
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
    if (["in_progress", "active", "current", "running", "started"].includes(status)) return "in_progress";
    return "pending";
  }

  function renderPlanDetails(items, currentText) {
    const rows = items.map((item) => {
      const status = planItemStatus(item);
      const text = planItemText(item) || tr("plan.progress.empty");
      return `<li class="run-sheet__plan-item run-sheet__plan-item--${esc(status)}">
        <span class="run-sheet__plan-marker" aria-hidden="true"></span>
        <span class="run-sheet__plan-item-text">${esc(text)}</span>
      </li>`;
    }).join("");
    // Chevron: right when collapsed, down when expanded (user-set direction).
    const chevronCollapsed = root.RagentIcons?.render?.("chevron-right", {
      className: "run-sheet__plan-chevron-icon",
    }) || "";
    const chevronExpanded = root.RagentIcons?.render?.("chevron-down", {
      className: "run-sheet__plan-chevron-icon",
    }) || "";
    return `<details class="run-sheet__plan-details">
      <summary class="run-sheet__plan-current">
        <span class="run-sheet__plan-current-text">${esc(currentText)}</span>
        <span class="run-sheet__plan-chevron" aria-hidden="true">
          <span class="run-sheet__plan-chevron-collapsed">${chevronCollapsed}</span>
          <span class="run-sheet__plan-chevron-expanded">${chevronExpanded}</span>
        </span>
      </summary>
      <ol class="run-sheet__plan-list">${rows}</ol>
    </details>`;
  }

  function isMarkdownArtifact(artifact) {
    if (artifact?.isMarkdown === true) return true;
    if (/^text\/(?:x-)?markdown(?:[;\s]|$)/i.test(String(artifact?.mimeType || "").trim())) return true;
    return /\.(?:md|markdown|mdown|mkdn)$/i.test(String(artifact?.name || "").trim());
  }

  function buildDownloadUrl(artifact) {
    const explicit = String(artifact?.downloadUrl || "").trim();
    if (explicit) return explicit;
    const source = String(artifact?.url || "").trim();
    if (!source) return "";
    const separator = source.includes("?") ? "&" : "?";
    return `${source}${separator}download=1`;
  }

  function projectionUrl(sessionId, forceFresh = false) {
    const base = typeof root.ragentResolveProductPath === "function"
      ? root.ragentResolveProductPath(`api/sessions/${encodeURIComponent(sessionId)}/run-sheet`)
      : `/api/sessions/${encodeURIComponent(sessionId)}/run-sheet`;
    if (!forceFresh) return base;
    return `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`;
  }

  function modelFromRunSheet(payload, fallbackSession) {
    const view = payload?.runSheet && typeof payload.runSheet === "object" ? payload.runSheet : payload;
    if (!view || typeof view !== "object") return null;
    const progressPlan = view.progressPlan && typeof view.progressPlan === "object" ? view.progressPlan : null;
    return {
      session: view.session || payload?.session || fallbackSession,
      events: [],
      artifacts: progressPlan ? [progressPlan] : [],
      progressPlans: progressPlan ? [progressPlan] : [],
      artifactFiles: Array.isArray(view.artifactFiles) ? view.artifactFiles : [],
      files: Array.isArray(view.changedFiles) ? view.changedFiles : [],
      sourceLatestSeq: view.sourceLatestSeq || 0,
      projectionStale: view.projectionStale === true,
    };
  }

  async function fetchRunSheetModel(target, { forceFresh = false } = {}) {
    const url = projectionUrl(target.id, forceFresh);
    const requestOptions = {
      credentials: "same-origin",
      ...(forceFresh ? { cache: "no-store" } : { cacheMaxAgeMs: MODEL_CACHE_MAX_AGE_MS }),
      headers: { Accept: "application/json" },
    };
    const payload = typeof root.fetchJsonOrRedirect === "function"
      ? await root.fetchJsonOrRedirect(url, requestOptions)
      : await (root.ragentFetch || fetch)(url, requestOptions).then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText || ""}`.trim());
        return response.json();
      });
    const model = modelFromRunSheet(payload, target);
    reconcileTerminalSessionSnapshot(target.id, model?.session);
    return model;
  }

  function renderMarkdownInto(container, markdown) {
    if (!container) return;
    container.innerHTML = "";
    if (typeof root.renderMarkdownIntoNode === "function") {
      root.renderMarkdownIntoNode(container, String(markdown || ""));
      return;
    }
    if (root.marked?.parse) {
      container.innerHTML = root.marked.parse(String(markdown || ""));
      if (typeof root.enhanceRenderedContentLinks === "function") {
        root.enhanceRenderedContentLinks(container);
      }
      return;
    }
    container.textContent = String(markdown || "");
  }

  function renderNow(model) {
    const status = visualStatus(model.session);
    const tone = toneForStatus(status?.key);
    const liveSummary = isCurrentAttachedSession(model.session) && isRunningSession(model.session)
      ? (root.RagentRunActivity?.getPresentation?.()?.text || "")
      : "";
    const label = esc(liveSummary || status?.label || tr("runSheet.now"));
    return `
      <section class="run-sheet__now">
        <span class="run-sheet__now-dot run-sheet__now-dot--${tone}" aria-hidden="true"></span>
        <div class="run-sheet__now-text">
          <div class="run-sheet__now-label">${label}</div>
        </div>
      </section>`;
  }

  function renderPlan(model) {
    const plan = selectProgressPlan(model);
    if (!plan) return "";
    const items = plan.items;
    const completed = items.filter((i) => i?.status === "completed").length;
    const total = items.length;
    const current = items.find((i) => i?.status !== "completed");
    const ratio = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
    const currentText = `${completed}/${total} · ${current ? (planItemText(current) || tr("plan.progress.empty")) : tr("plan.status.completed")}`;
    return `
      <section class="run-sheet__section run-sheet__section--plan">
        <div class="run-sheet__section-head">
          <h3 class="run-sheet__section-title">${esc(tr("runSheet.plan"))}</h3>
          <span class="run-sheet__section-meta">${completed}/${total}</span>
        </div>
        <div class="run-sheet__progress" role="progressbar"
          aria-valuenow="${ratio}" aria-valuemin="0" aria-valuemax="100">
          <span class="run-sheet__progress-fill" style="--run-sheet-progress:${ratio / 100}"></span>
        </div>
        ${renderPlanDetails(items, currentText)}
      </section>`;
  }

  function renderMarkdownFiles(model) {
    const artifacts = scopedMarkdownArtifacts(model);
    if (!artifacts.length) return "";
    const rows = artifacts.map((artifact) => {
      const name = String(artifact.name || "").trim() || "Markdown";
      const url = String(artifact.url || "").trim();
      const sessionId = artifactSessionId(artifact);
      const artifactFileId = String(artifact.id || artifact.artifactFileId || "").trim();
      const meta = [artifact.mimeType, artifact.sizeBytes ? `${Math.round(artifact.sizeBytes / 1024)} KB` : ""]
        .filter(Boolean)
        .join(" / ");
      return `<li class="run-sheet__md-file">
        <button type="button" class="run-sheet__md-button"
          data-action="open-markdown"
          data-markdown-artifact-url="${esc(url)}"
          data-markdown-artifact-name="${esc(name)}"
          data-artifact-file-id="${esc(artifactFileId)}"
          data-markdown-artifact-session-id="${esc(sessionId)}"
          data-markdown-artifact-download-url="${esc(buildDownloadUrl(artifact))}">
          <span class="run-sheet__md-main">
            <span class="run-sheet__md-name" title="${esc(name)}">${esc(name)}</span>
            ${meta ? `<span class="run-sheet__md-meta">${esc(meta)}</span>` : ""}
          </span>
          <span class="run-sheet__md-badge">${esc(tr("workbench.markdown.badge"))}</span>
        </button>
      </li>`;
    }).join("");
    return `
      <section class="run-sheet__section run-sheet__section--markdown">
        <div class="run-sheet__section-head"><h3 class="run-sheet__section-title">${esc(tr("runSheet.markdownFiles"))}</h3></div>
        <ul class="run-sheet__list run-sheet__md-list">${rows}</ul>
      </section>`;
  }

  function renderFiles(model) {
    const files = (model.files || []).slice(0, state.expanded ? MAX_FILES_DETAILED : MAX_FILES);
    if (!files.length) return "";
    const rows = files.map((f) => {
      const hasStats = f.hasLineStats !== false && ((f.added || 0) > 0 || (f.removed || 0) > 0);
      const stats = hasStats
        ? `<span class="run-sheet__stats"><span class="run-sheet__add">+${f.added || 0}</span><span class="run-sheet__del">−${f.removed || 0}</span></span>`
        : "";
      return `<li class="run-sheet__file">
        <span class="run-sheet__file-name" title="${esc(f.filePath || "")}">${esc(fileName(f.filePath))}</span>
        ${stats}
      </li>`;
    }).join("");
    return `
      <section class="run-sheet__section run-sheet__section--files">
        <div class="run-sheet__section-head"><h3 class="run-sheet__section-title">${esc(tr("runSheet.files"))}</h3></div>
        <ul class="run-sheet__list">${rows}</ul>
      </section>`;
  }

  function renderStream(model) {
    const body = [renderNow(model), renderPlan(model), renderMarkdownFiles(model), renderFiles(model)].join("");
    // Now is always rendered when there is a session, so an empty body only
    // happens before any event arrives.
    if (!body.trim()) {
      return `<div class="run-sheet__hint">${esc(tr("runSheet.noActivity"))}</div>`;
    }
    return body;
  }

  function renderResolvedContent() {
    if (!dom.content || !state.open) return;
    if (state.modelState === "loading") {
      dom.content.innerHTML = `<div class="run-sheet__hint">${esc(tr("workbench.loading"))}</div>`;
      return;
    }
    if (!state.model || state.modelState !== "content") {
      dom.content.innerHTML = `<div class="run-sheet__hint">${esc(tr("runSheet.empty"))}</div>`;
      return;
    }
    // A rebuild must not reset user-opened disclosure state (the plan
    // <details> collapses on its own after every refresh otherwise).
    // Plan details is the only <details> in the stream today; track open
    // indices so the restore stays correct if more appear later.
    const openDetails = Array.from(dom.content.querySelectorAll("details"))
      .map((el, index) => (el.open ? index : -1))
      .filter((index) => index >= 0);
    dom.content.innerHTML = renderStream(state.model);
    if (openDetails.length > 0) {
      const details = Array.from(dom.content.querySelectorAll("details"));
      for (const index of openDetails) {
        const el = details[index];
        if (el) el.open = true;
      }
    }
    bindStreamHandlers();
  }

  function cacheModel(sessionId, model) {
    const id = String(sessionId || model?.session?.id || "").trim();
    if (!id || !model) return;
    modelCache.delete(id);
    modelCache.set(id, { model, cachedAt: Date.now() });
    while (modelCache.size > MODEL_CACHE_LIMIT) {
      modelCache.delete(modelCache.keys().next().value);
    }
  }

  function adoptCachedModel(sessionId) {
    const id = String(sessionId || "").trim();
    const cachedEntry = id ? modelCache.get(id) : null;
    const cached = cachedEntry?.model || null;
    state.targetSessionId = id;
    state.model = cached || null;
    state.modelState = cached ? "content" : "loading";
    state.error = "";
    if (cached) {
      modelCache.delete(id);
      modelCache.set(id, cachedEntry);
    }
    renderResolvedContent();
    return cached;
  }

  function syncMarkdownPreviewDOM() {
    if (!dom.reader) return;
    dom.reader.hidden = !state.readerOpen;
    dom.reader.setAttribute("aria-hidden", state.readerOpen ? "false" : "true");
    if (state.readerOpen) {
      dom.reader.removeAttribute("inert");
    } else {
      dom.reader.setAttribute("inert", "");
    }
  }

  function setMarkdownPreviewStatus(message, kind = "") {
    if (!dom.readerStatus) return;
    dom.readerStatus.textContent = message || "";
    dom.readerStatus.hidden = !message;
    dom.readerStatus.dataset.kind = kind;
  }

  function closeMarkdownPreview() {
    if (!state.readerOpen && !dom.reader) return;
    if (readerFocusScopeDeactivate) {
      readerFocusScopeDeactivate();
      readerFocusScopeDeactivate = null;
    }
    state.readerOpen = false;
    state.readerRequestSeq += 1;
    dom.reader?.classList.remove("run-sheet__reader--opening");
    dom.reader?.classList.add("run-sheet__reader--closing");
    setTimeout(() => {
      if (!state.readerOpen && dom.reader) {
        dom.reader.classList.remove("run-sheet__reader--closing");
        syncMarkdownPreviewDOM();
      }
    }, 200);
    if (!state.open) {
      dom.backdrop?.classList.remove("run-sheet-backdrop--visible");
      unregisterBackEntry();
    }
  }

  async function openMarkdownPreview({ url, name, downloadUrl }) {
    const sourceUrl = String(url || "").trim();
    if (!sourceUrl || !dom.reader) return false;
    const requestSeq = state.readerRequestSeq + 1;
    state.readerRequestSeq = requestSeq;
    readerTrigger = document.activeElement;
    state.readerOpen = true;
    if (dom.readerTitle) {
      dom.readerTitle.textContent = String(name || "").trim() || tr("workbench.markdown.readerTitle");
    }
    if (dom.readerRawLink) dom.readerRawLink.href = sourceUrl;
    if (dom.readerDownloadLink) {
      const resolvedDownloadUrl = String(downloadUrl || "").trim() || buildDownloadUrl({ url: sourceUrl });
      dom.readerDownloadLink.href = resolvedDownloadUrl;
      dom.readerDownloadLink.hidden = !resolvedDownloadUrl;
    }
    if (dom.readerContent) dom.readerContent.innerHTML = "";
    setMarkdownPreviewStatus(tr("workbench.markdown.loading"));
    syncMarkdownPreviewDOM();
    dom.reader.classList.remove("run-sheet__reader--closing");
    dom.reader.classList.add("run-sheet__reader--opening");
    dom.backdrop?.classList.add("run-sheet-backdrop--visible");
    registerBackEntry();
    readerFocusScopeDeactivate = root.RagentFocusScope?.activate?.(dom.reader, {
      containmentRoot: dom.reader,
      initialFocus: () => dom.reader?.querySelector?.("[data-run-sheet-reader-close]"),
      restoreFocus: () => readerTrigger,
      modal: false,
      onEscape: () => closeMarkdownPreview(),
    }) || null;
    try {
      const response = await (root.ragentFetch || fetch)(sourceUrl, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (requestSeq !== state.readerRequestSeq) return true;
      if (!response.ok) throw new Error(`${response.status} ${response.statusText || ""}`.trim());
      const markdown = await response.text();
      if (requestSeq !== state.readerRequestSeq) return true;
      setMarkdownPreviewStatus("");
      renderMarkdownInto(dom.readerContent, markdown);
    } catch (error) {
      if (requestSeq !== state.readerRequestSeq) return true;
      setMarkdownPreviewStatus(tr("workbench.markdown.failed"), "error");
      if (dom.readerContent) dom.readerContent.textContent = error?.message || "";
    }
    return true;
  }

  function findMarkdownArtifactById(artifactFileId) {
    const targetId = String(artifactFileId || "").trim();
    if (!targetId) return null;
    return scopedMarkdownArtifacts(state.model)
      .find((artifact) => String(artifact?.id || artifact?.artifactFileId || "").trim() === targetId) || null;
  }

  async function openMarkdownReaderFromArtifact({ artifactFileId, url = "", name = "", downloadUrl = "" } = {}) {
    const artifact = findMarkdownArtifactById(artifactFileId);
    return openMarkdownPreview({
      url: artifact?.url || url,
      name: artifact?.name || name,
      downloadUrl: artifact?.downloadUrl || downloadUrl,
    });
  }

  async function refreshContent({ forceFresh = false } = {}) {
    if (!dom.content) return null;
    if (refreshInFlight) {
      pendingRefreshOptions = mergeRefreshOptions(pendingRefreshOptions, { forceFresh });
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      const target = resolveRunSheetTargetSession();
      if (!target?.id) {
        state.targetSessionId = "";
        state.modelState = "empty";
        state.model = null;
        renderResolvedContent();
        return null;
      }
      const requestSeq = state.requestSeq + 1;
      state.requestSeq = requestSeq;
      const targetChanged = state.targetSessionId !== target.id;
      if (targetChanged) {
        // Switch immediately to the last known projection for this session.
        // The network refresh below then replaces it without an empty frame.
        adoptCachedModel(target.id);
      } else if (!state.model) {
        state.modelState = "loading";
        renderResolvedContent();
      }
      try {
        const model = await fetchRunSheetModel(target, { forceFresh });
        if (requestSeq !== state.requestSeq) return null;
        state.modelState = model ? "content" : "empty";
        state.model = model;
        cacheModel(target.id, model);
        state.error = "";
      } catch (error) {
        if (requestSeq !== state.requestSeq) return null;
        if (state.model) {
          // Cache fallback: keep showing the last good model instead of
          // blanking the sheet on a transient fetch failure.
          state.error = error?.message || "failed";
        } else {
          state.modelState = "error";
          state.model = null;
          state.error = error?.message || "failed";
        }
      }
      renderResolvedContent();
      return state.model;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
      const pending = pendingRefreshOptions;
      pendingRefreshOptions = null;
      if (!state.open) lastBackgroundRefreshAt = Date.now();
      if (pending) {
        scheduleContentRefresh({
          ...pending,
          delay: state.open ? 0 : BACKGROUND_REFRESH_DELAY_MS,
        });
      } else {
        scheduleBackgroundPoll();
      }
    }
  }

  function openMarkdownFromButton(button) {
    if (!button) return false;
    const url = button.dataset.markdownArtifactUrl || "";
    if (!url) return false;
    const artifactSession = String(button.dataset.markdownArtifactSessionId || "").trim();
    const targetSession = String(state.targetSessionId || modelSessionId(state.model) || "").trim();
    if (artifactSession && targetSession && artifactSession !== targetSession) return false;
    return openMarkdownPreview({
      url,
      name: button.dataset.markdownArtifactName || button.textContent || "",
      downloadUrl: button.dataset.markdownArtifactDownloadUrl || "",
    });
  }

  function bindStreamHandlers() {
    const markdownButtons = Array.from(dom.content.querySelectorAll('[data-action="open-markdown"]'));
    for (const button of markdownButtons) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMarkdownFromButton(button);
      });
    }
  }

  function renderContent() {
    scheduleContentRefresh({ delay: 0 });
  }

  function mergeRefreshOptions(base = {}, next = {}) {
    base = base || {};
    return {
      forceFresh: base.forceFresh === true || next.forceFresh === true,
    };
  }

  function scheduleContentRefresh({ forceFresh = false, delay = BACKGROUND_REFRESH_DELAY_MS } = {}) {
    const nextOptions = { forceFresh };
    if (refreshInFlight) {
      pendingRefreshOptions = mergeRefreshOptions(pendingRefreshOptions, nextOptions);
      return refreshInFlight;
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    // While closed the refresh is a background warm-up: debounce bursts and
    // cap the cadence so streaming activity does not hammer the projection
    // endpoint. Opening the sheet still refreshes immediately.
    let effectiveDelay = Math.max(0, delay);
    if (!state.open && !forceFresh) {
      const sinceLast = Date.now() - lastBackgroundRefreshAt;
      if (sinceLast < BACKGROUND_MIN_INTERVAL_MS) {
        effectiveDelay = Math.max(effectiveDelay, BACKGROUND_MIN_INTERVAL_MS - sinceLast);
      }
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshContent(nextOptions);
    }, effectiveDelay);
    return null;
  }

  function scheduleBackgroundPoll() {
    if (backgroundPollTimer) {
      clearTimeout(backgroundPollTimer);
      backgroundPollTimer = null;
    }
    const target = resolveRunSheetTargetSession();
    if (!target?.id) return;
    const delay = isRunningSession(target) ? BACKGROUND_RUNNING_POLL_MS : BACKGROUND_IDLE_POLL_MS;
    backgroundPollTimer = setTimeout(() => {
      backgroundPollTimer = null;
      scheduleContentRefresh({ forceFresh: isRunningSession(target), delay: 0 });
    }, delay);
  }

  function handleBackdropClick(event) {
    if (event.target === dom.backdrop) {
      if (state.readerOpen) {
        closeMarkdownPreview();
      }
      if (state.open) {
        close();
      }
    }
  }

  // On touch browsers a tap in the backdrop can be retargeted to `body` (or
  // another transparent page layer) instead of the empty backdrop element.
  // Capture the pointer before bubbling/retargeting.
  // Neither clicking inside the sheet nor clicking inside the reader drawer
  // triggers dismissal; only clicking outside both dismisses.
  function handleDocumentPointerDown(event) {
    if (!event.target) return;
    if (dom.sheet && dom.sheet.contains(event.target)) return;
    if (dom.reader && dom.reader.contains(event.target)) return;
    if (state.readerOpen) {
      closeMarkdownPreview();
    }
    if (state.open) {
      close();
    }
  }

  // Resolve a `--run-sheet-*-height` token (e.g. "42dvh") into pixels against
  // the current viewport, matching how the CSS class heights are computed.
  function dvhPx(varName, fallbackRatio) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    const num = parseFloat(raw);
    if (Number.isFinite(num) && num > 0) return (num / 100) * window.innerHeight;
    return fallbackRatio * window.innerHeight;
  }

  function sheetAnchors() {
    return {
      expanded: dvhPx("--run-sheet-expanded-height", 0.86),
      compact: dvhPx("--run-sheet-compact-height", 0.42),
    };
  }

  function flushPendingDragHeight() {
    if (dragFrame !== null && typeof root.cancelAnimationFrame === "function") {
      root.cancelAnimationFrame(dragFrame);
    }
    dragFrame = null;
    if (pendingDragHeight === null || !dom.sheet) return;
    dom.sheet.style.height = pendingDragHeight + "px";
    pendingDragHeight = null;
  }

  function scheduleDragHeight(height) {
    pendingDragHeight = height;
    if (dragFrame !== null) return;
    const apply = () => {
      dragFrame = null;
      if (pendingDragHeight === null || !dom.sheet) return;
      dom.sheet.style.height = pendingDragHeight + "px";
      pendingDragHeight = null;
    };
    dragFrame = typeof root.requestAnimationFrame === "function"
      ? root.requestAnimationFrame(apply)
      : setTimeout(apply, 0);
  }

  // After a drag, snap to whichever anchor (dismissed / compact / expanded) the
  // sheet is closest to. Mirrors the composer resize feel: the height follows
  // the finger live, then settles to a sensible rest position on release.
  function snapToNearestAnchor() {
    const { expanded, compact } = sheetAnchors();
    const currentHeight = dom.sheet.getBoundingClientRect().height;
    const anchors = [
      { height: 0, expanded: null },          // null => dismiss the sheet
      { height: compact, expanded: false },
      { height: expanded, expanded: true },
    ];
    let nearest = anchors[0];
    let best = Infinity;
    for (const a of anchors) {
      const d = Math.abs(currentHeight - a.height);
      if (d < best) { best = d; nearest = a; }
    }

    dom.sheet.classList.remove("run-sheet--dragging");

    if (nearest.expanded === null) {
      // Dragged most of the way down — close.
      dom.sheet.style.height = "";
      close();
      return;
    }

    // Re-enable the transition and animate from the dragged height to the
    // anchor. Once it settles, hand height authority back to the CSS class so
    // the sheet keeps tracking viewport changes (dvh) afterward.
    const targetHeight = nearest.expanded ? expanded : compact;
    dom.sheet.style.height = targetHeight + "px";
    state.expanded = nearest.expanded;
    renderContent();
    if (root.RagentMotion?.prefersReducedMotion?.()) {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = null;
      dom.sheet.style.height = "";
      syncDOM();
      return;
    }
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapTimer = null;
      dom.sheet.style.height = "";
      syncDOM();
    }, 260);
  }

  function handleDragStart(event) {
    if (!event.target?.closest?.("[data-run-sheet-handle-zone]")) return;
    if (event.type === "pointerdown" && event.isPrimary === false) return;
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
    flushPendingDragHeight();
    pendingDragHeight = null;
    state.dragging = true;
    state.moved = false;
    state.dragPointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    state.dragStartY = event.type === "touchstart" ? event.touches[0].clientY : event.clientY;
    state.dragStartHeight = dom.sheet.getBoundingClientRect().height;
    dom.sheet.classList.add("run-sheet--dragging");
    if (state.dragPointerId !== null && typeof dom.sheet.setPointerCapture === "function") {
      try {
        dom.sheet.setPointerCapture(state.dragPointerId);
      } catch {}
    }
    event.preventDefault();
  }

  function handleDragMove(event) {
    if (!state.dragging) return;
    if (state.dragPointerId !== null && Number.isInteger(event.pointerId) && event.pointerId !== state.dragPointerId) return;
    const currentY = event.type === "touchmove" ? event.touches[0].clientY : event.clientY;
    const deltaY = state.dragStartY - currentY; // dragging up = positive
    if (Math.abs(deltaY) > 3) state.moved = true;
    if (!state.moved) { event.preventDefault(); return; }
    const { expanded, compact } = sheetAnchors();
    // Follow the finger continuously; clamp so the sheet never inverts and
    // stays reachable (allow dragging down toward dismiss, up to expanded).
    let newHeight = state.dragStartHeight + deltaY;
    newHeight = Math.max(compact * 0.3, Math.min(expanded, newHeight));
    scheduleDragHeight(newHeight);
    event.preventDefault();
  }

  function handleDragEnd(event = {}) {
    if (!state.dragging) return;
    if (state.dragPointerId !== null && Number.isInteger(event.pointerId) && event.pointerId !== state.dragPointerId) return;
    const pointerId = state.dragPointerId;
    state.dragPointerId = null;
    if (pointerId !== null && typeof dom.sheet.releasePointerCapture === "function") {
      try {
        dom.sheet.releasePointerCapture(pointerId);
      } catch {}
    }
    flushPendingDragHeight();
    state.dragging = false;
    if (!state.moved) {
      // A bare tap — leave height alone and let the click handler toggle.
      dom.sheet.classList.remove("run-sheet--dragging");
      return;
    }
    snapToNearestAnchor();
  }

  function handleHandleZoneClick(event) {
    // A real drag already settled the height; swallow the trailing click so it
    // does not also toggle.
    if (state.moved) { state.moved = false; return; }
    if (event.target?.closest?.("[data-run-sheet-handle-zone]")) {
      toggleExpanded();
    }
  }

  // The Run Sheet markup lives in chat.html. If the template is missing the
  // Run Sheet DOM entirely (e.g. an older installed template without the block),
  // inject it at runtime so the sheet always works — no deploy dependency on
  // the template file. The injection is idempotent: if the elements already
  // exist we just bind to them.
  function injectDOM() {
    if (dom.backdrop && dom.sheet && dom.handleZone && dom.content) return true;

    const bd = document.createElement("div");
    bd.className = "run-sheet-backdrop";
    bd.id = "runSheetBackdrop";

    const sheet = document.createElement("div");
    sheet.className = "run-sheet";
    sheet.id = "runSheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "runSheetTitle");
    sheet.setAttribute("aria-hidden", "true");
    sheet.setAttribute("inert", "");

    const hz = document.createElement("div");
    hz.className = "run-sheet__handle-zone";
    hz.id = "runSheetHandleZone";
    hz.setAttribute("data-run-sheet-handle-zone", "");
    const h = document.createElement("div");
    h.className = "run-sheet__handle";
    hz.appendChild(h);

    const hdr = document.createElement("div");
    hdr.className = "run-sheet__header";
    const title = document.createElement("h2");
    title.className = "run-sheet__title";
    title.id = "runSheetTitle";
    title.textContent = tr("runSheet.title");
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "run-sheet__close";
    closeBtn.id = "runSheetClose";
    closeBtn.setAttribute("aria-label", tr("action.close"));
    closeBtn.textContent = "×";
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);

    const content = document.createElement("div");
    content.className = "run-sheet__content";
    content.id = "runSheetContent";

    sheet.appendChild(hz);
    sheet.appendChild(hdr);
    sheet.appendChild(content);

    document.body.appendChild(bd);
    document.body.appendChild(sheet);

    dom.backdrop = bd;
    dom.sheet = sheet;
    dom.handleZone = hz;
    dom.closeBtn = closeBtn;
    dom.content = content;
    ensureMarkdownPreviewMarkup();
    return true;
  }

  function ensureMarkdownPreviewMarkup() {
    let reader = document.getElementById("runSheetMarkdownPreview");
    if (!reader) {
      reader = document.createElement("section");
      reader.className = "run-sheet__reader";
      reader.id = "runSheetMarkdownPreview";
      reader.hidden = true;
      reader.setAttribute("role", "dialog");
      reader.setAttribute("aria-modal", "true");
      reader.setAttribute("aria-labelledby", "runSheetMarkdownTitle");
      reader.setAttribute("aria-hidden", "true");
      reader.innerHTML = `
        <div class="run-sheet__handle-zone run-sheet__reader-handle-zone" data-run-sheet-reader-handle-zone>
          <div class="run-sheet__handle"></div>
        </div>
        <header class="run-sheet__reader-header">
          <button type="button" class="run-sheet__reader-back" data-run-sheet-reader-close aria-label="${esc(tr("action.close"))}">
            ${root.RagentIcons?.render?.("chevron-left", { className: "run-sheet__reader-back-icon" }) || "‹"}
          </button>
          <div class="run-sheet__reader-title-block">
            <div class="run-sheet__reader-eyebrow">${esc(tr("workbench.markdown.readerEyebrow"))}</div>
            <h2 class="run-sheet__reader-title" id="runSheetMarkdownTitle">${esc(tr("workbench.markdown.readerTitle"))}</h2>
          </div>
          <div class="run-sheet__reader-actions">
            <a class="run-sheet__reader-action run-sheet__reader-raw" href="#" target="_blank" rel="noreferrer noopener">${esc(tr("workbench.markdown.openRaw"))}</a>
            <a class="run-sheet__reader-action run-sheet__reader-download run-sheet__reader-download--icon" href="#" target="_blank" rel="noreferrer noopener" aria-label="${esc(tr("action.download"))}" title="${esc(tr("action.download"))}">${(window.RagentIcons && window.RagentIcons.render && window.RagentIcons.render("download")) || esc(tr("action.download"))}</a>
          </div>
        </header>
        <div class="run-sheet__reader-body">
          <div class="run-sheet__reader-status" role="status"></div>
          <article class="run-sheet__reader-content md-content"></article>
        </div>`;
      document.body.appendChild(reader);
    } else if (reader.parentElement && reader.parentElement !== document.body) {
      document.body.appendChild(reader);
    }
    dom.reader = reader;
    dom.readerTitle = reader.querySelector(".run-sheet__reader-title");
    dom.readerStatus = reader.querySelector(".run-sheet__reader-status");
    dom.readerContent = reader.querySelector(".run-sheet__reader-content");
    dom.readerRawLink = reader.querySelector(".run-sheet__reader-raw");
    dom.readerDownloadLink = reader.querySelector(".run-sheet__reader-download");
    reader.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-run-sheet-reader-close]")) {
        event.preventDefault();
        closeMarkdownPreview();
      }
    });

    const readerHandle = reader.querySelector(".run-sheet__reader-handle-zone");
    if (readerHandle && !readerHandle.dataset.dragBound) {
      readerHandle.dataset.dragBound = "true";
      let startY = 0;
      let dragging = false;
      const onPointerDown = (e) => {
        dragging = true;
        startY = e.clientY || e.touches?.[0]?.clientY || 0;
        try { readerHandle.setPointerCapture?.(e.pointerId); } catch {}
      };
      const onPointerMove = (e) => {
        if (!dragging) return;
        const currentY = e.clientY || e.touches?.[0]?.clientY || 0;
        const delta = currentY - startY;
        if (delta > 0) {
          reader.style.transform = `translate3d(0, ${delta}px, 0)`;
        }
      };
      const onPointerEnd = (e) => {
        if (!dragging) return;
        dragging = false;
        try { readerHandle.releasePointerCapture?.(e.pointerId); } catch {}
        const currentY = e.clientY || e.changedTouches?.[0]?.clientY || 0;
        const delta = currentY - startY;
        reader.style.transform = "";
        if (delta > 70) {
          closeMarkdownPreview();
        }
      };
      if (typeof PointerEvent !== "undefined") {
        readerHandle.addEventListener("pointerdown", onPointerDown);
        readerHandle.addEventListener("pointermove", onPointerMove);
        readerHandle.addEventListener("pointerup", onPointerEnd);
        readerHandle.addEventListener("pointercancel", onPointerEnd);
      } else {
        readerHandle.addEventListener("touchstart", onPointerDown, { passive: true });
        readerHandle.addEventListener("touchmove", onPointerMove, { passive: true });
        readerHandle.addEventListener("touchend", onPointerEnd);
      }
    }

    syncMarkdownPreviewDOM();
    return true;
  }

  // If the template already has the markup but carries a legacy header (tabs
  // instead of a close button), normalize it at runtime.
  function normalizeHeaderMarkup() {
    if (dom.handleZone) {
      dom.handleZone.setAttribute("data-run-sheet-handle-zone", "");
    }
    const header = dom.sheet.querySelector(".run-sheet__header");
    if (header) {
      header.querySelector(".run-sheet__tabs")?.remove();
    }
    if (!dom.closeBtn && header) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "run-sheet__close";
      btn.id = "runSheetClose";
      btn.setAttribute("aria-label", tr("action.close"));
      btn.textContent = "×";
      header.appendChild(btn);
      dom.closeBtn = btn;
    }
    ensureMarkdownPreviewMarkup();
  }

  function init() {
    dom.backdrop = document.getElementById("runSheetBackdrop");
    dom.sheet = document.getElementById("runSheet");
    dom.launchButton = document.getElementById("runSheetBtn");
    dom.handleZone = document.getElementById("runSheetHandleZone");
    dom.closeBtn = document.getElementById("runSheetClose");
    dom.content = document.getElementById("runSheetContent");

    // If the template doesn't have the markup, inject it ourselves.
    if (!dom.backdrop || !dom.sheet || !dom.handleZone || !dom.content) {
      if (!injectDOM()) return;
    }

    normalizeHeaderMarkup();

    unsubscribeMotion = root.RagentMotion?.subscribeReducedMotion?.((reduced) => {
      if (!reduced || !dom.sheet) return;
      if (snapTimer) {
        clearTimeout(snapTimer);
        snapTimer = null;
      }
      if (state.dragging) {
        state.dragging = false;
        state.moved = false;
        flushPendingDragHeight();
        dom.sheet.classList.remove("run-sheet--dragging");
      }
      dom.sheet.style.height = "";
      syncDOM();
    }) || null;

    if (typeof root.RagentRunActivity?.subscribe === "function") {
      unsubscribeActivity = root.RagentRunActivity.subscribe(() => {
        scheduleContentRefresh({ delay: state.open ? 0 : BACKGROUND_REFRESH_DELAY_MS });
      });
    }

    dom.backdrop.addEventListener("click", handleBackdropClick);
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    dom.sheet.addEventListener("click", handleHandleZoneClick);
    if (typeof PointerEvent !== "undefined") {
      dom.sheet.addEventListener("pointerdown", handleDragStart);
      dom.sheet.addEventListener("pointermove", handleDragMove);
      dom.sheet.addEventListener("pointerup", handleDragEnd);
      dom.sheet.addEventListener("pointercancel", handleDragEnd);
    } else {
      dom.sheet.addEventListener("mousedown", handleDragStart);
      dom.sheet.addEventListener("touchstart", handleDragStart, { passive: false });
      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("touchmove", handleDragMove, { passive: false });
      document.addEventListener("mouseup", handleDragEnd);
      document.addEventListener("touchend", handleDragEnd);
    }
    document.addEventListener("keydown", handleKeydown);
    dom.closeBtn?.addEventListener("click", close);
    if (typeof getChatStore === "function") {
      unsubscribeStore = getChatStore()?.subscribe?.((nextState, previousState) => {
        syncLaunchButton();
        const nextSessionId = String(nextState?.currentSessionId || "").trim();
        const previousSessionId = String(previousState?.currentSessionId || "").trim();
        if (nextSessionId !== previousSessionId) {
          // Preload the newly selected conversation immediately, even while
          // the sheet is closed. A cached projection paints first on open.
          adoptCachedModel(nextSessionId);
          scheduleContentRefresh({ forceFresh: true, delay: 0 });
          return;
        }
        scheduleContentRefresh({ forceFresh: true, delay: state.open ? 0 : BACKGROUND_REFRESH_DELAY_MS });
      }) || null;
    }

    // Start closed: hidden from assistive tech and out of the tab order.
    syncLaunchButton();
    syncDOM();
  }

  root.openRunSheet = open;
  root.closeRunSheet = close;
  root.refreshRunSheet = renderContent;
  root.openRunSheetMarkdownReader = openMarkdownReaderFromArtifact;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);
