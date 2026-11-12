// Cross-device workspace. This is the frontend surface for the Google owner
// binding, L2 device list, and owner-side device registration contract
// documented in docs/agentoc-cross-device-frontend-handoff-2026-08-09.md.
(function (root) {
  "use strict";

  const overlay = document.getElementById("crossDeviceOverlay");
  const sheet = document.getElementById("crossDeviceSheet");
  const managerMode = document.body?.classList.contains("desktop-manager") === true;
  const modalStatusEl = document.getElementById("crossDeviceStatus");
  const managerStatusEl = managerMode ? document.getElementById("desktopManagerAccountStatus") : null;
  const statusEl = managerStatusEl || modalStatusEl;
  const content = document.querySelector(".cross-device-content");
  const accountContent = document.getElementById(managerMode ? "desktopManagerGoogleAccountContent" : "crossDeviceAccountContent");
  const devicesContent = document.getElementById(managerMode ? "desktopManagerDevicesContent" : "crossDeviceDevicesContent");
  const registerContent = document.getElementById("crossDeviceRegisterContent");
  const tabs = Array.from(document.querySelectorAll("[data-cross-device-view]"));
  const views = Array.from(document.querySelectorAll("[data-cross-device-panel]"));
  const closeButton = document.getElementById("crossDeviceClose");
  let activeView = "account";
  let restoreFocus = null;
  let backEntryId = null;
  let focusScopeDeactivate = null;
  let devicesCache = [];
  let pairingState = null;
  let pairingPollTimer = null;
  let temporaryPairingState = null;
  let temporaryPairingPollTimer = null;
  let pairingMode = "formal";
  let pairingAccountBound = null;
  let pairingStatusRequest = 0;
  let managerClaim = null;
  let managerClaimTimer = null;
  // 入口健康探测的短缓存（P1-⑤）：探测失败不阻塞展示，60s 内复用结果。
  const deviceHealthCache = new Map();
  const DEVICE_HEALTH_TTL_MS = 60000;

  function t(key, vars) {
    return typeof root.agentocT === "function" ? root.agentocT(key, vars) : key;
  }

  function fallback(key, value, vars) {
    const translated = t(key, vars);
    const text = translated === key ? value : translated;
    return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : match
    ));
  }

  function ragentLoginCopy(english, chinese) {
    const language = typeof root.agentocGetActiveUiLanguage === "function"
      ? root.agentocGetActiveUiLanguage() : document.documentElement.lang;
    return String(language || "").toLowerCase().startsWith("zh") ? chinese : english;
  }

  function make(tag, className = "", text = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function makeIcon(name, className = "") {
    const icon = make("span", className);
    icon.dataset.icon = name;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function action(label, onClick, tone = "neutral") {
    const button = make("button", "cross-device-action", label);
    button.type = "button";
    if (tone !== "neutral") button.dataset.tone = tone;
    button.addEventListener("click", () => void onClick(button));
    return button;
  }

  function setBusy(button, busy, busyLabel = "") {
    if (!button) return;
    if (busy) {
      button.dataset.defaultText = button.textContent || "";
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      if (busyLabel) button.textContent = busyLabel;
    } else {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (button.dataset.defaultText) {
        button.textContent = button.dataset.defaultText;
        delete button.dataset.defaultText;
      }
    }
  }

  function clear(element) {
    while (element?.firstChild) element.removeChild(element.firstChild);
  }

  function showStatus(message, tone = "info") {
    const activeStatus = managerMode && activeView === "register" ? modalStatusEl : statusEl;
    if (!activeStatus) return;
    if (modalStatusEl && modalStatusEl !== activeStatus) modalStatusEl.hidden = true;
    if (managerStatusEl && managerStatusEl !== activeStatus) managerStatusEl.hidden = true;
    activeStatus.hidden = !message;
    activeStatus.dataset.tone = tone;
    activeStatus.textContent = message || "";
  }

  function handleError(error, fallbackMessage) {
    if (error?.code === "temporary_control_use_account_pairing") {
      showStatus(fallback("crossDevice.control.useAccountPairing", "This computer is signed in. Use the ordinary pairing code to authorize the phone."), "error");
      return;
    }
    if (error?.code === "temporary_control_broker_instance_unbound") {
      showStatus(fallback("crossDevice.control.bindRequired", "The server does not yet support pairing without Google sign-in. Update the temporary-control service and retry."), "error");
      return;
    }
    const message = String(error?.message || "").trim() || fallbackMessage;
    showStatus(message, "error");
  }

  async function api(path, options = {}) {
    const requestOptions = {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    };
    const result = typeof root.fetchJsonOrRedirect === "function"
      ? await root.fetchJsonOrRedirect(path, requestOptions)
      : await fetch(path, requestOptions).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data?.error || `Request failed (${response.status})`);
          error.code = String(data?.code || "").trim();
          error.status = response.status;
          throw error;
        }
        return data;
      });
    if (result && typeof result.json === "function") return result.json();
    return result;
  }

  function formatDate(value) {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return fallback("crossDevice.unknown", "Unknown");
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  function shortId(value) {
    const id = String(value || "").trim();
    return id.length > 10 ? `${id.slice(0, 10)}…` : id || fallback("crossDevice.account.unnamed", "Unnamed device");
  }

  function normalizeEntryUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  function entryUrlErrorMessage(error) {
    if (error?.status === 400) return fallback("crossDevice.devices.entryUrlInvalid", "Enter a valid http(s) entry URL.");
    if (error?.status === 403) return fallback("crossDevice.devices.entryUrlForbidden", "Only the owner can update device entry URLs.");
    if (error?.status === 404) return fallback("crossDevice.devices.entryUrlNotFound", "That trusted device is no longer available.");
    return fallback("crossDevice.devices.entryUrlFailed", "Could not update the device entry URL.");
  }

  function switchErrorMessage(error) {
    if (error?.status === 400) return fallback("crossDevice.switch.targetUrlMissing", "Register a valid entry URL for this device first.");
    if (error?.status === 403) return fallback("crossDevice.switch.forbidden", "Owner access is required to switch devices.");
    if (error?.status === 404) return fallback("crossDevice.switch.targetNotFound", "That trusted device is no longer available. Refresh the device list.");
    if (error?.status === 409) return fallback("crossDevice.switch.pending", "A switch link for this device is already pending. Try again shortly.");
    if (error?.status === 410) return fallback("crossDevice.switch.expired", "The switch link expired. Start the switch again.");
    return fallback("crossDevice.switch.failed", "Could not start the switch.");
  }

  function comparablePublicKey(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function isAccountComputer(device) {
    const kind = String(device?.deviceKind || "").trim().toLowerCase();
    // Older directory rows did not carry deviceKind. Preserve those rows until
    // the Accounts migration has populated the field everywhere.
    return !kind || kind === "computer";
  }

  function findLocalTrustedDevice(accountDevice, localDevices) {
    const ids = new Set([
      String(accountDevice?.deviceId || "").trim(),
      String(accountDevice?.instanceId || "").trim(),
    ].filter(Boolean));
    const byId = localDevices.find((device) => ids.has(String(device?.id || "").trim()));
    if (byId) return byId;
    const instanceKey = comparablePublicKey(accountDevice?.instancePublicKey);
    if (!instanceKey) return null;
    return localDevices.find((device) => comparablePublicKey(device?.devicePublicKey) === instanceKey) || null;
  }

  function productPath(path) {
    return typeof root.agentocResolveProductPath === "function"
      ? root.agentocResolveProductPath(path)
      : path;
  }

  function stopPairingPoll() {
    if (pairingPollTimer) root.clearTimeout(pairingPollTimer);
    pairingPollTimer = null;
    if (temporaryPairingPollTimer) root.clearTimeout(temporaryPairingPollTimer);
    temporaryPairingPollTimer = null;
  }

  function resetPairing() {
    stopPairingPoll();
    pairingState = null;
  }

  function setActiveView(view) {
    const next = ["account", "devices", "register"].includes(view) ? view : "account";
    if (next !== activeView) showStatus("");
    if (next !== "register") stopPairingPoll();
    activeView = next;
    if (managerMode && next !== "register") {
      if (overlay && !overlay.hidden) close();
      root.AgentoCDesktopManager?.showAccount?.();
      return;
    }
    tabs.forEach((tab) => {
      const selected = tab.dataset.crossDeviceView === next;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    views.forEach((panel) => {
      const selected = panel.dataset.crossDevicePanel === next;
      panel.hidden = !selected;
      panel.classList.toggle("is-active", selected);
    });
    if (content) content.scrollTop = 0;
    if (next === "account") void renderAccount();
    if (next === "devices") void renderDevices();
    if (next === "register") {
      // Fail closed while status is loading: do not expose temporary mode for
      // an already bound owner, including when opening this view directly.
      pairingAccountBound = null;
      const request = ++pairingStatusRequest;
      pairingMode = "formal";
      renderPairing();
      void api("/api/auth/google/status").then((status) => {
        if (request !== pairingStatusRequest || activeView !== "register" || overlay?.hidden) return;
        pairingAccountBound = typeof status?.bound === "boolean" ? status.bound : null;
        renderPairing();
      }).catch(() => {});
    }
  }

  function appendCardTitle(card, title, note = "") {
    const header = make("div", "cross-device-card-header");
    const copy = make("div");
    copy.appendChild(make("h3", "cross-device-card-title", title));
    if (note) copy.appendChild(make("p", "cross-device-card-note", note));
    header.appendChild(copy);
    card.appendChild(header);
    return header;
  }

  function renderLoading(target, label) {
    clear(target);
    target.appendChild(make("div", "cross-device-empty", label));
  }

  async function renderAccount() {
    if (!accountContent || activeView !== "account") return;
    renderLoading(accountContent, fallback("crossDevice.loading", "Loading account status…"));
    try {
      const status = await api("/api/auth/google/status");
      if (activeView !== "account") return;
      clear(accountContent);
      const pairingNav = managerMode && document.querySelector('[data-desktop-manager-tab="pairing"]');
      if (pairingNav) pairingNav.hidden = false;
      pairingAccountBound = typeof status?.bound === "boolean" ? status.bound : null;
      if (managerMode && status?.bound) {
        if (managerClaimTimer) root.clearTimeout(managerClaimTimer);
        managerClaimTimer = null;
        managerClaim = null;
      }
      if (managerMode && status?.enabled && !status?.bound) {
        await renderManagerSignIn(status);
        return;
      }
      const stack = make("div", "cross-device-stack");
      const card = make("article", "cross-device-card");
      appendCardTitle(
        card,
        managerMode ? fallback("crossDevice.claim.accountTitle", "Account") : fallback("crossDevice.account.title", "Google owner sign-in"),
        managerMode ? fallback("crossDevice.claim.accountNote", "Manage the account connected to this computer.") : fallback("crossDevice.account.note", "One Google account can sign in as the owner from another device."),
      );
      const cardHeader = card.querySelector(".cross-device-card-header");
      cardHeader?.appendChild(action(fallback("crossDevice.refresh", "Refresh"), () => void renderAccount()));
      const body = make("div", "cross-device-card-body");
      const summary = make("div", "cross-device-summary");
      summary.appendChild(makeIcon("agent", "cross-device-summary-icon"));
      const copy = make("div", "cross-device-summary-copy");
      copy.appendChild(make("strong", "cross-device-summary-title", status?.bound
        ? (managerMode ? fallback("crossDevice.claim.connected", "Account connected") : fallback("crossDevice.account.bound", "Google account bound"))
        : fallback("crossDevice.account.unbound", "Google account not bound")));
      copy.appendChild(make("span", "cross-device-summary-detail", status?.enabled
        ? (status?.bound
          ? fallback("crossDevice.account.boundDetail", "This device can use the shared owner sign-in.")
            : fallback("crossDevice.account.unboundDetail", "Bind once to unlock cross-device owner sign-in."))
          : fallback("crossDevice.account.disabledDetail", "Google sign-in is not configured on this instance.")));
      summary.appendChild(copy);
      const pill = make("span", "cross-device-pill", status?.bound
          ? fallback("crossDevice.status.bound", "Bound")
        : status?.enabled
          ? fallback("crossDevice.status.notBound", "Not bound")
          : fallback("crossDevice.status.unavailable", "Unavailable"));
      pill.dataset.tone = status?.bound ? "success" : status?.enabled ? "warning" : "";
      summary.appendChild(pill);
      body.appendChild(summary);

      if (status?.enabled && !status?.bound) {
        const field = make("div", "cross-device-field");
        const label = make("label", "", fallback("crossDevice.account.aliasLabel", "Device name (optional)"));
        const input = make("input");
        input.type = "text";
        input.id = "crossDeviceAliasInput";
        input.name = "alias";
        input.maxLength = 64;
        input.autocomplete = "organization";
        input.placeholder = fallback("crossDevice.account.aliasPlaceholder", "e.g. Office laptop");
        label.htmlFor = input.id;
        field.append(label, input);
        body.appendChild(field);
        const actions = make("div", "cross-device-actions");
        actions.appendChild(action(
          fallback("crossDevice.account.bind", "Bind Google sign-in"),
          async (button) => {
            setBusy(button, true, fallback("crossDevice.account.opening", "Opening sign-in…"));
            try {
              const bindUrl = new URL(productPath("/api/auth/google/bind/redirect"), root.location.href);
              const alias = input.value.trim().slice(0, 64);
              if (alias) bindUrl.searchParams.set("alias", alias);
              root.open(bindUrl.toString(), "_blank", "noopener");
              showStatus(fallback("crossDevice.account.bindOpened", "Google binding opened in a new tab."), "success");
            } catch (error) {
              handleError(error, fallback("crossDevice.account.bindFailed", "Google binding could not be started."));
            } finally {
              setBusy(button, false);
            }
          },
          "primary",
        ));
        body.appendChild(actions);
      }
      if (status?.bound) {
        const actions = make("div", "cross-device-actions");
        actions.appendChild(action(
          fallback("crossDevice.account.unbind", "Unbind this device"),
          async (button) => {
            if (button.dataset.armed !== "true") {
              button.dataset.armed = "true";
              button.textContent = fallback("crossDevice.account.unbindConfirm", "Confirm unbind");
              root.setTimeout(() => {
                delete button.dataset.armed;
                button.textContent = fallback("crossDevice.account.unbind", "Unbind this device");
              }, 5000);
              return;
            }
            setBusy(button, true, fallback("crossDevice.account.unbinding", "Unbinding…"));
            try {
              await api("/api/auth/google/unbind", { method: "POST" });
              showStatus(fallback("crossDevice.account.unboundDone", "This device is no longer bound."), "success");
              void renderAccount();
            } catch (error) {
              handleError(error, fallback("crossDevice.account.unbindFailed", "Unbind failed."));
              delete button.dataset.armed;
            } finally {
              setBusy(button, false);
            }
          },
          "danger",
        ));
        body.appendChild(actions);
      }
      card.appendChild(body);
      stack.appendChild(card);

      if (status?.bound && status?.mode === "accounts") {
        const devicesCard = make("article", "cross-device-card");
        const devicesHeader = appendCardTitle(
          devicesCard,
          fallback("crossDevice.account.accountDevicesTitle", "Devices on this account"),
          fallback("crossDevice.account.accountDevicesNote", "Account records for computers and app installations; a bound record does not mean a device is online."),
        );
        devicesHeader.appendChild(action(fallback("crossDevice.refresh", "Refresh"), () => void renderAccount()));
        const devicesBody = make("div", "cross-device-card-body");
        try {
          const data = await api("/api/auth/google/devices");
          const devices = (Array.isArray(data?.devices) ? data.devices : []).filter((device) => !device?.unboundAt && !device?.revokedAt);
          if (activeView !== "account") return;
          if (!devices.length) {
            devicesBody.appendChild(make("div", "cross-device-empty", fallback("crossDevice.account.accountDevicesEmpty", "No other devices use this account.")));
          } else {
            const renderRow = (device) => {
              const inactive = Boolean(device?.unboundAt || device?.revokedAt);
              const row = make("div", "cross-device-device-row");
              row.dataset.inactive = String(inactive);
              row.appendChild(makeIcon("monitor", "cross-device-device-icon"));
              const meta = make("div", "cross-device-device-meta");
              meta.appendChild(make("strong", "", device?.alias || shortId(device?.deviceId)));
              const lines = [];
              if (device?.source) {
                lines.push(device.source === "local"
                  ? fallback("crossDevice.status.local", "Local")
                  : fallback("crossDevice.status.remote", "Remote"));
              }
              if (device?.boundAt) lines.push(fallback("crossDevice.account.boundAt", "Bound {time}", { time: formatDate(device.boundAt) }));
              if (device?.lastSeenAt) lines.push(fallback("crossDevice.account.lastSeen", "Last seen {time}", { time: formatDate(device.lastSeenAt) }));
              meta.appendChild(make("span", "", lines.join(" · ")));
              row.appendChild(meta);
              const pill = make("span", "cross-device-pill", inactive
                ? fallback("crossDevice.status.unbound", "Unbound")
                : fallback("crossDevice.status.bound", "Bound"));
              pill.dataset.tone = inactive ? "" : "success";
              row.appendChild(pill);
              return row;
            };
            const sorted = devices.slice().sort((a, b) => {
              if ((a?.source === "local") !== (b?.source === "local")) return a?.source === "local" ? -1 : 1;
              return (Date.parse(b?.lastSeenAt || b?.boundAt || "") || 0) - (Date.parse(a?.lastSeenAt || a?.boundAt || "") || 0);
            });
            const active = sorted.filter((device) => !device?.unboundAt && !device?.revokedAt);
            const phones = active.filter((device) => device?.deviceKind === "phone" || (!device?.deviceKind && device?.platform === "android"));
            const computers = active.filter((device) => device?.deviceKind === "computer");
            const other = active.filter((device) => !phones.includes(device) && !computers.includes(device));
            const appendGroup = (title, entries, collapsed = false) => {
              if (!entries.length) return;
              const section = make("section", "cross-device-account-group");
              const list = make("div", "cross-device-device-list");
              if (collapsed) {
                const details = make("details", "cross-device-account-more");
                details.appendChild(make("summary", "", `${title} · ${entries.length}`));
                entries.forEach((device) => list.appendChild(renderRow(device)));
                details.appendChild(list);
                section.appendChild(details);
              } else {
                section.appendChild(make("h4", "cross-device-account-group-title", `${title} · ${entries.length}`));
                entries.slice(0, 5).forEach((device) => list.appendChild(renderRow(device)));
                section.appendChild(list);
                if (entries.length > 5) {
                  const more = make("details", "cross-device-account-more");
                  more.appendChild(make("summary", "", fallback("crossDevice.account.showMore", "Show {count} more records", { count: entries.length - 5 })));
                  const remaining = make("div", "cross-device-device-list");
                  entries.slice(5).forEach((device) => remaining.appendChild(renderRow(device)));
                  more.appendChild(remaining);
                  section.appendChild(more);
                }
              }
              devicesBody.appendChild(section);
            };
            appendGroup(fallback("crossDevice.account.computers", "Computer records"), computers);
            appendGroup(fallback("crossDevice.account.phones", "Mobile app installation records"), phones);
            appendGroup(fallback("crossDevice.account.other", "Other records"), other);
          }
        } catch {
          devicesBody.appendChild(make("div", "cross-device-empty", fallback("crossDevice.account.accountDevicesFailed", "Device list is unavailable.")));
        }
        devicesCard.appendChild(devicesBody);
        stack.appendChild(devicesCard);
      }

      accountContent.appendChild(stack);
      hydrateIcons(accountContent);
    } catch {
      clear(accountContent);
      accountContent.appendChild(make("div", "cross-device-empty", fallback("crossDevice.account.failed", "Account status is unavailable.")));
    }
  }

  async function renderDevices() {
    if (!devicesContent || (!managerMode && activeView !== "devices")) return;
    // The desktop manager controls this computer, not a remote workbench.
    // Account-bound devices remain visible in the account section.
    if (managerMode) { clear(devicesContent); return; }
    renderLoading(devicesContent, fallback("crossDevice.loading", "Loading devices…"));
    try {
      const accountStatus = await api("/api/auth/google/status").catch(() => null);
      const useAccountDirectory = accountStatus?.bound && accountStatus?.mode === "accounts";
      let listedDevices = [];
      let trustedDevices = [];
      if (useAccountDirectory) {
        const [accountData, localData] = await Promise.all([
          api("/api/auth/google/devices").catch(() => null),
          // The Accounts directory is authoritative for discovery, while the
          // local ledger is still the only Web entry-switch trust anchor.
          api("/api/device-pairing/devices").catch(() => null),
        ]);
        const accountDevices = Array.isArray(accountData?.devices) ? accountData.devices : [];
        trustedDevices = Array.isArray(localData?.devices) ? localData.devices : [];
        listedDevices = accountDevices.filter((device) => isAccountComputer(device) && !device?.unboundAt && !device?.revokedAt).map((device) => ({
          ...device,
          trustedDevice: findLocalTrustedDevice(device, trustedDevices),
        }));
      } else {
        const localLedger = await api("/api/device-pairing/devices").catch(() => null);
        trustedDevices = Array.isArray(localLedger?.devices) ? localLedger.devices : [];
        listedDevices = trustedDevices;
      }
      // Keep the local ledger for QR completion polling in both modes. It is
      // also consulted below only to determine whether an account directory
      // computer has a usable local entry-switch trust relationship.
      devicesCache = trustedDevices;
      if (managerMode ? activeView === "register" : activeView !== "devices") return;
      clear(devicesContent);
      const stack = make("div", "cross-device-stack");
      await renderTargetRuntimeCard(stack);
      const card = make("article", "cross-device-card");
      const header = appendCardTitle(
        card,
        useAccountDirectory
          ? fallback("crossDevice.account.accountDevicesTitle", "Devices on this account")
          : fallback("crossDevice.devices.title", "Trusted devices"),
        useAccountDirectory
          ? fallback("crossDevice.account.computersNote", "Computers associated with this account.")
          : fallback("crossDevice.devices.note", "Pair a device once. Its signing key is verified and registered automatically."),
      );
      const actions = make("div", "cross-device-actions");
      actions.appendChild(action(fallback("crossDevice.devices.pair", "Pair a device"), () => {
        resetPairing();
        if (managerMode) open({ view: "register" });
        else setActiveView("register");
      }, "primary"));
      actions.appendChild(action(fallback("crossDevice.refresh", "Refresh"), () => void renderDevices()));
      header.appendChild(actions);
      const body = make("div", "cross-device-card-body");
      if (!listedDevices.length) {
        body.appendChild(make("div", "cross-device-empty", useAccountDirectory
          ? fallback("crossDevice.account.accountDevicesEmpty", "No devices use this account yet.")
          : fallback("crossDevice.devices.empty", "No paired devices yet. Pair a device to enable secure transfers.")));
      } else {
        const list = make("div", "cross-device-device-list");
        listedDevices.forEach((device) => {
          const deviceId = device?.deviceId || device?.id || "";
          const trustedDevice = useAccountDirectory ? device?.trustedDevice : device;
          // 切换原语只认本机账本 id；账号目录仅用于发现和展示。
          const localDeviceId = String(trustedDevice?.id || "").trim();
          const entryUrl = String(trustedDevice?.entryUrl || "").trim();
          // Accounts endpoint is discovery metadata only. It may be shown as
          // a reference, but it is never submitted as an entry-switch target
          // until the local trusted ledger records it.
          const directoryEndpoint = String(device?.entryUrl || device?.endpoint || "").trim();
          const inactive = Boolean(device?.unboundAt || device?.revokedAt);
          const currentInstance = useAccountDirectory && device?.source === "local";
          const row = make("div", "cross-device-device-row");
          row.dataset.inactive = String(inactive);
          if (localDeviceId) row.dataset.deviceId = localDeviceId;
          row.appendChild(makeIcon("monitor", "cross-device-device-icon"));
          const meta = make("div", "cross-device-device-meta");
          meta.appendChild(make("strong", "", device?.alias || device?.deviceName || deviceId || fallback("crossDevice.devices.unnamed", "Unnamed device")));
          const deviceKind = device?.deviceKind || device?.platform || fallback("crossDevice.devices.remote", "Paired device");
          const details = [];
          details.push(deviceKind);
          if (useAccountDirectory && device?.boundAt) {
            details.push(fallback("crossDevice.account.boundAt", "Bound {time}", { time: formatDate(device.boundAt) }));
          }
          details.push(device?.lastSeenAt
            ? `${fallback("crossDevice.devices.lastSeen", "Last active")} ${formatDate(device.lastSeenAt)}`
            : fallback("crossDevice.devices.neverSeen", "Not seen yet"));
          meta.appendChild(make("span", "", details.join(" · ")));
          meta.appendChild(entryUrl
            ? make("span", "cross-device-device-entry", entryUrl)
            : directoryEndpoint
              ? make("span", "cross-device-device-entry is-reference", fallback(
                "crossDevice.devices.entryReference",
                "Account endpoint (reference): {url}",
                { url: directoryEndpoint },
              ))
              : make("span", "cross-device-device-entry is-missing", fallback("crossDevice.devices.entryMissing", "No entry URL registered")));
          row.appendChild(meta);
          const side = make("div", "cross-device-device-side");
          const pill = make("span", "cross-device-pill", inactive
            ? (useAccountDirectory ? fallback("crossDevice.status.unbound", "Unbound") : fallback("crossDevice.status.revoked", "Revoked"))
            : fallback("crossDevice.status.active", "Active"));
          pill.dataset.tone = inactive ? "" : "success";
          side.appendChild(pill);
          if (trustedDevice && localDeviceId && !inactive) {
            const entryEditor = createEntryUrlEditor({
              deviceId: localDeviceId,
              entryUrl,
              directoryEndpoint,
              onSaved: () => renderDevices(),
            });
            meta.appendChild(entryEditor.editor);
            side.appendChild(entryEditor.toggleButton);
          }
          if (!currentInstance && localDeviceId && entryUrl && !inactive) {
            const switchButton = action(
              fallback("crossDevice.devices.switch", "Switch"),
              () => void switchToDevice(localDeviceId, entryUrl, switchButton),
              "primary",
            );
            switchButton.classList.add("cross-device-device-switch");
            side.appendChild(switchButton);
            // A central endpoint is display metadata. Probe only the local
            // ledger URL because the health route deliberately refuses an
            // arbitrary browser-supplied target URL.
            if (trustedDevice?.entryUrl) {
              void probeDeviceHealth(localDeviceId).then((health) => {
                applyDeviceHealth(row, switchButton, localDeviceId, health);
              });
            }
          } else if (useAccountDirectory && !currentInstance && !localDeviceId && !inactive) {
            side.appendChild(make(
              "span",
              "cross-device-device-capability",
              fallback("crossDevice.devices.switchUnavailable", "Switch unavailable until this instance trusts the target."),
            ));
          }
          row.appendChild(side);
          list.appendChild(row);
        });
        body.appendChild(list);
      }
      card.appendChild(body);
      stack.appendChild(card);
      devicesContent.appendChild(stack);
      hydrateIcons(devicesContent);
    } catch {
      clear(devicesContent);
      devicesContent.appendChild(make("div", "cross-device-empty", fallback("crossDevice.devices.failed", "Device list is unavailable.")));
    }
  }

  async function renderManagerSignIn(status) {
    const card = make("article", "cross-device-card desktop-manager-sign-in");
    const body = make("div", "cross-device-card-body desktop-manager-sign-in-body");
    card.appendChild(body);
    accountContent.appendChild(card);
    if (status?.capabilities?.accountJoin !== false) {
      body.appendChild(make("h3", "cross-device-card-title", fallback("crossDevice.claim.title", "Connect with your phone")));
      body.appendChild(make("p", "cross-device-helper", fallback("crossDevice.claim.note", "In the Ragent app, scan this code to connect this computer to your account.")));
      const qr = make("div", "cross-device-pair-qr desktop-manager-claim-qr");
      qr.setAttribute("role", "img");
      qr.setAttribute("aria-label", fallback("crossDevice.pair.qrLabel", "Pairing QR code"));
      body.appendChild(qr);
      const detail = make("p", "cross-device-helper", fallback("crossDevice.pair.creating", "Creating code…"));
      body.appendChild(detail);
      void (async () => { try {
        if (!managerClaim || Date.parse(managerClaim.expiresAt) <= Date.now()) {
          const data = await api("/api/device-pairing/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (!data?.invitation?.pairingUri || !data.invitation.expiresAt) throw new Error("Pairing code unavailable");
          managerClaim = data.invitation;
        }
        if (!card.isConnected) return;
        drawPairingQr(qr, managerClaim.pairingUri, 512);
        detail.textContent = `${fallback("crossDevice.pair.expires", "Expires")} ${formatDate(managerClaim.expiresAt)}`;
      } catch (error) {
        if (!card.isConnected) return;
        detail.textContent = fallback("crossDevice.claim.failed", "Could not create a pairing code.");
        body.appendChild(action(fallback("crossDevice.refresh", "Retry"), () => void renderAccount()));
      } })();
    }
    const actions = make("div", "cross-device-actions desktop-manager-sign-in-actions");
    const openSignIn = (flow) => {
      const bindUrl = new URL(productPath("/api/auth/google/bind/redirect"), root.location.href);
      if (flow === "demo") bindUrl.searchParams.set("flow", "demo");
      root.open(bindUrl.toString(), "_blank", "noopener");
    };
    const googleAction = action(fallback("crossDevice.claim.google", "Sign in with Google"), () => openSignIn("google"));
    googleAction.classList.add("desktop-manager-provider-action");
    const googleMark = make("img", "desktop-manager-provider-mark");
    googleMark.src = productPath("/google-login-mark.svg");
    googleMark.alt = "";
    googleMark.setAttribute("aria-hidden", "true");
    googleAction.prepend(googleMark);
    actions.appendChild(googleAction);
    const demoAction = action(ragentLoginCopy("Sign in with Ragent", "Ragent登录"), () => openSignIn("demo"));
    demoAction.classList.add("desktop-manager-provider-action");
    const ragentMark = make("img", "desktop-manager-provider-mark");
    ragentMark.src = productPath("/ragent-login-mark.svg");
    ragentMark.alt = "";
    ragentMark.setAttribute("aria-hidden", "true");
    demoAction.prepend(ragentMark);
    demoAction.disabled = true;
    actions.appendChild(demoAction);
    body.appendChild(actions);
    const demoStatus = make("p", "cross-device-helper", ragentLoginCopy("Checking Ragent sign-in availability…", "正在检查Ragent登录状态…"));
    body.appendChild(demoStatus);
    void (async () => {
      try {
        const result = await api("/api/auth/demo/status");
        if (!card.isConnected) return;
        if (result?.status === "configured") {
          demoAction.disabled = false;
          demoStatus.textContent = "";
        } else {
          demoStatus.textContent = result?.status === "unconfigured"
            ? ragentLoginCopy("Ragent sign-in has not been configured.", "Ragent登录尚未配置。")
            : ragentLoginCopy("Ragent sign-in is currently unavailable.", "Ragent登录暂时不可用。");
        }
      } catch {
        if (card.isConnected) demoStatus.textContent = ragentLoginCopy("Ragent sign-in is currently unavailable.", "Ragent登录暂时不可用。");
      }
    })();
    if (managerClaimTimer) root.clearTimeout(managerClaimTimer);
    const poll = async () => {
      if (!card.isConnected || document.body?.dataset.desktopManagerTab !== "account") return;
      try {
        const current = await api("/api/auth/google/status");
        if (current?.bound || (managerClaim && Date.parse(managerClaim.expiresAt) <= Date.now())) { void renderAccount(); return; }
      } catch { /* Keep the existing QR visible during a transient failure. */ }
      managerClaimTimer = root.setTimeout(poll, 3000);
    };
    managerClaimTimer = root.setTimeout(poll, 3000);
  }

  function targetStatusText(target) {
    const labels = {
      online: fallback("crossDevice.target.online", "Online"),
      paired: fallback("crossDevice.target.paired", "Paired"),
      connecting: fallback("crossDevice.target.connecting", "Connecting"),
      degraded: fallback("crossDevice.target.degraded", "Connection limited"),
      offline: fallback("crossDevice.target.offline", "Offline"),
      revoked: fallback("crossDevice.target.revoked", "Revoked"),
    };
    return labels[target?.status] || fallback("crossDevice.target.unavailable", "Unavailable");
  }

  function targetSummaryText(summary) {
    if (!summary) return fallback("crossDevice.target.noSummary", "No runtime summary yet");
    const sessions = Number(summary.sessions?.total) || 0;
    const active = Number(summary.runs?.active) || 0;
    const approvals = Number(summary.approvals?.pending) || 0;
    return fallback("crossDevice.target.summary", "{sessions} sessions · {active} active runs · {approvals} approvals", { sessions, active, approvals });
  }

  async function renderTargetRuntimeCard(parent, boundIds = null) {
    const runtime = root.AgentoCTargetRuntime;
    if (!runtime || !parent) return;
    await runtime.refreshTargets?.().catch(() => null);
    const snapshot = runtime.getSnapshot?.() || { targets: [] };
    const card = make("article", "cross-device-card cross-device-runtime-card");
    const header = appendCardTitle(card, fallback("crossDevice.target.title", "Work computers"), fallback("crossDevice.target.note", "Choose the computer for your workbench."));
    const actions = make("div", "cross-device-actions");
    actions.appendChild(action(fallback("crossDevice.refresh", "Refresh"), () => void (async () => {
      await runtime.refreshTargets?.();
      await runtime.refreshSummaries?.();
      await renderDevices();
    })()));
    header.appendChild(actions);
    const body = make("div", "cross-device-card-body");
    const targets = (Array.isArray(snapshot.targets) ? snapshot.targets : []).filter((target) =>
      target.status !== "revoked" && (!boundIds || target.targetId === snapshot.activeTargetId || boundIds.has(target.instanceId) || boundIds.has(target.targetId)));
    if (!targets.length) {
      body.appendChild(make("div", "cross-device-empty", fallback("crossDevice.target.empty", "No work computers are available.")));
    } else {
      const list = make("div", "cross-device-device-list");
      for (const target of targets) {
        const row = make("div", "cross-device-device-row cross-device-runtime-row");
        row.dataset.active = String(target.targetId === snapshot.activeTargetId);
        row.dataset.status = target.status || "offline";
        row.appendChild(makeIcon(target.targetId === snapshot.activeTargetId ? "check" : "monitor", "cross-device-device-icon"));
        const meta = make("div", "cross-device-device-meta");
        meta.appendChild(make("strong", "", `${target.label}${target.targetId === snapshot.activeTargetId ? ` · ${fallback("crossDevice.target.current", "Current")}` : ""}`));
        meta.appendChild(make("span", "", `${target.platform || target.deviceKind} · ${targetStatusText(target)}`));
        meta.appendChild(make("span", "cross-device-device-entry", targetSummaryText(runtime.getSummary?.(target.targetId))));
        row.appendChild(meta);
        const side = make("div", "cross-device-device-side");
        const pill = make("span", "cross-device-pill", targetStatusText(target));
        pill.dataset.tone = target.status === "online" || target.status === "paired" ? "success" : "warning";
        side.appendChild(pill);
        if (target.targetId !== snapshot.activeTargetId && target.status !== "revoked") {
          const switchButton = action(fallback("crossDevice.target.use", "Use"), async (button) => {
            setBusy(button, true, fallback("crossDevice.target.switching", "Switching…"));
            try {
              await runtime.selectTarget(target.targetId);
              showStatus(fallback("crossDevice.target.using", "Using {name}", { name: target.label }), "success");
              await renderDevices();
            } catch (error) {
              handleError(error, fallback("crossDevice.target.switchFailed", "Could not switch computers."));
              setBusy(button, false);
            }
          }, "primary");
          side.appendChild(switchButton);
        }
        row.appendChild(side);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    card.appendChild(body);
    parent.appendChild(card);
    hydrateIcons(card);
  }

  function createEntryUrlEditor({ deviceId, entryUrl, directoryEndpoint, onSaved }) {
    const editor = make("div", "cross-device-entry-editor");
    editor.hidden = true;
    const label = make("label", "", fallback("crossDevice.devices.entryUrlLabel", "Device entry URL"));
    const input = make("input");
    input.type = "url";
    input.inputMode = "url";
    input.autocomplete = "url";
    input.spellcheck = false;
    input.maxLength = 2048;
    input.value = entryUrl;
    input.placeholder = fallback("crossDevice.devices.entryUrlPlaceholder", "https://computer.example/agentoc");
    const inputId = `crossDeviceEntryUrl-${String(deviceId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    input.id = inputId;
    label.htmlFor = inputId;
    editor.appendChild(label);
    editor.appendChild(input);
    editor.appendChild(make("p", "cross-device-helper", directoryEndpoint && !entryUrl
      ? fallback("crossDevice.devices.entryUrlReferenceHint", "The account endpoint is only a reference. Save it here after confirming this browser can reach the target.")
      : fallback("crossDevice.devices.entryUrlHint", "Use the target instance's HTTP(S) entry address. Query strings and fragments are removed.")));
    const actions = make("div", "cross-device-entry-editor-actions");
    const saveButton = action(fallback("crossDevice.devices.entryUrlSave", "Save"), () => void persistEntryUrl(input.value, saveButton), "primary");
    const clearButton = action(fallback("crossDevice.devices.entryUrlClear", "Clear"), () => void persistEntryUrl("", clearButton), "danger");
    clearButton.disabled = !entryUrl;
    const cancelButton = action(fallback("crossDevice.devices.entryUrlCancel", "Cancel"), () => {
      editor.hidden = true;
      toggleButton.hidden = false;
      toggleButton.setAttribute("aria-expanded", "false");
      toggleButton.focus({ preventScroll: true });
    });
    actions.append(saveButton, clearButton, cancelButton);
    editor.appendChild(actions);

    async function persistEntryUrl(value, button) {
      const normalized = normalizeEntryUrl(value);
      if (normalized === null) {
        showStatus(fallback("crossDevice.devices.entryUrlInvalid", "Enter a valid http(s) entry URL."), "error");
        input.focus({ preventScroll: true });
        return;
      }
      setBusy(button, true, normalized ? fallback("crossDevice.devices.entryUrlSaving", "Saving…") : fallback("crossDevice.devices.entryUrlClearing", "Clearing…"));
      try {
        await api(`/api/device-pairing/devices/${encodeURIComponent(deviceId)}/entry-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryUrl: normalized }),
        });
        deviceHealthCache.delete(deviceId);
        showStatus(normalized
          ? fallback("crossDevice.devices.entryUrlSaved", "Device entry URL saved.")
          : fallback("crossDevice.devices.entryUrlCleared", "Device entry URL cleared."), "success");
        await onSaved?.();
      } catch (error) {
        showStatus(entryUrlErrorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    }

    const toggleButton = action(entryUrl
      ? fallback("crossDevice.devices.entryUrlEdit", "Edit entry URL")
      : fallback("crossDevice.devices.entryUrlSet", "Set entry URL"), () => {
      showStatus("");
      editor.hidden = false;
      toggleButton.hidden = true;
      toggleButton.setAttribute("aria-expanded", "true");
      input.focus({ preventScroll: true });
    });
    toggleButton.setAttribute("aria-expanded", "false");
    toggleButton.setAttribute("aria-controls", inputId);
    toggleButton.classList.add("cross-device-device-entry-action");
    return { editor, toggleButton };
  }

  function probeDeviceHealth(deviceId) {
    const cached = deviceHealthCache.get(deviceId);
    if (cached && Date.now() - cached.at < DEVICE_HEALTH_TTL_MS) return cached.promise;
    const promise = api(`/api/entry-switch/health?deviceId=${encodeURIComponent(deviceId)}`)
      .then((data) => ({
        reachable: data?.reachable === true,
        known: true,
        reason: String(data?.reason || ""),
        statusCode: Number.isFinite(data?.statusCode) ? data.statusCode : null,
      }))
      .catch(() => ({ reachable: true, known: false, reason: "probe_failed", statusCode: null }));
    deviceHealthCache.set(deviceId, { at: Date.now(), promise });
    return promise;
  }

  function applyDeviceHealth(row, switchButton, deviceId, health) {
    // 行可能已被重渲染；只把结果写回仍显示同一设备的行。
    if (!row?.dataset?.deviceId || row.dataset.deviceId !== deviceId) return;
    if (!health?.known) return; // 探测端点自身异常：不改状态，不阻塞切换
    if (health.reachable) return;
    row.dataset.unreachable = "true";
    if (switchButton) {
      switchButton.disabled = true;
      switchButton.title = fallback("crossDevice.devices.unreachable", "Entry unreachable");
    }
  }

  async function switchToDevice(localDeviceId, entryUrl, button) {
    try {
      setBusy(button, true);
      // 账号前置（与 App 同一信任类）：未绑定账号先引导绑定，不放行切换。
      const accountStatus = await api("/api/auth/google/status").catch(() => null);
      if (!accountStatus?.bound) {
        showStatus(fallback("crossDevice.switch.bindRequired", "Bind a Google account before switching devices."), "error");
        setActiveView("account");
        return;
      }
      const data = await api("/api/entry-switch/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDeviceId: localDeviceId, ...(entryUrl ? { targetUrl: entryUrl } : {}) }),
      });
      const jumpUrl = String(data?.jumpUrl || "");
      if (!jumpUrl) throw new Error(fallback("crossDevice.switch.failed", "Could not start the switch."));
      showStatus(fallback("crossDevice.switch.redirecting", "Switching… opening the target device."), "info");
      // 丢弃本实例通道凭据后再跳（P1-④）：WS 停连、P2P 备份通道关闭。
      if (typeof root.AgentocEntrySwitchHandoff?.prepare === "function") {
        try {
          root.AgentocEntrySwitchHandoff.prepare();
        } catch {
          // 交接失败不阻塞跳转；页面跳转本身会释放通道。
        }
      }
      root.setTimeout(() => {
        root.location.assign(jumpUrl);
      }, 150);
    } catch (error) {
      showStatus(switchErrorMessage(error), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function copyPairingLink(value) {
    try {
      if (typeof root.agentocDesktop?.writeText === "function") {
        if (await root.agentocDesktop.writeText(value)) {
          showStatus(fallback("crossDevice.pair.copied", "Pairing link copied. Open it in the Ragent app on the other device."), "success");
          return;
        }
      }
      if (!root.navigator?.clipboard?.writeText) throw new Error();
      await root.navigator.clipboard.writeText(value);
      showStatus(fallback("crossDevice.pair.copied", "Pairing link copied. Open it in the Ragent app on the other device."), "success");
    } catch {
      showStatus(fallback("crossDevice.pair.copyFailed", "Could not copy the link. Scan the code with the Ragent app instead."), "error");
    }
  }

  function drawPairingQr(target, pairingUri, size = 320) {
    if (!target || !pairingUri) return;
    clear(target);
    try {
      if (!root.QrCreator?.render) throw new Error();
      root.QrCreator.render({
        text: pairingUri,
        // Account-link payloads include an endpoint and one-time token. Keep
        // each QR module large enough for ordinary phone cameras.
        size,
        quiet: 4,
        ecLevel: "M",
        // Rounded modules look decorative but reduce camera-decoder tolerance
        // for a dense account-link payload. Use the standard square QR grid.
        radius: 0,
        background: "#ffffff",
        fill: "#000000",
      }, target);
    } catch (error) {
      root.console?.warn?.("Pairing QR rendering failed", error?.message || "unknown error");
      target.appendChild(make("div", "cross-device-pair-qr-fallback", fallback("crossDevice.pair.qrUnavailable", "QR preview is unavailable. Use the pairing code in the Ragent app.")));
    }
  }

  function schedulePairingPoll() {
    stopPairingPoll();
    if (!pairingState?.invitation || pairingState.completedDevice || pairingMode !== "formal" || activeView !== "register") return;
    if (["REVOKED", "EXPIRED"].includes(pairingState.accountStatus)) return;
    const invitationId = pairingState.invitation.id;
    pairingPollTimer = root.setTimeout(async () => {
      try {
        if (pairingState?.invitation?.accountHandoff) {
          const result = await api(`/api/device-pairing/account-invitations/${encodeURIComponent(invitationId)}`);
          if (pairingState?.invitation?.id !== invitationId) return;
          const current = result?.invitation;
          if (current && (current.status !== pairingState.accountStatus || current.phoneFingerprint !== pairingState.phoneFingerprint)) {
            pairingState.accountStatus = current.status;
            pairingState.phoneFingerprint = current.phoneFingerprint;
            renderPairing();
          }
        }
        const data = await api("/api/device-pairing/devices");
        const devices = Array.isArray(data?.devices) ? data.devices : [];
        const newlyPaired = devices.find((device) => !pairingState?.knownDeviceIds?.has(device?.id));
        if (newlyPaired) {
          devicesCache = devices;
          pairingState.completedDevice = newlyPaired;
          stopPairingPoll();
          renderPairing();
          showStatus(fallback("crossDevice.pair.completed", "Device paired. Its secure identity is ready for transfers."), "success");
          return;
        }
      } catch (error) {
        if (error?.status === 410 && pairingState?.invitation?.id === invitationId) {
          pairingState.accountStatus = "EXPIRED"; renderPairing(); return;
        }
        // 轮询只提升完成体验；网络短暂失败不打断扫码或覆盖主操作。
      }
      schedulePairingPoll();
    }, 2500);
  }

  function scheduleTemporaryPairingPoll() {
    if (temporaryPairingPollTimer) root.clearTimeout(temporaryPairingPollTimer);
    temporaryPairingPollTimer = null;
    if (!temporaryPairingState?.ticket?.envelope?.invitation?.invitationId
      || pairingMode !== "temporary" || activeView !== "register") return;
    const invitationId = temporaryPairingState.ticket.envelope.invitation.invitationId;
    const terminal = ["REVOKED", "EXPIRED"].includes(temporaryPairingState.status);
    if (terminal) return;
    temporaryPairingPollTimer = root.setTimeout(async () => {
      try {
        const data = await api("/api/device-pairing/temporary-control/invitations");
        const current = (data?.invitations || []).find((item) => item?.invitationId === invitationId);
        if (current) {
          const previous = temporaryPairingState;
          temporaryPairingState = { ...previous, ...current };
          if (current.status !== previous.status || current.accessExpiresAt !== previous.accessExpiresAt
            || current.claimedDevice?.deviceKeyFingerprint !== previous.claimedDevice?.deviceKeyFingerprint) renderPairing();
        }
      } catch {
        // Temporary status is helpful, but a transient refresh failure must not hide the QR.
      }
      scheduleTemporaryPairingPoll();
    }, 2500);
  }

  function renderPairing() {
    if (!registerContent) return;
    clear(registerContent);
    const stack = make("div", "cross-device-stack");
    const modes = make("div", "cross-device-pair-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", fallback("crossDevice.pair.modes", "Pairing type"));
    const addMode = (mode, label) => {
      const button = make("button", "cross-device-pair-mode", label);
      const selected = pairingMode === mode;
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected));
      if (selected) button.classList.add("is-active");
      button.addEventListener("click", () => {
        if (pairingMode === mode) return;
        stopPairingPoll();
        pairingMode = mode;
        showStatus("");
        renderPairing();
      });
      modes.appendChild(button);
    };
    addMode("formal", fallback("crossDevice.pair.mode.google", "Trusted · Google sign-in"));
    if (pairingAccountBound === false) addMode("temporary", fallback("crossDevice.pair.mode.temporary", "Temporary · no sign-in"));
    stack.appendChild(modes);
    if (pairingMode === "temporary") {
      renderTemporaryPairing(stack);
      registerContent.appendChild(stack);
      scheduleTemporaryPairingPoll();
      return;
    }
    renderFormalPairing(stack);
    registerContent.appendChild(stack);
    schedulePairingPoll();
  }

  function renderFormalPairing(stack) {
    const card = make("article", "cross-device-card");
    appendCardTitle(
      card,
      fallback("crossDevice.pair.title", "Trusted pairing · Google sign-in"),
      fallback("crossDevice.pair.note", "For long-term access, sign in on either device. Scan this code on your phone to sign in on the other device automatically."),
    );
    const body = make("div", "cross-device-card-body");
    const actions = make("div", "cross-device-actions");
    if (!pairingState?.invitation) {
      const steps = make("ol", "cross-device-pair-steps");
      steps.appendChild(make("li", "", fallback("crossDevice.pair.stepOne", "Open Ragent on the other device.")));
      steps.appendChild(make("li", "", fallback("crossDevice.pair.stepTwo", "Scan the code, then confirm the device name there.")));
      steps.appendChild(make("li", "", fallback("crossDevice.pair.stepThree", "This page will confirm when the device is ready.")));
      body.appendChild(steps);
      actions.appendChild(action(fallback("crossDevice.pair.back", "Back to devices"), () => setActiveView("devices")));
      actions.appendChild(action(fallback("crossDevice.pair.create", "Create pairing code"), async (button) => {
        setBusy(button, true, fallback("crossDevice.pair.creating", "Creating code…"));
        try {
          const data = await api("/api/device-pairing/invitations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const invitation = data?.invitation;
          if (!invitation?.pairingUri || !invitation?.shortCode || !invitation?.expiresAt) {
            throw new Error(fallback("crossDevice.pair.failed", "Pairing code could not be created."));
          }
          pairingState = {
            invitation,
            knownDeviceIds: new Set(devicesCache.map((device) => device?.id).filter(Boolean)),
          };
          renderPairing();
        } catch (error) {
          handleError(error, fallback("crossDevice.pair.failed", "Pairing code could not be created."));
        } finally {
          setBusy(button, false);
        }
      }, "primary"));
    } else {
      const invitation = pairingState.invitation;
      const pairing = make("div", "cross-device-pairing");
      const qr = make("div", "cross-device-pair-qr");
      qr.setAttribute("role", "img");
      qr.setAttribute("aria-label", fallback("crossDevice.pair.qrLabel", "Pairing QR code"));
      pairing.appendChild(qr);
      drawPairingQr(qr, invitation.pairingUri, 512);
      const copy = make("div", "cross-device-pair-copy");
      copy.appendChild(make("strong", "", pairingState.completedDevice
        ? fallback("crossDevice.pair.doneTitle", "Pairing complete")
        : fallback("crossDevice.pair.waitingTitle", "Waiting for the other device")));
      copy.appendChild(make("span", "", pairingState.completedDevice
        ? `${pairingState.completedDevice.deviceName || pairingState.completedDevice.id} · ${fallback("crossDevice.status.active", "Active")}`
        : fallback("crossDevice.pair.waitingNote", "Scan the code in Ragent. It expires automatically and cannot be reused.")));
      pairing.appendChild(copy);
      const code = make("div", "cross-device-pair-code");
      code.appendChild(make("span", "", fallback("crossDevice.pair.codeLabel", "Pairing code")));
      code.appendChild(make("strong", "", invitation.shortCode));
      pairing.appendChild(code);
      const expiry = make("p", "cross-device-helper", `${fallback("crossDevice.pair.expires", "Expires")} ${formatDate(invitation.expiresAt)}`);
      pairing.appendChild(expiry);
      body.appendChild(pairing);
      if (invitation.accountHandoff) {
        if (pairingState.phoneFingerprint) body.appendChild(make("p", "cross-device-helper",
          `${fallback("crossDevice.control.phoneFingerprint", "Phone key fingerprint")}: ${pairingState.phoneFingerprint}`));
        body.appendChild(make("p", "cross-device-helper",
          fallback("crossDevice.accountHandoff.automatic", "Scanning this code automatically authorizes your phone for this account. Only share it with your own phone.")));
        if (pairingState.accountStatus === "CLAIMED") body.appendChild(make("p", "cross-device-helper",
          fallback("crossDevice.accountHandoff.connecting", "Phone verified. Completing account sign-in automatically…")));
        if (pairingState.accountStatus === "APPROVED") body.appendChild(make("p", "cross-device-helper",
          fallback("crossDevice.accountHandoff.approved", "Account access confirmed. Waiting for the phone to finish connecting.")));
        if (["REVOKED", "EXPIRED"].includes(pairingState.accountStatus)) body.appendChild(make("p", "cross-device-helper",
          fallback("crossDevice.accountHandoff.inactive", "This pairing code is no longer active. Create another code.")));
        if (!["REVOKED", "EXPIRED", "APPROVED"].includes(pairingState.accountStatus)) actions.appendChild(action(
          fallback("crossDevice.accountHandoff.revoke", "Cancel account authorization"), async (button) => {
            setBusy(button, true);
            try {
              await api(`/api/device-pairing/account-invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST" });
              if (pairingState?.invitation?.id !== invitation.id) return;
              pairingState.accountStatus = "REVOKED"; renderPairing();
            } catch (error) { handleError(error, fallback("crossDevice.accountHandoff.failed", "Could not authorize the phone.")); }
            finally { setBusy(button, false); }
          }));
      }
      actions.appendChild(action(fallback("crossDevice.pair.copy", "Copy pairing link"), () => void copyPairingLink(invitation.pairingUri)));
      actions.appendChild(action(pairingState.completedDevice
        ? fallback("crossDevice.pair.viewDevices", "View paired devices")
        : fallback("crossDevice.pair.new", "Create another code"), async () => {
        if (pairingState?.completedDevice) {
          resetPairing();
          setActiveView("devices");
        } else {
          if (invitation.accountHandoff && !["REVOKED", "EXPIRED", "APPROVED"].includes(pairingState.accountStatus)) {
            try { await api(`/api/device-pairing/account-invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST" }); }
            catch (error) { if (error?.status !== 410) { handleError(error); return; } }
          }
          resetPairing();
          renderPairing();
        }
      }, pairingState.completedDevice ? "primary" : "neutral"));
    }
    body.appendChild(actions);
    card.appendChild(body);
    stack.appendChild(card);
  }

  function renderTemporaryPairing(stack) {
    const card = make("article", "cross-device-card");
    appendCardTitle(card, fallback("crossDevice.control.title", "Temporary control · no Google sign-in"),
      fallback("crossDevice.control.note", "After you confirm the phone, it can control this computer for 10 minutes, including projects, sessions, harnesses and providers."));
    const body = make("div", "cross-device-card-body");
    const actions = make("div", "cross-device-actions");
    const state = temporaryPairingState;
    if (!state) {
      body.appendChild(make("p", "cross-device-helper", fallback("crossDevice.control.steps",
        "Create a code, scan it in Ragent on the phone, then confirm the phone on this computer. The 10 minutes start when you confirm.")));
      actions.appendChild(action(fallback("crossDevice.temporary.create", "Create temporary code"), async (button) => {
        setBusy(button, true, fallback("crossDevice.pair.creating", "Creating code…"));
        try {
          const data = await api("/api/device-pairing/temporary-control/invitations", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
          });
          const ticket = data?.invitation;
          if (!ticket?.envelope?.invitation?.invitationId || !ticket?.token) throw new Error("Invalid temporary code response");
          temporaryPairingState = { ticket, status: "PENDING" };
          showStatus("");
          renderPairing();
        } catch (error) {
          handleError(error, fallback("crossDevice.temporary.failed", "Temporary code could not be created."));
        } finally { setBusy(button, false); }
      }, "primary"));
    } else {
      const invitation = state.ticket.envelope.invitation;
      const expiresAt = Number(state.accessExpiresAt);
      const claimExpiresAt = Number(invitation.claimExpiresAt);
      const expired = state.status === "ACTIVE" ? Number.isFinite(expiresAt) && Date.now() >= expiresAt
        : Date.now() >= claimExpiresAt;
      const revoked = state.status === "REVOKED" || state.status === "EXPIRED";
      const qrText = JSON.stringify({ kind: "agentoc-temporary-control-v1", version: 1, envelope: state.ticket.envelope, token: state.ticket.token });
      const pairing = make("div", "cross-device-pairing");
      const qr = make("div", "cross-device-pair-qr cross-device-pair-qr-temporary");
      qr.setAttribute("role", "img");
      qr.setAttribute("aria-label", fallback("crossDevice.temporary.qrLabel", "Temporary pairing QR code"));
      pairing.appendChild(qr);
      if (!expired && !revoked && Date.now() < claimExpiresAt) drawPairingQr(qr, qrText, 512);
      else qr.appendChild(make("div", "cross-device-pair-qr-fallback", fallback("crossDevice.temporary.scanExpired", "The scan window has ended. Create a new code.")));
      const status = state.status === "CLAIMED" ? fallback("crossDevice.control.confirmNeeded", "Phone scanned · confirm on this computer")
        : state.status === "ACTIVE" ? fallback("crossDevice.control.active", "Temporary control confirmed")
          : state.status === "EXPIRED" || expired ? fallback("crossDevice.temporary.expired", "This temporary code has expired")
            : state.status === "REVOKED" ? fallback("crossDevice.temporary.revoked", "This temporary code was revoked")
              : fallback("crossDevice.temporary.waiting", "Waiting for the phone to scan");
      pairing.appendChild(make("strong", "", status));
      if (state.claimedDevice?.deviceKeyFingerprint) pairing.appendChild(make("p", "cross-device-helper",
        `${fallback("crossDevice.control.phoneFingerprint", "Phone key fingerprint")}: ${state.claimedDevice.deviceKeyFingerprint}`));
      pairing.appendChild(make("p", "cross-device-helper", state.status === "ACTIVE"
        ? `${fallback("crossDevice.temporary.accessUntil", "Access ends")} ${formatDate(expiresAt)}`
        : `${fallback("crossDevice.temporary.scanBy", "Scan by")} ${formatDate(claimExpiresAt)}`));
      body.appendChild(pairing);
      if (state.status === "CLAIMED" && !expired) actions.appendChild(action(fallback("crossDevice.control.confirm", "Confirm 10-minute control"), async (button) => {
        setBusy(button, true);
        try {
          const data = await api(`/api/device-pairing/temporary-control/invitations/${encodeURIComponent(invitation.invitationId)}/confirm`, { method: "POST" });
          if (data?.invitation?.status !== "ACTIVE") throw new Error("Temporary control confirmation failed");
          temporaryPairingState = { ...state, ...data.invitation }; renderPairing();
        } catch (error) { handleError(error, fallback("crossDevice.control.confirmFailed", "Could not confirm temporary control.")); }
        finally { setBusy(button, false); }
      }, "primary"));
      actions.appendChild(action(fallback("crossDevice.temporary.refresh", "Refresh status"), async (button) => {
        setBusy(button, true);
        try {
          const data = await api("/api/device-pairing/temporary-control/invitations");
          const current = (data?.invitations || []).find((item) => item?.invitationId === invitation.invitationId);
          if (!current) throw new Error("Temporary invitation not found");
          temporaryPairingState = { ...state, ...current };
          renderPairing();
        } catch (error) { handleError(error, fallback("crossDevice.temporary.refreshFailed", "Could not refresh temporary access.")); }
        finally { setBusy(button, false); }
      }));
      if (!expired && !revoked) actions.appendChild(action(fallback("crossDevice.temporary.revoke", "Revoke code"), async (button) => {
        setBusy(button, true);
        try {
          await api(`/api/device-pairing/temporary-control/invitations/${encodeURIComponent(invitation.invitationId)}/revoke`, { method: "POST" });
          temporaryPairingState = { ...state, status: "REVOKED" };
          renderPairing();
        } catch (error) { handleError(error, fallback("crossDevice.temporary.revokeFailed", "Could not revoke temporary access.")); }
        finally { setBusy(button, false); }
      }));
      actions.appendChild(action(fallback("crossDevice.temporary.new", "Revoke and create a new code"), async (button) => {
        setBusy(button, true);
        try {
          if (!expired && !revoked) {
            await api(`/api/device-pairing/temporary-control/invitations/${encodeURIComponent(invitation.invitationId)}/revoke`, { method: "POST" });
          }
          temporaryPairingState = null;
          renderPairing();
        } catch (error) { handleError(error, fallback("crossDevice.temporary.revokeFailed", "Could not revoke temporary access.")); }
        finally { setBusy(button, false); }
      }));
    }
    body.appendChild(actions);
    card.appendChild(body);
    stack.appendChild(card);
  }

  function hydrateIcons(target) {
    if (typeof root.AgentoCIcons?.hydrate === "function") root.AgentoCIcons.hydrate(target);
  }

  function open(options = {}) {
    const requestedView = ["account", "devices", "register"].includes(options.view) ? options.view : "account";
    if (managerMode && requestedView !== "register") {
      if (requestedView === "devices") void renderDevices();
      root.AgentoCDesktopManager?.showAccount?.();
      return true;
    }
    if (!overlay || !sheet) return false;
    restoreFocus = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add("cross-device-panel-open");
    if (managerMode && requestedView === "register") {
      const eyebrow = document.querySelector("#crossDeviceSheet .cross-device-eyebrow");
      const title = document.getElementById("crossDeviceTitle");
      const description = document.getElementById("crossDeviceDescription");
      if (eyebrow) eyebrow.textContent = fallback("desktopManager.page.pairing.title", "Phone pairing");
      if (title) title.textContent = fallback("desktopManager.pairingDialogTitle", "Pair a phone");
      if (description) description.textContent = fallback(
        "desktopManager.pairingDialogDescription",
        "Scan this code in Ragent on your Android phone to connect it to this computer.",
      );
    }
    setActiveView(requestedView);
    closeButton?.focus({ preventScroll: true });
    // The overlay is the body-level modal sibling that must stay interactive.
    // Passing the nested sheet here makes the focus primitive mark the
    // overlay itself inert while isolating body siblings, disabling every
    // control inside the sheet on real browsers.
    focusScopeDeactivate = root.AgentoCFocusScope?.activate?.(overlay, {
      containmentRoot: document.body,
      initialFocus: () => closeButton || sheet,
      restoreFocus: () => restoreFocus,
      modal: true,
      onEscape: () => close(),
    }) || null;
    backEntryId = root.AgentoCBackHandler?.push?.({
      id: "cross-device-workspace",
      onBack: () => { close(); return true; },
    }) || null;
    return true;
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    stopPairingPoll();
    overlay.hidden = true;
    document.body.classList.remove("cross-device-panel-open");
    if (backEntryId) root.AgentoCBackHandler?.pop?.(backEntryId);
    backEntryId = null;
    focusScopeDeactivate?.();
    focusScopeDeactivate = null;
    if (restoreFocus && typeof restoreFocus.focus === "function") restoreFocus.focus({ preventScroll: true });
    restoreFocus = null;
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => setActiveView(tab.dataset.crossDeviceView)));
  closeButton?.addEventListener("click", close);
  overlay?.addEventListener("click", (event) => {
    if (event.target?.dataset?.crossDeviceClose === "true") close();
  });

  function refreshManager() {
    if (!managerMode) return false;
    activeView = "account";
    void renderAccount();
    void renderDevices();
    return true;
  }

  root.AgentoCCrossDevicePanel = Object.freeze({
    open,
    close,
    refresh: () => setActiveView(activeView),
    refreshManager,
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
