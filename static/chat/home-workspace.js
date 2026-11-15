"use strict";

(function attachRagentHomeWorkspace(root) {
  const REFRESH_INTERVAL_MS = 30 * 1000;
  const HOME_DATA_CACHE_MAX_AGE_MS = 10 * 1000;
  let refreshTimer = 0;
  let refreshInFlight = null;
  let renderedOnce = false;

  function el(id) {
    return root.document?.getElementById(id) || null;
  }

  function isChinese() {
    const active = typeof root.ragentGetActiveUiLanguage === "function"
      ? root.ragentGetActiveUiLanguage()
      : root.navigator?.language;
    return String(active || "").toLowerCase().startsWith("zh");
  }

  function translate(key, fallback) {
    const translated = typeof root.ragentT === "function" ? root.ragentT(key) : "";
    return translated && translated !== key ? translated : fallback;
  }

  function copy() {
    return isChinese()
      ? {
          eyebrow: "工作状态",
          title: "现在最值得关注的事",
          intro: "先处理需要你决定的事，其余工作交给 Agent 持续推进。",
          newWork: "开始工作",
          deviceWorkspace: translate("home.deviceWorkspace", "跨设备工作台"),
          deviceWorkspaceUnavailable: translate("home.deviceWorkspaceUnavailable", "跨设备工作台暂不可用。"),
          refresh: "刷新",
          focus: "需要你处理",
          focusEmpty: "目前没有需要你处理的事项。准备好后，可以从一项具体工作开始。",
          running: "进行中的工作",
          runningEmpty: "目前没有正在运行的工作。",
          upcoming: "已安排的工作",
          upcomingEmpty: "还没有未来一周的定时工作。",
          recent: "最近完成的工作",
          recentEmpty: "完成的 Agent 结果会显示在这里。",
          open: "打开",
          markRead: "标记已阅",
          schedule: "定时",
          working: "进行中",
          waiting: "等待你处理",
          urgent: "需要关注",
          high: "高优先级",
          ready: "可以查看结果",
          scheduled: "已安排",
          stale: "待确认",
          focusCount: "待处理",
          runningCount: "进行中",
          upcomingCount: "已安排",
          recentCount: "最近结果",
          loading: "正在加载工作状态…",
          unavailable: "首页数据暂时不可用，请稍后刷新。",
          timeNow: "刚刚",
          timeSoon: "即将",
        }
      : {
          eyebrow: "Work status",
          title: "What needs your attention",
          intro: "Keep decisions close. Your agents keep routine work moving.",
          newWork: "Start new work",
          deviceWorkspace: translate("home.deviceWorkspace", "Cross-device workspace"),
          deviceWorkspaceUnavailable: translate("home.deviceWorkspaceUnavailable", "Cross-device workspace is unavailable."),
          refresh: "Refresh",
          focus: "Needs your attention",
          focusEmpty: "Nothing needs your attention right now. Start with one concrete task when you're ready.",
          running: "Work in progress",
          runningEmpty: "Nothing is running right now.",
          upcoming: "Scheduled work",
          upcomingEmpty: "No work is scheduled for the next week.",
          recent: "Recently completed",
          recentEmpty: "Completed agent results will appear here.",
          open: "Open",
          markRead: "Mark read",
          schedule: "Scheduled",
          working: "In progress",
          waiting: "Waiting for you",
          urgent: "Needs attention",
          high: "High priority",
          ready: "Ready to review",
          scheduled: "Scheduled",
          stale: "Needs review",
          focusCount: "Needs attention",
          runningCount: "In progress",
          upcomingCount: "Scheduled",
          recentCount: "Recent results",
          loading: "Loading work status…",
          unavailable: "Home data is temporarily unavailable. Refresh to try again.",
          timeNow: "Just now",
          timeSoon: "Soon",
        };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatTime(value, labels) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "";
    const delta = Date.now() - time;
    if (delta >= 0 && delta < 90 * 1000) return labels.timeNow;
    if (delta < 0 && Math.abs(delta) < 90 * 60 * 1000) return labels.timeSoon;
    try {
      return new Intl.DateTimeFormat(isChinese() ? "zh-CN" : undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(time));
    } catch {
      return new Date(time).toLocaleString();
    }
  }

  function resolvePath(path) {
    return typeof root.ragentResolveProductPath === "function"
      ? root.ragentResolveProductPath(path)
      : path;
  }

  async function fetchHomeData({ force = false } = {}) {
    const requestOptions = force
      ? { credentials: "same-origin", revalidate: false, cache: "no-store" }
      : { credentials: "same-origin", cacheMaxAgeMs: HOME_DATA_CACHE_MAX_AGE_MS };
    if (typeof root.fetchJsonOrRedirect === "function") {
      const result = await root.fetchJsonOrRedirect(resolvePath("/api/home"), requestOptions);
      return result && typeof result.json === "function" ? result.json() : result;
    }
    const response = await (root.ragentFetch || fetch)(resolvePath("/api/home"), {
      credentials: "same-origin",
      cache: force ? "no-store" : "default",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Home request failed (${response.status})`);
    return response.json();
  }

  function itemLabel(item, labels) {
    if (item?.kind === "trigger") {
      if (item.status === "failed" || item.overdue) return labels.urgent;
      return labels.scheduled;
    }
    if (item?.workflowState === "waiting_user") return labels.waiting;
    if (item?.severity === "urgent") return labels.urgent;
    if (item?.workflowPriority === "high") return labels.high;
    if (item?.kind === "result") return labels.ready;
    if (item?.running) return labels.working;
    return labels.stale;
  }

  function itemIcon(item) {
    if (item?.kind === "trigger") return "folder";
    if (item?.workflowState === "waiting_user" || item?.severity === "urgent" || item?.severity === "high") return "bell";
    if (item?.kind === "result") return "check";
    if (item?.running) return "refresh";
    return "sparkle";
  }

  function renderItem(item, labels, { showRead = false } = {}) {
    const safeId = escapeHtml(item?.id || "");
    const time = formatTime(item?.scheduledAt || item?.updatedAt, labels);
    const triggerMeta = item?.kind === "trigger"
      ? `<span class="home-item-meta-label">${escapeHtml(labels.schedule)}</span>`
      : "";
    const statusLabel = itemLabel(item, labels);
    const icon = itemIcon(item);
    return `<article class="home-item home-item--${escapeHtml(item?.severity || "normal")}" data-home-item-id="${safeId}">
      <span class="home-item-icon" data-icon="${icon}" aria-hidden="true"></span>
      <div class="home-item-main">
        <div class="home-item-topline">
          <span class="home-item-label">${escapeHtml(statusLabel)}</span>
          ${time ? `<time class="home-item-time">${escapeHtml(time)}</time>` : ""}
        </div>
        <h3 class="home-item-title">${escapeHtml(item?.title || "")}</h3>
        <p class="home-item-summary">${escapeHtml(item?.reason || item?.summary || "")}</p>
        ${triggerMeta}
      </div>
      <div class="home-item-actions">
        <button type="button" class="home-action home-action--primary" data-home-action="open" data-session-id="${escapeHtml(item?.sessionId || "")}" title="${escapeHtml(labels.open)}" aria-label="${escapeHtml(labels.open)}">
          <span data-icon="chevron-right" aria-hidden="true"></span>
        </button>
        ${showRead && item?.sessionId ? `<button type="button" class="home-action home-action--quiet" data-home-action="read" data-session-id="${escapeHtml(item.sessionId)}" title="${escapeHtml(labels.markRead)}" aria-label="${escapeHtml(labels.markRead)}"><span data-icon="check" aria-hidden="true"></span></button>` : ""}
      </div>
    </article>`;
  }

  function renderSection(title, empty, items, labels, options = {}) {
    const body = Array.isArray(items) && items.length > 0
      ? items.map((item) => renderItem(item, labels, options)).join("")
      : `<div class="home-empty-row"><span class="home-empty-icon" data-icon="check" aria-hidden="true"></span><span>${escapeHtml(empty)}</span></div>`;
    return `<section class="home-section ${options.className || ""}">
      <div class="home-section-header"><span class="home-section-icon" data-icon="${escapeHtml(options.icon || "sparkle")}" aria-hidden="true"></span><h2>${escapeHtml(title)}</h2>${options.count !== undefined ? `<span class="home-section-count">${escapeHtml(String(options.count))}</span>` : ""}</div>
      <div class="home-item-list">${body}</div>
    </section>`;
  }

  function render(data = {}) {
    const workspace = el("homeWorkspace");
    if (!workspace) return;
    const labels = copy();
    const focusItems = Array.isArray(data.focusItems) ? data.focusItems : [];
    const inProgress = Array.isArray(data.inProgress) ? data.inProgress : [];
    const upcoming = Array.isArray(data.upcomingAutomation) ? data.upcomingAutomation : [];
    const recent = Array.isArray(data.recentResults) ? data.recentResults : [];
    const counts = data.counts || {};
    workspace.innerHTML = `<div class="home-workspace-header">
      <div class="home-workspace-heading"><h2 id="homeWorkspaceTitle">${escapeHtml(labels.title)}</h2><p>${escapeHtml(labels.intro)}</p></div>
      <div class="home-workspace-actions"><button type="button" class="home-new-work" data-home-action="new"><span data-icon="new-chat" aria-hidden="true"></span><span>${escapeHtml(labels.newWork)}</span></button><button type="button" class="home-refresh" data-home-action="refresh" title="${escapeHtml(labels.refresh)}" aria-label="${escapeHtml(labels.refresh)}"><span data-icon="refresh" aria-hidden="true"></span></button></div>
    </div>
    <div class="home-overview-strip" aria-label="${escapeHtml(labels.eyebrow)}">
      <div class="home-overview-stat home-overview-stat--attention"><span class="home-overview-icon" data-icon="bell" aria-hidden="true"></span><strong>${escapeHtml(String(counts.focus || 0))}</strong><span>${escapeHtml(labels.focusCount)}</span></div>
      <div class="home-overview-stat"><span class="home-overview-icon" data-icon="refresh" aria-hidden="true"></span><strong>${escapeHtml(String(counts.running || 0))}</strong><span>${escapeHtml(labels.runningCount)}</span></div>
      <div class="home-overview-stat"><span class="home-overview-icon" data-icon="folder" aria-hidden="true"></span><strong>${escapeHtml(String(counts.upcoming || 0))}</strong><span>${escapeHtml(labels.upcomingCount)}</span></div>
      <div class="home-overview-stat"><span class="home-overview-icon" data-icon="check" aria-hidden="true"></span><strong>${escapeHtml(String(counts.recent || 0))}</strong><span>${escapeHtml(labels.recentCount)}</span></div>
    </div>
    <div class="home-focus-layout">
      ${renderSection(labels.focus, labels.focusEmpty, focusItems.slice(0, 3), labels, { className: "home-section--focus", count: focusItems.length, showRead: true, icon: "bell" })}
    </div>
    <div class="home-lower-grid">
      ${renderSection(labels.running, labels.runningEmpty, inProgress, labels, { className: "home-section--running", icon: "refresh" })}
      ${renderSection(labels.upcoming, labels.upcomingEmpty, upcoming, labels, { className: "home-section--upcoming", icon: "folder" })}
      ${renderSection(labels.recent, labels.recentEmpty, recent, labels, { className: "home-section--recent", icon: "check" })}
    </div>`;
    const actionBar = workspace.querySelector(".home-workspace-actions");
    const deviceButton = root.document.createElement("button");
    deviceButton.type = "button";
    deviceButton.className = "home-device-workspace";
    deviceButton.dataset.homeAction = "cross-device";
    deviceButton.title = labels.deviceWorkspace;
    deviceButton.setAttribute("aria-label", labels.deviceWorkspace);
    const deviceIcon = root.document.createElement("span");
    deviceIcon.dataset.icon = "monitor";
    deviceIcon.setAttribute("aria-hidden", "true");
    const deviceLabel = root.document.createElement("span");
    deviceLabel.className = "home-device-workspace-label";
    deviceLabel.textContent = labels.deviceWorkspace;
    deviceButton.append(deviceIcon, deviceLabel);
    actionBar?.insertBefore(deviceButton, actionBar.querySelector(".home-refresh"));
    if (root.RagentIcons?.hydrate) root.RagentIcons.hydrate(workspace);
    workspace.querySelectorAll("[data-home-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button));
    });
    renderedOnce = true;
  }

  async function markRead(sessionId) {
    if (!sessionId) return;
    await (root.ragentFetch || fetch)(resolvePath(`/api/sessions/${encodeURIComponent(sessionId)}`), {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ lastReviewedAt: new Date().toISOString() }),
    });
    await refresh({ force: true });
  }

  function openSession(sessionId) {
    if (!sessionId) return;
    if (typeof root.applyNavigationState === "function") {
      root.applyNavigationState({ sessionId, tab: "sessions" });
      return;
    }
    root.location.assign(resolvePath(`/?session=${encodeURIComponent(sessionId)}`));
  }

  function openDeviceWorkspace() {
    try {
      const opened = root.RagentCrossDevicePanel?.open?.({ view: "devices" });
      if (opened !== false) return;
    } catch {}
    root.showSystemToast?.(copy().deviceWorkspaceUnavailable, "info");
  }

  function handleAction(button) {
    const action = button?.dataset?.homeAction;
    if (action === "new") {
      el("newSessionBtn")?.click();
      return;
    }
    if (action === "refresh") {
      refresh({ force: true });
      return;
    }
    if (action === "cross-device") {
      openDeviceWorkspace();
      return;
    }
    if (action === "read") {
      markRead(button.dataset.sessionId).catch(() => {});
      return;
    }
    if (action === "open") openSession(button.dataset.sessionId);
  }

  async function refresh({ force = false } = {}) {
    const workspace = el("homeWorkspace");
    if (!workspace || workspace.hidden) return;
    if (refreshInFlight && !force) return refreshInFlight;
    refreshInFlight = fetchHomeData({ force })
      .then((data) => render(data))
      .catch(() => {
        if (!renderedOnce) {
          const labels = copy();
          workspace.innerHTML = `<div class="home-unavailable"><span class="home-unavailable-icon" data-icon="refresh" aria-hidden="true"></span><p>${escapeHtml(labels.unavailable)}</p><button type="button" class="home-action home-action--primary" data-home-action="refresh"><span data-icon="refresh" aria-hidden="true"></span><span>${escapeHtml(labels.refresh)}</span></button></div>`;
          workspace.querySelector("[data-home-action]")?.addEventListener("click", () => refresh({ force: true }));
          if (root.RagentIcons?.hydrate) root.RagentIcons.hydrate(workspace);
        }
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  function showHomeWorkspace() {
    const workspace = el("homeWorkspace");
    if (!workspace) return;
    workspace.hidden = false;
    if (!renderedOnce) {
      const labels = copy();
      workspace.innerHTML = `<div class="home-loading" role="status" aria-live="polite"><div class="home-loading-copy"><span class="home-loading-bar"></span><span>${escapeHtml(labels.loading)}</span></div><div class="home-loading-rows" aria-hidden="true"><span></span><span></span><span></span></div></div>`;
    }
    refresh();
    if (!refreshTimer) {
      refreshTimer = root.setInterval(() => refresh(), REFRESH_INTERVAL_MS);
    }
  }

  root.showHomeWorkspace = showHomeWorkspace;
  root.refreshHomeWorkspace = () => refresh({ force: true });
  // WebSocket invalidations use the non-forced path so several rapid events
  // coalesce into one request while the manual refresh button stays explicit.
  root.requestHomeWorkspaceRefresh = () => refresh();
  root.addEventListener("ragent:localechange", () => {
    if (!el("homeWorkspace")?.hidden) {
      renderedOnce = false;
      refresh({ force: true });
    }
  });
  root.addEventListener("visibilitychange", () => {
    if (!root.document.hidden && !el("homeWorkspace")?.hidden) refresh();
  });
})(window);
