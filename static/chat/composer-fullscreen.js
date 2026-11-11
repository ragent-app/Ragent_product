// Full-screen composer: WeChat-style expanded input for long drafts on
// mobile. Self-contained module — it talks to the main composer only through
// DOM state (msgInput / sendBtn) and dispatched input events, so compose.js
// needs just one optional sync hook after auto-resize. Degrades to a silent
// no-op when the composer is absent (e.g. share-snapshot pages).
(function initAgentoCComposerFullscreen() {
  "use strict";

  const FULLSCREEN_QUERY = "(max-width: 767px)";
  const FULLSCREEN_Z_INDEX = 300;
  const MOTION_DURATION_MS = 160;
  // Must stay aligned with chat-responsive.css `.input-row textarea`
  // `max-height: calc(1.55em * 5)` and compose.js INPUT_AUTO_MAX_LINES_MOBILE.
  const MOBILE_AUTO_MAX_LINES = 5;

  const expandBtn = document.getElementById("composerExpandBtn");
  const fullscreenEl = document.getElementById("composerFullscreen");
  const fullscreenInput = document.getElementById("composerFullscreenInput");
  const fullscreenEditor = document.getElementById("composerFullscreenEditor");
  const fullscreenSendBtn = document.getElementById("composerFullscreenSendBtn");
  const fullscreenCloseBtn = document.getElementById("composerFullscreenCloseBtn");
  const msgInput = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");
  // Real inline-composer controls re-parented into the fullscreen bar so the
  // plus/model buttons (and their menus, labels, disabled state) stay live
  // without duplicating any state. Optional — degrade silently if absent.
  const actionsLeft = document.getElementById("composerFullscreenActionsLeft");
  const imgBtn = document.getElementById("imgBtn");
  const runtimeBtn = document.getElementById("composerRuntimeBtn");
  if (
    !expandBtn || !fullscreenEl || !fullscreenInput
    || !fullscreenSendBtn || !fullscreenCloseBtn || !msgInput
  ) {
    return;
  }
  window.AgentoCMarkdownComposer?.mount?.(fullscreenInput, fullscreenEditor);

  let active = false;
  let focusScopeDeactivate = null;
  let focusBeforeOpen = null;
  // Android back button / gesture: handled by the shared back-handler
  // (first back collapses, second back leaves the page — WeChat-style).
  let backEntryId = null;

  // Re-parenting bookkeeping for the plus/model controls. Each entry remembers
  // the original parent and next-sibling so close() can restore exact order.
  let movedControls = null;
  let sendDisabledObserver = null;

  function adoptControls() {
    if (movedControls || !actionsLeft) return;
    const adopted = [];
    [imgBtn, runtimeBtn].forEach((btn) => {
      if (!btn || !btn.parentNode || btn.parentNode === actionsLeft) return;
      adopted.push({ el: btn, parent: btn.parentNode, next: btn.nextElementSibling });
      actionsLeft.appendChild(btn);
    });
    movedControls = adopted.length ? adopted : null;
  }

  function restoreControls() {
    if (!movedControls) return;
    movedControls.forEach(({ el, parent, next }) => {
      if (!el || !parent) return;
      if (next && next.parentNode === parent) parent.insertBefore(el, next);
      else parent.appendChild(el);
    });
    movedControls = null;
  }

  // Mirror the inline send button's sendability onto the fullscreen send so its
  // dimmed/enabled visual stays consistent with the composer (the bespoke
  // send() already checks sendBtn.disabled before acting).
  function syncSendDisabled() {
    if (fullscreenSendBtn && sendBtn) fullscreenSendBtn.disabled = sendBtn.disabled;
  }
  function startSendDisabledSync() {
    syncSendDisabled();
    if (!sendBtn || typeof MutationObserver === "undefined") return;
    sendDisabledObserver = new MutationObserver(syncSendDisabled);
    sendDisabledObserver.observe(sendBtn, { attributes: true, attributeFilter: ["disabled"] });
  }
  function stopSendDisabledSync() {
    if (sendDisabledObserver) {
      sendDisabledObserver.disconnect();
      sendDisabledObserver = null;
    }
  }

  // Collapses any add/runtime menu left open from the re-parented triggers so
  // a floating menu never outlives the overlay.
  function closeOpenMenus() {
    window.AgentoCComposerAddMenu?.close?.();
    window.AgentoCComposerRuntimeMenu?.close?.();
  }

  function isMobile() {
    return typeof window.matchMedia === "function"
      && window.matchMedia(FULLSCREEN_QUERY).matches;
  }

  function atAutoGrowCap() {
    const mainEditor = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
      || window.AgentoCMarkdownComposer?.getEditor?.(msgInput)
      || msgInput;
    const lineHeight = parseFloat(getComputedStyle(mainEditor).lineHeight) || 24;
    // scrollHeight carries the full content height even when max-height
    // clips the box, so this is a "content reached the cap" test.
    return mainEditor.scrollHeight >= lineHeight * MOBILE_AUTO_MAX_LINES - 2;
  }

  // Reveals the expand affordance only when it can do something: mobile,
  // the input actually hit its auto-grow cap, and no full-screen session
  // is already open. The button floats over the text's top-right corner;
  // the textarea does not yield its right edge (user decision 2026-08-05).
  function sync() {
    const show = isMobile() && !active && atAutoGrowCap();
    expandBtn.hidden = !show;
    document.body.classList.toggle("composer-expand-active", show);
  }

  let lastVvHeight = -1;
  let lastVvTop = -1;
  let viewportRafId = 0;

  // Keeps the overlay glued to the visual viewport so the software keyboard
  // never covers the actions row (same contract as the composer menus).
  function syncViewport() {
    if (!active || !fullscreenEl) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const nextH = Math.floor(vv.height);
    const nextTop = Math.floor(vv.offsetTop);
    if (nextH === lastVvHeight && nextTop === lastVvTop) return;
    lastVvHeight = nextH;
    lastVvTop = nextTop;
    fullscreenEl.style.height = `${nextH}px`;
    fullscreenEl.style.top = `${nextTop}px`;
  }

  function scheduleSyncViewport() {
    if (viewportRafId) return;
    viewportRafId = window.requestAnimationFrame(() => {
      viewportRafId = 0;
      syncViewport();
    });
  }

  function open() {
    if (active) return;
    active = true;
    focusBeforeOpen = document.activeElement;
    document.body.classList.add("composer-fullscreen-open");
    adoptControls();
    startSendDisabledSync();
    fullscreenInput.value = msgInput.value;
    fullscreenEl.style.zIndex = String(FULLSCREEN_Z_INDEX);
    window.AgentoCMotion?.setPresence?.(fullscreenEl, true, {
      openClass: "is-open",
      duration: MOTION_DURATION_MS,
      onAfterOpen: () => syncViewport(),
    });
    focusScopeDeactivate = window.AgentoCFocusScope?.activate?.(fullscreenEl, {
      containmentRoot: document.body,
      initialFocus: fullscreenInput,
      restoreFocus: () => (focusBeforeOpen && focusBeforeOpen.isConnected !== false)
        ? focusBeforeOpen
        : expandBtn,
      modal: true,
      onEscape: () => close(),
    }) || null;
    sync();
    syncViewport();
    backEntryId = window.AgentoCBackHandler?.push?.({
      id: "composer-fullscreen",
      onBack: () => {
        // The back-handler already consumed the history entry; collapse
        // without trying to unwind it again.
        close({ skipSync: false, viaHistory: true });
        return true;
      },
    }) || null;
    fullscreenInput.focus({ preventScroll: true });
  }

  function close({ skipSync = false, viaHistory = false } = {}) {
    if (!active) return;
    active = false;
    if (focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
    }
    document.body.classList.remove("composer-fullscreen-open");
    closeOpenMenus();
    restoreControls();
    stopSendDisabledSync();
    if (!skipSync) {
      // Hand the draft back to the main composer and re-run its input
      // pipeline (auto-resize, draft persistence, send availability).
      msgInput.value = fullscreenInput.value;
      msgInput.dispatchEvent(new Event("input"));
    }
    window.AgentoCMotion?.setPresence?.(fullscreenEl, false, {
      openClass: "is-open",
      closingClass: "is-closing",
      duration: MOTION_DURATION_MS,
      onAfterClose: () => {
        fullscreenEl.style.height = "";
        fullscreenEl.style.top = "";
      },
    });
    expandBtn.hidden = true;
    // After the close animation the cap state may still warrant the button.
    window.setTimeout(sync, MOTION_DURATION_MS + 40);
    if (!viaHistory && backEntryId) {
      // User-initiated close (button / Esc / send): unwind the history
      // entry pushed on open so the next back leaves the page instead of
      // re-entering this session.
      window.AgentoCBackHandler?.pop?.(backEntryId);
    }
    if (viewportRafId) {
      window.cancelAnimationFrame(viewportRafId);
      viewportRafId = 0;
    }
    lastVvHeight = -1;
    lastVvTop = -1;
    backEntryId = null;
  }

  function send() {
    if (!sendBtn) return;
    if (sendBtn.disabled) {
      // No target session or empty draft: keep the draft, collapse instead.
      close();
      return;
    }
    // Hand the draft to the main composer, collapse without writing back,
    // and route through the standard send path so every existing side
    // effect (local echo, pending state, draft clearing) stays intact.
    msgInput.value = fullscreenInput.value;
    fullscreenInput.value = "";
    close({ skipSync: true });
    sendBtn.click();
  }

  expandBtn.addEventListener("click", () => {
    open();
  });
  fullscreenCloseBtn.addEventListener("click", () => close());
  fullscreenSendBtn.addEventListener("click", send);
  fullscreenInput.addEventListener("input", () => {
    // Live-sync into the main composer so draft persistence and send
    // availability reflect what is being typed full-screen.
    msgInput.value = fullscreenInput.value;
    msgInput.dispatchEvent(new Event("input"));
  });
  fullscreenInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.visualViewport?.addEventListener("resize", scheduleSyncViewport);
  window.visualViewport?.addEventListener("scroll", scheduleSyncViewport);

  window.AgentoCComposerFullscreen = { sync, open, close };
})();
