// L1 device bar: the current-device button and add-device action that sit
// under the sidebar brand. The actions open the cross-device MD3 workspace;
// the workspace owns the Google binding and device registry.
//
// Backend integration contract:
//   - GET  /api/device     -> { id, name } of the machine this frontend runs on
//   - /api/auth/google/* and /api/device-pairing/* -> cross-device workspace actions
// The UI wiring and the visibility sync below do not need to change.
(function (root) {
  "use strict";

  function t(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  // The current device endpoint is optional in the first backend phase. Keep
  // a readable local fallback until an instance-specific name is available.
  const DEVICE_INFO_ENDPOINT = "/api/device";

  async function fetchDeviceInfo() {
    try {
      const res = await fetch(DEVICE_INFO_ENDPOINT, { credentials: "same-origin" });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data.name === "string" ? data : null;
    } catch {
      return null;
    }
  }

  async function getDeviceInfo() {
    const activeTarget = root.RagentTargetRuntime?.getActiveTarget?.();
    if (activeTarget?.targetId) {
      return { id: activeTarget.targetId, name: activeTarget.label || t("sidebar.device.localName") };
    }
    const remote = await fetchDeviceInfo();
    return remote || { id: "local", name: t("sidebar.device.localName") };
  }

  async function addDevice() {
    if (root.RagentCrossDevicePanel?.open) {
      root.RagentCrossDevicePanel.open({ view: "register" });
      return { ok: true };
    }
    const message = t("sidebar.device.unavailable");
    root.showSystemToast?.(message, "info");
    return { ok: false, reason: "panel-unavailable" };
  }

  async function openDeviceManager() {
    if (root.RagentCrossDevicePanel?.open) {
      root.RagentCrossDevicePanel.open({ view: "devices" });
      return { ok: true };
    }
    const message = t("sidebar.device.unavailable");
    root.showSystemToast?.(message, "info");
    return { ok: false, reason: "panel-unavailable" };
  }

  // The device bar belongs to the L1 projects level: it hides whenever the
  // app bar hides (search mode / agents / settings subpages) and whenever
  // the sidebar is inside a project's L2 session list.
  function syncSidebarDeviceBar() {
    const bar = document.getElementById("sidebarDeviceBar");
    if (!bar) return;
    const appBarHidden = typeof root.sidebarAppBar !== "undefined" && root.sidebarAppBar
      ? root.sidebarAppBar.hidden
      : true;
    const level = typeof root.getSidebarViewLevel === "function"
      ? root.getSidebarViewLevel()
      : "projects";
    bar.hidden = appBarHidden || level !== "projects";
  }

  async function refresh() {
    const textEl = document.getElementById("sidebarDeviceNameText");
    if (!textEl) return;
    const info = await getDeviceInfo();
    // textContent: the name is untrusted backend data — never innerHTML.
    textEl.textContent = info?.name || t("sidebar.device.localName");
  }

  function wireDeviceBar() {
    const nameBtn = document.getElementById("sidebarDeviceNameBtn");
    const addBtn = document.getElementById("sidebarDeviceAddBtn");
    if (nameBtn && !nameBtn.dataset.deviceBarBound) {
      nameBtn.dataset.deviceBarBound = "1";
      nameBtn.addEventListener("click", () => { void openDeviceManager(); });
    }
    if (addBtn && !addBtn.dataset.deviceBarBound) {
      addBtn.dataset.deviceBarBound = "1";
      addBtn.addEventListener("click", () => { void addDevice(); });
    }
    void refresh();
    syncSidebarDeviceBar();
  }

  root.RagentDeviceBar = Object.freeze({
    getDeviceInfo,
    openDeviceManager,
    addDevice,
    refresh,
  });
  root.syncSidebarDeviceBar = syncSidebarDeviceBar;
  root.addEventListener?.("ragent:target-change", () => { void refresh(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireDeviceBar, { once: true });
  } else {
    wireDeviceBar();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
