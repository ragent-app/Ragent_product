"use strict";

// Shared action-sentence transition used by the persistent Live Bar and the
// compact mobile activity line. The old sentence slides up and fades out,
// while the new sentence slides up from below and settles into place (上下句切换).
// Old exiting items are immediately cleaned up on rapid updates so text never
// piles up, jitters, or flickers.
(function attachLiveActionTransition(root) {
  const DURATION_MS = 260;
  const CLEANUP_MS = DURATION_MS + 24;

  function makeItem(text, className) {
    const item = document.createElement("span");
    item.className = `live-action-transition__item ${className}`;
    item.textContent = text;
    return item;
  }

  function ensureState(element) {
    if (element.__liveActionTransition) return element.__liveActionTransition;
    const stage = document.createElement("span");
    stage.className = "live-action-transition__stage";
    const current = makeItem("", "is-current");
    stage.append(current);
    element.replaceChildren(stage);
    element.classList.add("live-action-transition");
    const state = { stage, current, text: "", timer: null, token: 0 };
    element.__liveActionTransition = state;
    return state;
  }

  function cleanup(element, state, token) {
    if (state.token !== token) return;
    const exiting = state.stage.querySelectorAll?.(".is-exiting") || [];
    exiting.forEach((item) => item.remove());
    state.current?.classList.remove("is-entering", "is-visible");
    state.current?.classList.add("is-current");
    element.classList.remove("is-transitioning");
    delete element.dataset.transitioning;
    state.timer = null;
  }

  function getText(element) {
    if (!element || typeof element !== "object") return "";
    if (element.__liveActionTransition?.text) return element.__liveActionTransition.text;
    return String(element.textContent || "").trim();
  }

  function setText(element, value) {
    if (!element || typeof element !== "object") return;
    const nextText = String(value || "").trim();
    const state = ensureState(element);
    if (state.text === nextText) return;
    if (!state.text && !state.current.textContent) {
      state.current.textContent = nextText;
      state.text = nextText;
      if (!element.ownerDocument) element.textContent = nextText;
      return;
    }
    if (state.timer) clearTimeout(state.timer);

    // Immediately remove older exiting items to prevent piling up on rapid updates
    const oldExiting = state.stage.querySelectorAll?.(".is-exiting") || [];
    oldExiting.forEach((item) => item.remove());

    const previous = state.current;
    const incoming = makeItem(nextText, "is-entering");
    previous?.classList.remove("is-current", "is-entering", "is-visible");
    previous?.classList.add("is-exiting");
    previous?.setAttribute("aria-hidden", "true");
    incoming.removeAttribute("aria-hidden");
    state.stage.append(incoming);
    state.current = incoming;
    state.text = nextText;
    state.token += 1;
    const token = state.token;
    element.classList.add("is-transitioning");
    element.dataset.transitioning = "true";
    state.timer = setTimeout(() => cleanup(element, state, token), CLEANUP_MS);

    // The lightweight test DOM used by the existing renderer tests does not
    // calculate parent textContent from children. Keep its observable value
    // in sync without touching real DOM text nodes (which would remove the
    // transition layers).
    if (!element.ownerDocument) element.textContent = nextText;
  }

  root.RagentLiveActionTransition = { setText, getText };
})(typeof globalThis !== "undefined" ? globalThis : window);
