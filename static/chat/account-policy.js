// Account-level permission mode lives in Settings on every client surface.
(function attachAccountPolicySettings(root) {
  "use strict";

  const values = ["full-auto", "approval", "conservative-auto"];
  const elements = {
    section: root.document?.getElementById("accountPolicySettingsSection"),
    open: root.document?.getElementById("accountPolicyOpenBtn"),
    entryTitle: root.document?.getElementById("accountPolicyEntryTitle"),
    entryNote: root.document?.getElementById("accountPolicyEntryNote"),
    entryValue: root.document?.getElementById("accountPolicyEntryValue"),
    groupTitle: root.document?.getElementById("settingsAccountPolicyTitle"),
    pageTitle: root.document?.getElementById("accountPolicyPageTitle"),
    panel: root.document?.getElementById("accountPolicyPanel"),
    options: root.document?.getElementById("accountPolicyOptions"),
    scope: root.document?.getElementById("accountPolicyScopeNote"),
    status: root.document?.getElementById("accountPolicyStatus"),
  };

  const state = { value: null, pending: false };

  function isZh() {
    const language = String(root.ragentGetActiveUiLanguage?.() || "").toLowerCase();
    return language.startsWith("zh");
  }

  function copy() {
    return isZh() ? {
      group: "账号",
      title: "权限模式",
      loading: "正在读取账号级设置",
      scope: "对这个账号下所有电脑的新会话生效；不会更改已有会话的选择。审批和审慎自主模式需要 Harness 支持；不支持的任务会在启动前被拒绝。",
      ownerOnly: "只有账号所有者可以查看或修改此设置。",
      saveFailed: "未能保存权限模式，请重试。",
      values: {
        "full-auto": ["自主执行（默认）", "自动处理操作；特权操作只执行预授权范围"],
        approval: ["请求审批", "常规操作自动执行，需要确认时等待你的批准"],
        "conservative-auto": ["审慎自主", "在受限范围内自动执行，无法确认时拒绝"],
        "": ["自主执行（默认）", "自动处理操作；特权操作只执行预授权范围"],
      },
    } : {
      group: "Account",
      title: "Permission mode",
      loading: "Loading account-wide setting",
      scope: "Applies to new sessions on every computer in this account. Existing session choices stay unchanged. Approval and guarded modes require Harness support; unsupported runs are refused before launch.",
      ownerOnly: "Only the account owner can view or change this setting.",
      saveFailed: "Could not save permission mode. Try again.",
      values: {
        "full-auto": ["Autonomous (default)", "Run automatically; privileged actions require a prior delegation"],
        approval: ["Ask for approval", "Run routine work automatically and ask when needed"],
        "conservative-auto": ["Guarded autonomous", "Run within a restricted scope; deny unresolved requests"],
        "": ["Autonomous (default)", "Run automatically; privileged actions require a prior delegation"],
      },
    };
  }

  function label(value) {
    return copy().values[value] || copy().values[""];
  }

  function canManage() {
    return root.__RAGENT_BOOTSTRAP__?.auth?.role === "owner";
  }

  function setStatus(message = "", tone = "") {
    if (!elements.status) return;
    elements.status.hidden = !message;
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
  }

  function hydrateIcons(node) {
    root.RagentIcons?.hydrate?.(node);
  }

  function render() {
    const text = copy();
    const current = state.value;
    if (elements.section) elements.section.hidden = !canManage();
    if (elements.groupTitle) elements.groupTitle.textContent = text.group;
    if (elements.pageTitle) elements.pageTitle.textContent = text.title;
    if (elements.entryTitle) elements.entryTitle.textContent = text.title;
    if (elements.entryNote) elements.entryNote.textContent = current === null ? text.loading : text.scope;
    if (elements.entryValue) elements.entryValue.textContent = current === null ? "" : label(current)[0];
    if (elements.scope) elements.scope.textContent = text.scope;
    if (!elements.options) return;

    elements.options.textContent = "";
    for (const value of values) {
      const [title, note] = label(value);
      const selected = current === value || (current === "" && value === "full-auto");
      const option = root.document.createElement("button");
      option.type = "button";
      option.className = "settings-row settings-row-choice";
      option.setAttribute("aria-label", `${title}. ${note}`);
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", selected ? "true" : "false");
      option.disabled = state.pending || current === null;
      option.dataset.accountPolicy = value || "default";
      option.innerHTML = `<span class="settings-row-choice-indicator" aria-hidden="true"></span>
        <span class="settings-row-copy"><span class="settings-row-title"></span><span class="settings-row-note"></span></span>`;
      option.querySelector(".settings-row-title").textContent = title;
      option.querySelector(".settings-row-note").textContent = note;
      option.addEventListener("click", () => void save(value));
      elements.options.appendChild(option);
    }
  }

  async function requestJson(url, options = {}) {
    if (typeof root.fetchJsonOrRedirect === "function") return root.fetchJsonOrRedirect(url, options);
    const response = await root.fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function normalize(payload) {
    const value = payload?.policy?.permissionPolicy;
    return values.includes(value) ? value : "";
  }

  async function refresh() {
    if (!canManage()) return;
    try {
      const payload = await requestJson("/api/account-policy");
      state.value = normalize(payload);
      setStatus();
    } catch (error) {
      state.value = null;
      setStatus(error?.status === 403 ? copy().ownerOnly : copy().saveFailed, "error");
    }
    render();
  }

  async function save(value) {
    if (state.pending || state.value === value) return;
    state.pending = true;
    setStatus();
    render();
    try {
      const payload = await requestJson("/api/account-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": root.crypto?.randomUUID?.() || `policy-${Date.now()}` },
        body: JSON.stringify({ permissionPolicy: value }),
      });
      state.value = normalize(payload);
    } catch (error) {
      setStatus(error?.status === 403 ? copy().ownerOnly : copy().saveFailed, "error");
    } finally {
      state.pending = false;
      render();
    }
  }

  function open(event) {
    event?.preventDefault?.();
    if (typeof root.ragentOpenSidebarSubpage === "function") {
      root.ragentOpenSidebarSubpage("account-policy", elements.open);
    } else if (typeof root.switchTab === "function") {
      root.switchTab("account-policy");
    }
    void refresh();
  }

  if (!elements.open || !elements.options || !elements.panel) return;
  elements.open.addEventListener("click", open);
  root.addEventListener("ragent:localechange", render);
  root.RagentAccountPolicy = Object.freeze({ open, refresh });
  hydrateIcons(elements.section);
  void refresh();
})(window);
