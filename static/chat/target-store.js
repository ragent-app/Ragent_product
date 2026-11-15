// Browser-side target directory and active target selection.
// The store contains only non-secret target metadata; credentials remain in
// the selected runtime adapter.
(function attachRagentTargetStore(root) {
  "use strict";

  const STORAGE_KEY = "ragent.active-target-id.v1";
  const STATES = new Set(["paired", "connecting", "online", "degraded", "offline", "revoked"]);
  const listeners = new Set();
  let state = Object.freeze({
    schemaVersion: 1,
    revision: 0,
    targets: Object.freeze([]),
    activeTargetId: null,
  });

  function text(value, max = 256) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized.slice(0, max);
  }

  function normalizeTarget(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const targetId = text(source.targetId || source.instanceId, 160);
    const instanceId = text(source.instanceId || source.targetId, 160);
    if (!targetId || !instanceId) return null;
    const status = text(source.status, 32) || "offline";
    return Object.freeze({
      schemaVersion: 1,
      targetId,
      instanceId,
      deviceKind: text(source.deviceKind, 32) || "computer",
      label: text(source.label || source.name, 128) || targetId,
      platform: text(source.platform, 32),
      status: STATES.has(status) ? status : "offline",
      runtimeVersion: text(source.runtimeVersion, 128),
      capabilities: Object.freeze(Array.from(new Set(
        Array.isArray(source.capabilities) ? source.capabilities.map((value) => text(value, 64)).filter(Boolean) : [],
      )).slice(0, 64)),
      snapshotVersion: Number.isSafeInteger(Number(source.snapshotVersion)) && Number(source.snapshotVersion) >= 0
        ? Number(source.snapshotVersion)
        : 0,
      lastSeenAt: text(source.lastSeenAt, 64),
    });
  }

  function readStoredTargetId() {
    try {
      return text(root.sessionStorage?.getItem(STORAGE_KEY), 160);
    } catch {
      return "";
    }
  }

  function persistTargetId(targetId) {
    try {
      if (targetId) root.sessionStorage?.setItem(STORAGE_KEY, targetId);
      else root.sessionStorage?.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be unavailable in private browsing or embedded WebViews.
    }
  }

  function snapshot() {
    return state;
  }

  function sameTargets(left, right) {
    if (left.length !== right.length) return false;
    return left.every((target, index) => JSON.stringify(target) === JSON.stringify(right[index]));
  }

  function notify(previous) {
    const next = state;
    if (next.activeTargetId === previous.activeTargetId && sameTargets(next.targets, previous.targets)) return;
    for (const listener of listeners) {
      try { listener(next, previous); } catch (error) { root.setTimeout?.(() => { throw error; }, 0); }
    }
    if (typeof root.CustomEvent === "function" && typeof root.dispatchEvent === "function") {
      root.dispatchEvent(new root.CustomEvent("ragent:target-change", { detail: next }));
    }
  }

  function replaceTargets(targets, { activeTargetId = null, preserveActive = true, revision = state.revision } = {}) {
    const nextTargets = [];
    const seen = new Set();
    for (const input of Array.isArray(targets) ? targets : []) {
      const target = normalizeTarget(input);
      if (!target || seen.has(target.targetId)) continue;
      seen.add(target.targetId);
      nextTargets.push(target);
    }
    const requested = text(activeTargetId, 160);
    const previous = state;
    const preferred = requested
      || (preserveActive ? state.activeTargetId : "")
      || readStoredTargetId();
    const active = nextTargets.find((target) => target.targetId === preferred)?.targetId
      || nextTargets[0]?.targetId
      || null;
    state = Object.freeze({
      schemaVersion: 1,
      revision: Number.isSafeInteger(Number(revision)) && Number(revision) >= 0 ? Number(revision) : state.revision,
      targets: Object.freeze(nextTargets),
      activeTargetId: active,
    });
    persistTargetId(active);
    notify(previous);
    return state;
  }

  function select(targetId) {
    const normalized = text(targetId, 160);
    const target = state.targets.find((entry) => entry.targetId === normalized);
    if (!target) {
      const error = new Error("Target runtime was not found");
      error.code = "TARGET_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    if (state.activeTargetId === target.targetId) return target;
    const previous = state;
    state = Object.freeze({ ...state, activeTargetId: target.targetId });
    persistTargetId(target.targetId);
    notify(previous);
    return target;
  }

  function updateTarget(targetId, patch = {}, { revision = state.revision } = {}) {
    const normalized = text(targetId, 160);
    if (!normalized) return state;
    const previous = state;
    const targets = state.targets.map((target) => target.targetId === normalized
      ? normalizeTarget({
          ...target,
          ...patch,
          // Reconciliation can complete out of order (summary refresh versus
          // a command response). A newer target revision must never be
          // replaced by an older projection.
          ...(Number.isSafeInteger(Number(patch.snapshotVersion))
            && Number(patch.snapshotVersion) < target.snapshotVersion
            ? { snapshotVersion: target.snapshotVersion }
            : {}),
        })
      : target).filter(Boolean);
    state = Object.freeze({
      ...state,
      revision: Number.isSafeInteger(Number(revision)) && Number(revision) >= state.revision
        ? Number(revision)
        : state.revision,
      targets: Object.freeze(targets),
    });
    notify(previous);
    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    listener(state, state);
    return () => listeners.delete(listener);
  }

  root.RagentTargetStore = Object.freeze({
    getSnapshot: snapshot,
    getActiveTarget: () => state.targets.find((target) => target.targetId === state.activeTargetId) || null,
    getTarget: (targetId) => state.targets.find((target) => target.targetId === text(targetId, 160)) || null,
    replaceTargets,
    select,
    updateTarget,
    subscribe,
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
