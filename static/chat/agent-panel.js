// Composer inline Agent picker panel — opened from the "+" menu's
// "Agents and apps" item. Reuses the existing inlineAgentSelect pipeline
// in tooling.js (fill / change -> setPreferredAgentTemplate + session sync);
// this file only exposes that hidden select as a visible panel next to the
// composer, so choosing an agent takes effect for the next turn/session
// without leaving the input context.
(function () {
  "use strict";

  let panel = null;
  let listEl = null;
  let manageBtn = null;
  let backEntryId = null;
  let panelOpen = false;
  let initialized = false;
  let trigger = null;
  let backdrop = null;
  let handleZone = null;
  let sheetDrag = null;
  let sheetDragResetTimer = null;
  let backdropHideTimer = null;
  let restoreFocus = false;
  let focusBeforeOpen = null;
  let focusScopeDeactivate = null;
  let loadGeneration = 0;

  function getSelect() {
    return typeof inlineAgentSelect !== "undefined" ? inlineAgentSelect : null;
  }

  function renderMessage(text) {
    if (!listEl) return;
    listEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "composer-add-panel-empty";
    empty.textContent = text;
    listEl.appendChild(empty);
  }

  function agentOptionDetail(option) {
    const key = option.value === ""
      ? "compose.agent.defaultDetail"
      : "compose.agent.customDetail";
    return typeof t === "function"
      ? t(key)
      : option.value === ""
        ? "Use Ragent's default conversation behavior"
        : "Reusable workflow for the next message";
  }

  function renderList() {
    const select = getSelect();
    if (!select || select.disabled) {
      renderMessage(typeof t === "function" ? t("settings.apps.ownerOnly") : "Only available to the owner.");
      return;
    }
    // Keep the empty-value option visible: it is the user's way back to the
    // default Agent after choosing a reusable app. Plan mode owns its own
    // composer menu entry and must stay out of this picker.
    const agentOptions = Array.from(select.options || [])
      .filter((option) => option.value !== "__plan" && String(option.textContent || "").trim());
    if (agentOptions.length === 0) {
      renderMessage(typeof t === "function" ? t("compose.agent.none") : "No agents available yet.");
      return;
    }
    listEl.innerHTML = "";
    for (const option of agentOptions) {
      const selected = option.value === select.value;
      const row = document.createElement("button");
      row.type = "button";
      row.className = `composer-add-panel-row composer-add-panel-row--agent composer-agent-list-item${selected ? " is-selected" : ""}`;
      row.setAttribute("role", "radio");
      row.setAttribute("aria-checked", selected ? "true" : "false");
      row.classList.toggle("active", selected);
      const copy = document.createElement("span");
      copy.className = "composer-agent-row-copy";
      const label = document.createElement("span");
      label.className = "composer-add-panel-row-label";
      const optionLabel = option.textContent || option.value;
      label.textContent = optionLabel;
      copy.appendChild(label);
      const detail = document.createElement("span");
      detail.className = "composer-add-panel-row-detail";
      detail.textContent = agentOptionDetail(option);
      row.setAttribute("aria-label", `${optionLabel}, ${detail.textContent}`);
      copy.appendChild(detail);
      row.appendChild(copy);

      const trailing = document.createElement("span");
      trailing.className = "composer-agent-row-trailing";
      const state = document.createElement("span");
      state.className = `composer-agent-selection-state${selected ? " is-selected" : ""}`;
      if (selected) {
        const selectedLabel = document.createElement("span");
        selectedLabel.className = "composer-agent-selection-label";
        selectedLabel.textContent = typeof t === "function" ? t("compose.agent.selected") : "Selected";
        state.appendChild(selectedLabel);
        const check = document.createElement("span");
        check.className = "composer-add-panel-check";
        check.setAttribute("aria-hidden", "true");
        if (window.RagentIcons?.render) check.innerHTML = window.RagentIcons.render("check");
        state.appendChild(check);
      } else {
        const ring = document.createElement("span");
        ring.className = "composer-agent-selection-ring";
        ring.setAttribute("aria-hidden", "true");
        state.appendChild(ring);
      }
      trailing.appendChild(state);
      row.appendChild(trailing);
      row.addEventListener("click", () => {
        if (select.value !== option.value) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        closePanel();
      });
      listEl.appendChild(row);
    }
  }

  async function refresh() {
    if (typeof refreshInlineAgentPicker === "function") {
      await refreshInlineAgentPicker({ force: true });
    }
  }

  function show() {
    if (!panel) return;
    if (!backdrop) return;
    trigger?.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-modal", "true");
    if (backdropHideTimer) clearTimeout(backdropHideTimer);
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop?.classList.add("is-visible"));
    panel.hidden = false;
    panel.classList.remove("is-closing");
    if (window.RagentMotion?.setPresence) {
      window.RagentMotion.setPresence(panel, true, { duration: 220 });
    } else {
      panel.classList.add("is-open");
    }
    focusScopeDeactivate = window.RagentFocusScope?.activate?.(panel, {
      containmentRoot: document.body,
      initialFocus: () => listEl?.querySelector("button:not(:disabled)") || manageBtn,
      restoreFocus: () => (focusBeforeOpen && focusBeforeOpen.isConnected !== false)
        ? focusBeforeOpen
        : trigger,
      modal: true,
      onEscape: () => closePanel(),
    }) || null;
    backEntryId = (window.RagentBackHandler && typeof window.RagentBackHandler.push === "function")
      ? window.RagentBackHandler.push({ id: "composer-agent-panel", onBack: () => { closePanel(); return true; } })
      : null;
  }

  function hide() {
    if (!panel) return;
    trigger?.setAttribute("aria-expanded", "false");
    if (backEntryId && window.RagentBackHandler && typeof window.RagentBackHandler.pop === "function") {
      window.RagentBackHandler.pop(backEntryId);
      backEntryId = null;
    }
    const hadFocusScope = Boolean(focusScopeDeactivate);
    if (focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
    }
    if (window.RagentMotion?.setPresence) {
      window.RagentMotion.setPresence(panel, false, { duration: 180 });
    } else {
      panel.classList.remove("is-open");
      panel.classList.add("is-closing");
      setTimeout(() => {
        if (!panel) return;
        panel.hidden = true;
        panel.classList.remove("is-closing");
      }, 140);
    }
    if (!hadFocusScope && restoreFocus && trigger && typeof trigger.focus === "function") {
      trigger.focus({ preventScroll: true });
    }
    restoreFocus = false;
    panel.setAttribute("aria-modal", "false");
    if (backdrop) {
      backdrop.classList.remove("is-visible");
      if (backdropHideTimer) clearTimeout(backdropHideTimer);
      backdropHideTimer = setTimeout(() => {
        backdropHideTimer = null;
        if (!panelOpen) backdrop.hidden = true;
      }, 190);
    }
    panel.classList.remove("composer-add-panel--dragging");
    panel.style.transform = "";
    panel.style.transition = "";
    if (backdrop) backdrop.style.opacity = "";
  }

  function focusFirstItem() {
    if (!restoreFocus || !listEl) return;
    const first = listEl.querySelector("button:not(:disabled)") || manageBtn;
    if (first && typeof first.focus === "function") first.focus({ preventScroll: true });
  }

  function positionPanel() {
    if (!panel || !trigger) return;
    if (window.matchMedia?.("(max-width: 767px)")?.matches) {
      panel.style.width = "";
      panel.style.left = "";
      panel.style.right = "";
      panel.style.bottom = "";
      return;
    }
    const anchor = trigger.closest(".input-wrapper") || trigger;
    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    const width = Math.min(360, Math.max(0, anchorRect.width - 4), Math.max(0, viewportWidth - 32));
    const left = Math.max(16, Math.min(anchorRect.left, viewportWidth - width - 16));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(12, viewportHeight - anchorRect.top + 10)}px`;
  }

  function isMobileSheet() {
    return window.matchMedia?.("(max-width: 767px)")?.matches === true;
  }

  function resetSheetDrag() {
    if (!panel) return;
    panel.classList.remove("composer-add-panel--dragging");
    panel.style.transition = "transform 180ms var(--motion-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1))";
    panel.style.transform = "translate3d(0, 0, 0)";
    if (backdrop) backdrop.style.opacity = "";
    if (sheetDragResetTimer) clearTimeout(sheetDragResetTimer);
    sheetDragResetTimer = setTimeout(() => {
      sheetDragResetTimer = null;
      panel.style.transform = "";
      panel.style.transition = "";
    }, 190);
  }

  function finishSheetDrag(event = {}) {
    if (!sheetDrag || (sheetDrag.pointerId !== null && Number.isInteger(event.pointerId) && event.pointerId !== sheetDrag.pointerId)) return;
    const deltaY = sheetDrag.lastDeltaY;
    const moved = sheetDrag.moved;
    const pointerId = sheetDrag.pointerId;
    sheetDrag = null;
    if (pointerId !== null) handleZone?.releasePointerCapture?.(pointerId);
    if (!isMobileSheet() || !moved || deltaY <= 0) {
      resetSheetDrag();
      return;
    }
    if (deltaY >= 120) {
      closePanel();
      return;
    }
    resetSheetDrag();
  }

  function installSheetHandle() {
    if (!panel || handleZone) return;
    handleZone = document.createElement("div");
    handleZone.className = "composer-add-panel-handle-zone";
    handleZone.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "composer-add-panel-handle";
    handleZone.appendChild(bar);
    panel.insertBefore(handleZone, panel.firstChild);
    handleZone.addEventListener("pointerdown", (event) => {
      if (!isMobileSheet() || event.isPrimary === false) return;
      sheetDrag = { pointerId: Number.isInteger(event.pointerId) ? event.pointerId : null, startY: event.clientY, lastDeltaY: 0, moved: false };
      panel.classList.add("composer-add-panel--dragging");
      handleZone.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handleZone.addEventListener("pointermove", (event) => {
      if (!sheetDrag || (sheetDrag.pointerId !== null && event.pointerId !== sheetDrag.pointerId)) return;
      const deltaY = Math.max(0, event.clientY - sheetDrag.startY);
      sheetDrag.lastDeltaY = deltaY;
      if (deltaY > 4) sheetDrag.moved = true;
      panel.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      if (backdrop) backdrop.style.opacity = String(1 - Math.min(deltaY / 260, 0.72));
      event.preventDefault();
    });
    handleZone.addEventListener("pointerup", finishSheetDrag);
    handleZone.addEventListener("pointercancel", finishSheetDrag);
  }

  function openPanel() {
    if (panelOpen) return;
    if (!panel) ready();
    if (!panel) return;
    if (typeof window.RagentConnectorPanel?.close === "function") {
      window.RagentConnectorPanel.close();
    }
    loadGeneration += 1;
    const generation = loadGeneration;
    trigger = document.getElementById("composerAgentsMenuItem") || trigger;
    focusBeforeOpen = document.activeElement;
    restoreFocus = !!trigger && document.activeElement === trigger;
    panelOpen = true;
    positionPanel();
    renderMessage(typeof t === "function" ? t("compose.agent.loading") : "Loading agents…");
    show();
    if (restoreFocus) panel.focus({ preventScroll: true });
    void refresh().then(() => {
      if (panelOpen && generation === loadGeneration) {
        renderList();
        focusFirstItem();
      }
    }, () => {
      if (panelOpen && generation === loadGeneration) {
        renderMessage(typeof t === "function" ? t("compose.agent.loadingFailed") : "Agents unavailable");
        focusFirstItem();
      }
    });
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    hide();
  }

  function ready() {
    if (initialized) return;
    initialized = true;
    panel = document.getElementById("composerAgentPanel");
    listEl = document.getElementById("composerAgentList");
    manageBtn = document.getElementById("composerAgentPanelManage");
    trigger = document.getElementById("composerAgentsMenuItem");
    if (panel && panel.parentElement !== document.body) {
      document.body.appendChild(panel);
      panel.classList.add("composer-add-panel--portaled");
      panel.style.position = "fixed";
    }
    panel?.classList.add("composer-add-panel--agent");
    backdrop = document.createElement("div");
    backdrop.className = "composer-add-panel-backdrop";
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("click", () => closePanel());
    document.body.appendChild(backdrop);
    installSheetHandle();
    trigger?.setAttribute("aria-controls", "composerAgentPanel");
    trigger?.setAttribute("aria-expanded", "false");
    if (manageBtn) {
      manageBtn.addEventListener("click", () => {
        closePanel();
        if (typeof switchTab === "function") switchTab("agents");
        if (typeof openSidebar === "function") openSidebar();
      });
    }
    panel?.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("pointerdown", (event) => {
      if (!panelOpen || !isMobileSheet() || !panel) return;
      if (event.target instanceof Node && !panel.contains(event.target)) closePanel();
    }, { capture: true });
    document.addEventListener("click", (event) => {
      if (!panelOpen || !panel) return;
      if (window.matchMedia?.("(max-width: 767px)")?.matches) return;
      if (event.target instanceof Node && !panel.contains(event.target) && !trigger?.contains(event.target)) closePanel();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panelOpen) closePanel();
    });
    window.addEventListener("resize", positionPanel, { passive: true });
    window.addEventListener("scroll", positionPanel, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", positionPanel, { passive: true });
    window.visualViewport?.addEventListener("scroll", positionPanel, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }

  window.RagentAgentPanel = Object.freeze({
    open: openPanel,
    close: closePanel,
    isOpen: () => panelOpen,
  });
})();
