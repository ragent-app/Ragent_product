(function attachAgentoCDesktopManager(root) {
  "use strict";

  const body = root.document?.body;
  if (!body?.classList.contains("desktop-manager")) return;

  const doc = root.document;
  const nav = doc.getElementById("desktopManagerNav");
  const buttons = [...(nav?.querySelectorAll("[data-desktop-manager-tab]") || [])];
  const heading = doc.getElementById("desktopManagerPageHeading");
  const headingTitle = doc.getElementById("desktopManagerPageTitle");
  const headingDescription = doc.getElementById("desktopManagerPageDescription");
  const subpageHeader = doc.getElementById("sidebarSubpageHeader");
  const backButton = doc.getElementById("sidebarSubpageCloseBtn");
  const aboutPanel = doc.getElementById("desktopManagerAboutPanel");
  const updateButton = doc.getElementById("desktopManagerUpdateBtn");
  const checkButton = doc.getElementById("desktopManagerCheckUpdateBtn");
  const currentVersion = doc.getElementById("desktopManagerCurrentVersion");
  const latestVersion = doc.getElementById("desktopManagerLatestVersion");
  const updateStatus = doc.getElementById("desktopManagerUpdateStatus");
  const pairingPanel = doc.getElementById("desktopManagerPairingPanel");
  const pairingButton = doc.getElementById("desktopManagerStartPairingBtn");
  const externalStatus = doc.getElementById("desktopManagerExternalStatus");
  const settingsPanels = [
    "settingsPanel",
    "modelProvidersPanel",
    "harnessesPanel",
    "accountPolicyPanel",
  ].map((id) => doc.getElementById(id)).filter(Boolean);
  const pageCopy = {
    about: ["desktopManager.page.about.title", "desktopManager.page.about.description", "About", "Version information and updates for Ragent."],
    account: [
      "desktopManager.page.account.title",
      "desktopManager.page.account.description",
      "Accounts & permissions",
      "Manage Google Owner sign-in, trusted devices, and execution permissions.",
    ],
    harnesses: [
      "desktopManager.page.harnesses.title",
      "desktopManager.page.harnesses.description",
      "Harness management",
      "Install, update, or remove Ragent runtimes on this computer.",
    ],
    providers: [
      "desktopManager.page.providers.title",
      "desktopManager.page.providers.description",
      "Model providers",
      "Manage provider accounts and API gateways for this workbench.",
    ],
    pairing: [
      "desktopManager.page.pairing.title",
      "desktopManager.page.pairing.description",
      "Phone pairing",
      "Connect an Android phone securely to this computer.",
    ],
  };

  function translate(key, fallback) {
    const value = root.agentocT?.(key);
    return value && value !== key ? value : fallback;
  }

  function select(name) {
    for (const button of buttons) {
      if (button.dataset.desktopManagerTab === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    body.dataset.desktopManagerTab = name;
  }

  function updatePageHeading(name) {
    const [titleKey, descriptionKey, titleFallback, descriptionFallback] = pageCopy[name] || pageCopy.account;
    const title = translate(titleKey, titleFallback);
    if (headingTitle) headingTitle.textContent = title;
    if (headingDescription) headingDescription.textContent = translate(descriptionKey, descriptionFallback);
    if (heading) heading.hidden = false;
    doc.title = `Ragent · ${title}`;
  }

  function hideSubpageHeader() {
    if (subpageHeader) subpageHeader.hidden = true;
  }

  function hideCustomPanels() {
    for (const panel of [pairingPanel, aboutPanel]) if (panel) {
      panel.hidden = true;
      panel.classList.remove("visible");
    }
  }

  function switchTo(tab, managerName) {
    hideCustomPanels();
    if (typeof root.switchTab === "function") root.switchTab(tab, { animate: false });
    if (managerName === "account") {
      const settingsPanel = doc.getElementById("settingsPanel");
      if (settingsPanel) settingsPanel.hidden = false;
    }
    hideSubpageHeader();
    select(managerName);
    updatePageHeading(managerName);
    if (managerName === "account") root.AgentoCCrossDevicePanel?.refreshManager?.();
  }

  function showPairingPage() {
    hideCustomPanels();
    if (typeof root.switchTab === "function") root.switchTab("settings", { animate: false });
    for (const panel of settingsPanels) {
      panel.hidden = true;
      panel.classList.remove("visible");
    }
    if (pairingPanel) {
      pairingPanel.hidden = false;
      pairingPanel.classList.add("visible");
    }
    hideSubpageHeader();
    select("pairing");
    updatePageHeading("pairing");
  }

  function showAbout() {
    hideCustomPanels();
    root.switchTab?.("settings", { animate: false });
    for (const panel of settingsPanels) { panel.hidden = true; panel.classList.remove("visible"); }
    if (aboutPanel) { aboutPanel.hidden = false; aboutPanel.classList.add("visible"); }
    hideSubpageHeader(); select("about"); updatePageHeading("about");
  }

  function renderUpdate(state) {
    if (!state) return;
    if (currentVersion) currentVersion.textContent = state.currentVersion || "—";
    if (latestVersion) latestVersion.textContent = state.latestVersion || "—";
    const busy = ["downloading", "waiting", "installing"].includes(state.status);
    if (updateButton) { updateButton.hidden = !state.updateAvailable; updateButton.disabled = busy; }
    if (checkButton) checkButton.disabled = state.status === "checking" || busy;
    if (updateStatus) {
      const key = ["checking", "error", "downloading", "waiting", "installing", "installed", "installError"].includes(state.status) ? state.status : state.buildChanged ? "buildChanged" : state.updateAvailable ? "available" : state.buildIdentityUnavailable ? "buildUnknown" : "current";
      const fallback = { checking: "Checking for updates…", error: "Could not check for updates. Please try again.", available: "A new version is available.", buildChanged: "The published build differs from this installation.", buildUnknown: "The published build could not be compared with this installation.", current: "You are up to date.", downloading: "Downloading update…", waiting: "Waiting for running tasks to finish…", installing: "Installing update…", installed: "Update installed. Restarting…", installError: "Update failed. Please retry or download the installer from the website." };
      updateStatus.textContent = translate(`desktopManager.updateStatus.${key}`, fallback[key]) + (key === "downloading" && Number.isInteger(state.progress) ? ` ${state.progress}%` : "");
    }
  }
  root.agentocDesktop?.onUpdateState?.(renderUpdate);
  root.agentocDesktop?.getUpdateState?.().then(renderUpdate).catch(() => renderUpdate({ status: "error" }));
  checkButton?.addEventListener("click", async () => {
    renderUpdate({ status: "checking" });
    try { renderUpdate(await root.agentocDesktop.checkForUpdates()); } catch { renderUpdate({ status: "error" }); }
  });
  updateButton?.addEventListener("click", async () => {
    try { if (await root.agentocDesktop.openUpdate()) return; } catch {}
    const message = translate("desktopManager.updateStatus.installError", "Update failed. Please retry or download the installer from the website.");
    if (updateStatus) updateStatus.textContent = message;
    if (externalStatus) { externalStatus.textContent = message; externalStatus.hidden = false; }
  });

  function showAccount() {
    switchTo("settings", "account");
  }

  function openPairing() {
    select("pairing");
    updatePageHeading("pairing");
    root.AgentoCCrossDevicePanel?.open?.({ view: "register" });
  }

  doc.querySelector(".desktop-manager-account-group")?.removeAttribute("hidden");
  doc.querySelector(".desktop-manager-devices-group")?.removeAttribute("hidden");
  doc.getElementById("desktopManagerHeader")?.removeAttribute("hidden");
  nav?.removeAttribute("hidden");
  root.AgentoCDesktopManager = Object.freeze({ showAccount, openPairing });
  root.agentocDesktop?.onExternalOpenFailed?.(() => {
    if (!externalStatus) return;
    externalStatus.textContent = translate(
      "desktopManager.externalOpenFailed",
      "Could not open the sign-in page in your browser.",
    );
    externalStatus.hidden = false;
  });

  nav?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-desktop-manager-tab]");
    if (!button || !nav.contains(button)) return;
    switch (button.dataset.desktopManagerTab) {
      case "account": showAccount(); break;
      case "harnesses": switchTo("harnesses", "harnesses"); break;
      case "providers": switchTo("model-providers", "providers"); break;
      case "pairing": showPairingPage(); break;
      case "about": showAbout(); break;
    }
  });

  pairingButton?.addEventListener("click", openPairing);
  doc.getElementById("accountPolicyOpenBtn")?.addEventListener("click", () => {
    if (heading) heading.hidden = true;
    select("account");
  }, true);

  // The shared WebUI returns to Sessions when closing a subpage. The manager
  // has no chat surface, so its back affordance always returns to its account
  // landing panel instead.
  backButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    showAccount();
  }, true);

  const activeTab = typeof root.getActiveSidebarTabValue === "function"
    ? root.getActiveSidebarTabValue()
    : "settings";
  if (activeTab === "harnesses") switchTo("harnesses", "harnesses");
  else if (activeTab === "model-providers") switchTo("model-providers", "providers");
  else if (activeTab === "account-policy") {
    root.switchTab?.("account-policy", { animate: false });
    select("account");
    if (heading) heading.hidden = true;
  } else showAccount();
})(window);
