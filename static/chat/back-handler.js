// Unified Android back button manager. Browsers route the Android back
// button/gesture through history, so every open overlay (menu, popover,
// sheet, dialog) registers here: each active layer owns one history entry
// tagged with its id, and popstate consumes the matching entry by invoking
// its onBack (first back closes the top layer, further
// backs leave the page). Layers register on open and unregister on close;
// unregistering a top layer unwinds its history entry. Falls back to a
// silent no-op where history is unavailable (sandboxed WebViews); Esc
// handlers in the layers keep working regardless.
(function initAgentoCBackHandler() {
  "use strict";

  let supported = false;
  try {
    supported = typeof history !== "undefined" && typeof history.pushState === "function";
  } catch {
    supported = false;
  }

  // id -> { onBack }; stack keeps open order with the top layer first.
  const entries = new Map();
  const stack = [];
  let nextId = 0;

  function removeEntry(id) {
    entries.delete(id);
    const idx = stack.indexOf(id);
    if (idx >= 0) stack.splice(idx, 1);
  }

  function consumeTop() {
    if (stack.length === 0) return;
    const id = stack[0];
    const entry = entries.get(id);
    if (!entry) return;
    removeEntry(id);
    let consumed = true;
    try {
      consumed = entry.onBack() !== false;
    } catch {
      consumed = true;
    }
    if (!consumed) {
      // The layer refused to close: restore its history entry so the next
      // back retries it instead of leaving the page.
      try {
        history.pushState({ backEntryId: id }, "");
        entries.set(id, entry);
        stack.unshift(id);
      } catch {
        supported = false;
      }
    }
  }

  // Set by pop() right before it unwinds an entry with history.back();
  // the popstate arriving from that unwind must not consume anything.
  let suppressNextPopstate = false;
  let lastPopstateHandled = false;

  function clearLastPopstateHandled() {
    // Keep this visible to later popstate listeners during this dispatch only.
    // Session navigation listens after this manager and must not treat an
    // overlay close as a session-history back.
    queueMicrotask(() => {
      lastPopstateHandled = false;
    });
  }

  function onPopState(event) {
    lastPopstateHandled = false;
    if (suppressNextPopstate) {
      suppressNextPopstate = false;
      lastPopstateHandled = true;
      clearLastPopstateHandled();
      return;
    }
    // popstate reports the entry the history *arrived at*; the layer that
    // was just left is our stack top, so a back always consumes the top.
    if (stack.length > 0) {
      lastPopstateHandled = true;
      consumeTop();
      clearLastPopstateHandled();
    }
  }

  function push(entry) {
    if (!supported || !entry || typeof entry.onBack !== "function") return null;
    const id = typeof entry.id === "string" && entry.id
      ? entry.id
      : `back-${++nextId}`;
    if (entries.has(id)) {
      // Re-open of an already-registered layer: refresh the callback.
      entries.get(id).onBack = entry.onBack;
      return id;
    }
    entries.set(id, { onBack: entry.onBack });
    stack.unshift(id);
    try {
      history.pushState({
        ...(history.state && typeof history.state === "object" ? history.state : {}),
        backEntryId: id,
      }, "");
    } catch {
      removeEntry(id);
      supported = false;
      return null;
    }
    return id;
  }

  function pop(id) {
    if (!supported || !id || !entries.has(id)) return;
    const wasTop = stack.length > 0 && stack[0] === id;
    removeEntry(id);
    if (wasTop && history.state && history.state.backEntryId === id) {
      // Unwind this layer's history entry right away; the popstate it
      // fires is suppressed so nothing below it gets consumed.
      try {
        suppressNextPopstate = true;
        history.back();
      } catch {
        supported = false;
      }
    }
    // Non-top layers keep their (now orphaned) history entry; a later back
    // skips it silently instead of mis-closing a still-open layer.
  }

  function active() {
    return stack.length > 0;
  }

  if (supported) {
    window.addEventListener("popstate", onPopState);
  }

  window.AgentoCBackHandler = {
    push,
    pop,
    active,
    wasLastPopstateHandled: () => lastPopstateHandled,
    isSupported: () => supported,
  };
})();
