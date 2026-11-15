// Shared motion helpers for UI presence and local disclosure transitions.
(function initRagentMotion() {
  const presenceStates = new WeakMap();
  const activePresenceStates = new Set();
  const reducedMotionSubscribers = new Set();
  const layoutMotionControllers = new Set();
  const reduceMotionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

  function prefersReducedMotion() {
    return reduceMotionQuery?.matches === true;
  }

  function getState(el) {
    let state = presenceStates.get(el);
    if (!state) {
      state = {
        generation: 0,
        rafId: null,
        rafIsTimeout: false,
        timerId: null,
        desiredOpen: !el.hidden && el.classList.contains("is-open"),
        settledOpen: !el.hidden && el.classList.contains("is-open"),
      };
      presenceStates.set(el, state);
    }
    return state;
  }

  function cancelPending(state) {
    if (state.rafId !== null) {
      if (state.rafIsTimeout) clearTimeout(state.rafId);
      else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.rafId);
      state.rafId = null;
      state.rafIsTimeout = false;
    }
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
  }

  function settle(el, state, open, callback) {
    if (state.settledOpen === open) return;
    state.settledOpen = open;
    if (typeof callback === "function") callback();
  }

  function applyFinalState(el, state, open, options, { notify = true } = {}) {
    const {
      openClass = "is-open",
      closingClass = "is-closing",
      onAfterOpen,
      onAfterClose,
    } = options;
    el.classList.remove(closingClass);
    el.classList.toggle(openClass, open);
    el.hidden = !open;
    if (notify) {
      settle(el, state, open, open ? onAfterOpen : onAfterClose);
    } else {
      state.settledOpen = open;
    }
  }

  function handleReducedMotionChange(event) {
    const reduced = event?.matches === true || prefersReducedMotion();
    for (const entry of Array.from(activePresenceStates)) {
      const { el, state, options } = entry;
      cancelPending(state);
      state.generation += 1;
      applyFinalState(el, state, state.desiredOpen, options);
      activePresenceStates.delete(entry);
    }
    for (const listener of reducedMotionSubscribers) {
      try {
        listener(reduced, event);
      } catch (error) {
        console.warn("[motion] Reduced-motion subscriber failed:", error.message);
      }
    }
    for (const controller of Array.from(layoutMotionControllers)) {
      controller.setReducedMotion?.(reduced);
    }
  }

  if (reduceMotionQuery) {
    if (typeof reduceMotionQuery.addEventListener === "function") {
      reduceMotionQuery.addEventListener("change", handleReducedMotionChange);
    } else if (typeof reduceMotionQuery.addListener === "function") {
      reduceMotionQuery.addListener(handleReducedMotionChange);
    }
  }

  function setPresence(el, open, options = {}) {
    if (!el) return;
    const {
      openClass = "is-open",
      closingClass = "is-closing",
      duration = 180,
      onAfterOpen,
      onAfterClose,
    } = options;
    const state = getState(el);
    state.generation += 1;
    const generation = state.generation;
    state.desiredOpen = open === true;
    state.options = options;
    cancelPending(state);
    const activeEntry = { el, state, options };
    activePresenceStates.forEach((entry) => {
      if (entry.el === el) activePresenceStates.delete(entry);
    });
    activePresenceStates.add(activeEntry);

    if (open) {
      el.hidden = false;
      el.classList.remove(closingClass);
      if (prefersReducedMotion()) {
        applyFinalState(el, state, true, options);
        activePresenceStates.delete(activeEntry);
        return;
      }
      const openFrame = () => {
        state.rafId = null;
        if (state.generation !== generation || state.desiredOpen !== true) return;
        el.classList.add(openClass);
        el.classList.remove(closingClass);
        settle(el, state, true, onAfterOpen);
        activePresenceStates.forEach((entry) => {
          if (entry.el === el) activePresenceStates.delete(entry);
        });
      };
      state.rafIsTimeout = typeof requestAnimationFrame !== "function";
      state.rafId = state.rafIsTimeout
        ? setTimeout(openFrame, 0)
        : requestAnimationFrame(openFrame);
      return;
    }

    el.classList.remove(openClass);
    if (prefersReducedMotion() || el.hidden) {
      applyFinalState(el, state, false, options);
      activePresenceStates.delete(activeEntry);
      return;
    }

    el.classList.add(closingClass);
    const closeFrame = () => {
      state.timerId = null;
      if (state.generation !== generation || state.desiredOpen !== false) return;
      applyFinalState(el, state, false, options);
      activePresenceStates.delete(activeEntry);
    };
    state.timerId = setTimeout(closeFrame, Math.max(0, duration));
  }

  function cancelPresence(el) {
    if (!el) return;
    const state = presenceStates.get(el);
    if (!state) return;
    cancelPending(state);
    state.generation += 1;
    applyFinalState(el, state, state.desiredOpen, state.options || {}, { notify: false });
    activePresenceStates.forEach((entry) => {
      if (entry.el === el) activePresenceStates.delete(entry);
    });
  }

  function subscribeReducedMotion(listener) {
    if (typeof listener !== "function") return () => {};
    reducedMotionSubscribers.add(listener);
    return () => reducedMotionSubscribers.delete(listener);
  }

  function setDisclosure(el, open, options = {}) {
    if (!el) return;
    const {
      openClass = "is-open",
      collapsedClass = "is-collapsed",
      hidden = false,
    } = options;
    el.classList.toggle(openClass, open === true);
    el.classList.toggle(collapsedClass, open !== true);
    if (hidden) el.hidden = open !== true;
  }

  // Animate the spatial consequences of dynamic session UI changes with a
  // FLIP-style compositor transition. The DOM is allowed to reach its final
  // state immediately; only elements that moved because another surface grew
  // or collapsed are animated from their previous position. This keeps the
  // transcript and composer readable while avoiding a global `height: auto`
  // transition (which is both unreliable and expensive during streaming).
  function observeLayout(root, options = {}) {
    if (!root || typeof root.querySelectorAll !== "function") return () => {};
    const selector = options.selector || [
      ":scope > .messages",
      ":scope > .input-area",
      ".input-stack > #queuedPanel",
      ".input-stack > #inputConfigRow",
    ].join(",");
    const axis = typeof options.axis === "string" ? options.axis.toLowerCase().trim() : "y";
    const allowX = axis === "both" || axis === "x" || axis === "xy";
    const allowY = axis !== "x";
    const duration = Math.max(0, Number(options.duration) || 300);
    const easing = typeof options.easing === "string" && options.easing.trim()
      ? options.easing
      : "cubic-bezier(0.22, 0.61, 0.36, 1)";
    const previousRects = new Map();
    const animations = new Map();
    let frameId = null;
    let disconnected = false;
    let reduced = prefersReducedMotion();

    function schedule(callback) {
      if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(callback);
      }
      return setTimeout(callback, 0);
    }

    function targets() {
      const values = new Set();
      try {
        for (const element of root.querySelectorAll(selector)) {
          if (element && element.getBoundingClientRect) values.add(element);
        }
      } catch {
        // A narrowly scoped selector is progressive enhancement; if an older
        // engine rejects :scope, the rest of the session UI remains usable.
        for (const element of root.children || []) {
          if (element?.getBoundingClientRect) values.add(element);
        }
      }
      return values;
    }

    function isVisible(element) {
      if (!element || element.hidden) return false;
      const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
      return style?.display !== "none" && style?.visibility !== "hidden";
    }

    function measure() {
      const next = new Map();
      for (const element of targets()) {
        if (!isVisible(element)) continue;
        const rect = element.getBoundingClientRect();
        next.set(element, {
          left: Number(rect.left) || 0,
          top: Number(rect.top) || 0,
          width: Number(rect.width) || 0,
          height: Number(rect.height) || 0,
        });
      }
      return next;
    }

    function cancelAnimations() {
      for (const animation of animations.values()) {
        try { animation.cancel(); } catch {}
      }
      animations.clear();
    }

    function shouldIgnoreMutation(mutation) {
      if (!mutation) return true;
      const target = mutation.target;
      // Message content, the home workspace, and Composer internals are not
      // layout surfaces. Their DOM changes are frequent (streaming tokens,
      // optimistic sends, home refreshes) and must never enqueue a page-level
      // FLIP animation. Only the stable chat skeleton and explicit overlay
      // surfaces below are allowed to animate when their geometry changes.
      if (target?.closest?.(".messages-inner, .input-wrapper")) return true;
      if (mutation.type === "attributes" && mutation.attributeName === "class") {
        return target?.classList?.contains?.("streaming") === true;
      }
      return false;
    }

    function animateChanges() {
      frameId = null;
      if (disconnected) return;
      const visualPositions = new Map();
      for (const [element, animation] of animations) {
        if (animation?.playState === "running" && isVisible(element)) {
          const rect = element.getBoundingClientRect();
          visualPositions.set(element, {
            left: Number(rect.left) || 0,
            top: Number(rect.top) || 0,
          });
        }
      }
      cancelAnimations();
      const next = measure();
      for (const element of next.keys()) resizeObserver?.observe?.(element);
      if (reduced) {
        previousRects.clear();
        for (const [element, rect] of next) previousRects.set(element, rect);
        return;
      }

      for (const [element, rect] of next) {
        const previous = previousRects.get(element);
        if (!previous || !isVisible(element)) continue;
        // Keep the spatial cue quiet. The browser has already committed the
        // final layout; this is only a soft settling hint, not a second
        // movement of the Composer or transcript.
        const origin = visualPositions.get(element) || previous;
        const dx = allowX ? Math.round((origin.left - rect.left) * 0.55) : 0;
        const dy = allowY ? Math.round((origin.top - rect.top) * 0.55) : 0;
        if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || Math.abs(dx) > 900 || Math.abs(dy) > 900) {
          continue;
        }
        if (typeof element.animate !== "function" || !("translate" in element.style)) continue;
        try {
          const animation = element.animate(
            [
              { translate: `${dx}px ${dy}px` },
              { translate: "0 0" },
            ],
            { duration, easing, fill: "none" },
          );
          animations.set(element, animation);
          animation.finished
            .catch(() => {})
            .finally(() => {
              if (animations.get(element) === animation) animations.delete(element);
            });
        } catch {
          // Motion is enhancement-only. A browser without animatable translate
          // still gets the final layout immediately.
        }
      }
      previousRects.clear();
      for (const [element, rect] of next) previousRects.set(element, rect);
    }

    function requestAnimation() {
      if (frameId !== null) return;
      frameId = schedule(animateChanges);
    }

    const mutationObserver = typeof MutationObserver === "function"
      ? new MutationObserver((mutations) => {
          if (mutations.every(shouldIgnoreMutation)) return;
          requestAnimation();
        })
      : null;
    mutationObserver?.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-expanded", "data-state", "data-collapsed", "data-capsule-motion"],
    });

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => requestAnimation())
      : null;
    for (const element of targets()) resizeObserver?.observe?.(element);

    const controller = {
      setReducedMotion(value) {
        reduced = value === true;
        if (reduced) {
          cancelAnimations();
          previousRects.clear();
          for (const [element, rect] of measure()) previousRects.set(element, rect);
        }
      },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        if (frameId !== null) {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
          else clearTimeout(frameId);
          frameId = null;
        }
        mutationObserver?.disconnect?.();
        resizeObserver?.disconnect?.();
        cancelAnimations();
        previousRects.clear();
        layoutMotionControllers.delete(controller);
      },
    };
    layoutMotionControllers.add(controller);
    for (const [element, rect] of measure()) previousRects.set(element, rect);

    return () => {
      controller.disconnect();
    };
  }

  window.RagentMotion = {
    prefersReducedMotion,
    subscribeReducedMotion,
    setPresence,
    cancelPresence,
    setDisclosure,
    observeLayout,
  };
})();
