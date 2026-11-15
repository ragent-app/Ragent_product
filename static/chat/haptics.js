// Restrained haptic feedback for meaningful state transitions on touch
// devices. Patterns stay short (<150ms total), the API is a no-op where the
// platform has no vibrate support (iOS Safari), and playback is gated by the
// system reduced-motion preference and document visibility so background
// runs never buzz the user. Wired at decision-sheet approval, stop-run, and
// run terminal-state transitions (see observeRunState).
(function initRagentHaptics() {
  "use strict";

  // Vibrate patterns are alternating on/off milliseconds. All four stay
  // under 150ms total: enough to be felt, short enough not to nag.
  const PATTERNS = {
    // Light double tap — a decision went through.
    approval: [10, 50, 10],
    // Two longer pulses — the user aborted an active run.
    danger: [20, 40, 20],
    // Three quick taps — the run finished successfully.
    complete: [10, 40, 10, 40, 10],
    // Short-short-long tail — the run failed.
    fail: [10, 40, 10, 40, 30],
  };
  const SAME_KIND_THROTTLE_MS = 600;
  const RUN_TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
  const RUN_SUCCESS_STATES = new Set(["completed"]);

  const lastPlayedAt = {};
  let lastObservedRun = null;

  function prefersReducedMotion() {
    if (typeof window.RagentMotion?.prefersReducedMotion === "function") {
      return window.RagentMotion.prefersReducedMotion();
    }
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function isSupported() {
    return typeof navigator !== "undefined"
      && typeof navigator.vibrate === "function";
  }

  function play(kind) {
    const pattern = PATTERNS[kind];
    if (!pattern || !isSupported()) return false;
    // Background runs completing must not buzz the user.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return false;
    }
    // Respect the system reduced-motion preference as the closest available
    // signal for "do not disturb" (no dedicated haptics toggle exists yet).
    if (prefersReducedMotion()) return false;
    const now = Date.now();
    if (now - (lastPlayedAt[kind] || 0) < SAME_KIND_THROTTLE_MS) return false;
    lastPlayedAt[kind] = now;
    try {
      navigator.vibrate(pattern);
      return true;
    } catch {
      return false;
    }
  }

  // Incremental observer for run terminal transitions, called with the
  // freshly attached session snapshot. It only fires on a state change of
  // the same runId, so entering a session that already finished (or paging
  // through history) never vibrates. cancelled is skipped on purpose: the
  // stop button already played the danger pulse at the moment of the user's
  // action.
  function observeRunState(session) {
    const run = session?.activity?.run;
    if (!run) return;
    const runId = String(run.runId || "").trim();
    const state = String(run.state || "").trim();
    if (!runId || !state) return;
    const previous = lastObservedRun;
    lastObservedRun = { runId, state };
    if (!previous || previous.runId !== runId) return;
    if (previous.state === state) return;
    if (RUN_TERMINAL_STATES.has(previous.state) || !RUN_TERMINAL_STATES.has(state)) {
      return;
    }
    if (RUN_SUCCESS_STATES.has(state)) {
      play("complete");
    } else if (state === "failed") {
      play("fail");
    }
  }

  window.RagentHaptics = {
    approval: () => play("approval"),
    danger: () => play("danger"),
    complete: () => play("complete"),
    fail: () => play("fail"),
    observeRunState,
    isSupported,
  };
})();
