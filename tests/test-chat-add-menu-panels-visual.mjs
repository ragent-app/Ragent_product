#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactDir = process.env.RAGENT_QA_ARTIFACT_DIR || join(repoRoot, "artifacts");
await mkdir(artifactDir, { recursive: true });

const [baseCss, inputCss, responsiveCss, glassCss, m3TokensCss, m3ComponentsCss, sheetActionsCss, materialFinishCss, motionSource, iconsSource, agentSource, connectorSource] = await Promise.all([
  readFile(join(repoRoot, "static/chat/chat-base.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-input.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-responsive.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-glass.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-m3-tokens.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-m3-components.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-sheet-actions.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-material-finish.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/motion.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/icons.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/agent-panel.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/connector-panel.js"), "utf8"),
]);

const browser = await chromium.launch({ headless: true,
  ...(process.env.RAGENT_QA_BROWSER_EXECUTABLE ? { executablePath: process.env.RAGENT_QA_BROWSER_EXECUTABLE } : {}) });

async function makePage({ theme = "light", reducedMotion = false, hasTouch = false, viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>
    ${baseCss}
    ${inputCss}
    ${responsiveCss}
    ${glassCss}
    ${m3TokensCss}
    ${m3ComponentsCss}
    ${sheetActionsCss}
    ${materialFinishCss}
    html[data-theme="dark"] { color-scheme: dark; }
    body { margin: 0; min-height: 844px; background: var(--chat-area-bg); }
    .fixture-spacer { height: 704px; }
    .input-area { padding: 0 16px 24px; }
    .input-wrapper { min-height: 92px; }
    .fixture-menu-item { min-height: 44px; }
  </style></head><body>
    <div class="fixture-spacer"></div>
    <div class="input-area">
      <div class="input-wrapper">
        <button class="fixture-menu-item" id="composerAgentsMenuItem" type="button">Agents</button>
        <button class="fixture-menu-item" id="composerConnectorsMenuItem" type="button">Connectors</button>
        <div class="composer-add-panel" id="composerAgentPanel" role="dialog" aria-modal="false" aria-labelledby="composerAgentPanelTitle" tabindex="-1" hidden>
          <div class="composer-add-panel-title" id="composerAgentPanelTitle">Agents &amp; apps</div>
          <div class="composer-add-panel-list" id="composerAgentList" role="radiogroup" aria-labelledby="composerAgentPanelTitle" aria-live="polite"></div>
          <button class="composer-add-panel-footer" id="composerAgentPanelManage" type="button">Manage agents</button>
        </div>
        <div class="composer-add-panel" id="composerConnectorPanel" role="dialog" aria-modal="false" aria-labelledby="composerConnectorPanelTitle" tabindex="-1" hidden>
          <div class="composer-add-panel-title" id="composerConnectorPanelTitle">Connectors</div>
          <div class="composer-add-panel-list" id="composerConnectorList" aria-live="polite"></div>
          <div class="composer-add-panel-status" id="composerConnectorPanelStatus" role="status" aria-live="polite" aria-atomic="true"></div>
          <button class="composer-add-panel-footer" id="composerConnectorPanelManage" type="button">Manage connectors</button>
        </div>
      </div>
    </div>
  </body></html>`);
  await page.addScriptTag({ content: motionSource });
  await page.addScriptTag({ content: iconsSource });
  await page.evaluate(() => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="">Agent</option><option value="writer">Writer</option><option value="planner">Planner</option><option value="__plan">Plan</option>';
    select.value = "writer";
    document.body.appendChild(select);
    window.inlineAgentSelect = select;
    window.refreshInlineAgentPicker = () => Promise.resolve();
    window.connectorSurfacesCache = [
      { connectorId: "calendar", title: "Calendar", surface: { capabilityState: "ready" } },
      { connectorId: "email", title: "Email", surface: { capabilityState: "needs_action" } },
      { connectorId: "github", title: "GitHub", surface: { capabilityState: "needs_action" } },
      { connectorId: "notion", title: "Notion", entryUrl: "/connectors/notion", surface: { capabilityState: "needs_action" } },
    ];
    window.fetchConnectorSurfaces = () => Promise.resolve();
    window.canManageConnectorSurfacesFromUi = () => true;
    window.selectedTool = "codex";
    window.currentSessionId = "fixture-session";
    window.getComposerRuntimeSelectedProvider = () => "fixture-provider";
    window.fixtureCodexServers = [];
    window.fixtureOAuthConnected = false;
    window.fixturePluginEnabled = false;
    window.fixtureSyncStatus = "waiting_for_runtime";
    window.fixtureSyncMode = "approved-auto";
    window.open = () => ({ opener: null, location: { href: "" }, close() {} });
    window.fetch = async (url, options = {}) => {
      if (url.startsWith("/api/sessions/fixture-session/harness-capabilities?")) {
        return new Response(JSON.stringify({ providerProfileId: "fixture-provider", items: [
          { title: "Drive example", source: "codex", kind: "app", enabled: false, state: { runtime: "unknown" } },
          { id: "codex:skill:aaaaaaaaaaaaaaaaaaaa", title: "Review example", source: "codex", kind: "skill", enabled: true, state: { manageable: true } },
          ...(window.fixtureOAuthConnected ? [{ title: "docs", source: "codex", kind: "mcp", state: { authorization: "connected" } }] : []),
        ], errors: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/fixture-session/harness-capabilities/skills" && options.method === "POST") {
        window.fixtureSkillSelection = JSON.parse(options.body);
        return new Response(JSON.stringify({ desiredEnabled: window.fixtureSkillSelection.enabled, effectiveEnabled: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/providers/fixture-provider/codex/plugin-preference") {
        if (options.method === "POST") window.fixturePluginEnabled = JSON.parse(options.body).enabled;
        return new Response(JSON.stringify({ desiredEnabled: window.fixturePluginEnabled, effectiveEnabled: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/providers/fixture-provider/codex/capability-sync") {
        if (options.method === "POST") window.fixtureSyncStatus = "discovered";
        return new Response(JSON.stringify({ sync: { status: window.fixtureSyncStatus }, mode: window.fixtureSyncMode }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/providers/fixture-provider/codex/capability-sync-policy") {
        if (options.method === "POST") window.fixtureSyncMode = JSON.parse(options.body).mode;
        return new Response(JSON.stringify({ mode: window.fixtureSyncMode }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/oauth") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "auth-job", authorizationUrl: "https://example.invalid/authorize" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/oauth/auth-job")) {
        window.fixtureOAuthConnected = true;
        return new Response(JSON.stringify({ state: "connected" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/providers/fixture-provider/codex/mcp-servers")) {
        if (options.method === "POST") {
          const payload = JSON.parse(options.body);
          window.fixtureCodexServers.push({ name: payload.name, transport: { type: payload.url ? "streamable_http" : "stdio" } });
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (options.method === "DELETE") window.fixtureCodexServers = [];
        return new Response(JSON.stringify({ servers: window.fixtureCodexServers }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/claude/mcp-servers") {
        return new Response(JSON.stringify({ servers: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/connectors/calendar/feed") {
        return new Response(JSON.stringify({
          subscriptionUrl: "https://cal.example.test/cal/feedtoken.ics",
          webcalUrl: "webcal://cal.example.test/cal/feedtoken.ics",
          calendarName: "Ragent",
          eventCount: 3,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/connectors/calendar/google/status") {
        return new Response(JSON.stringify({
          provider: "google",
          credentialsPresent: true,
          tokenPresent: false,
          binding: { id: "binding_calendar_21d351117862", title: "Google Calendar", provider: "google", accountHint: "person-2@example.test", capabilityState: "needs_action" },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/connectors/gmail/status" || url === "/api/connectors/drive/status") {
        return new Response(JSON.stringify({
          provider: url.includes("gmail") ? "gmail" : "drive",
          credentialsPresent: false,
          tokenPresent: false,
          binding: { capabilityState: "authorization_required" },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/connectors/github/status") {
        return new Response(JSON.stringify({ configured: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/connectors/mail/status") {
        return new Response(JSON.stringify({
          initialized: true,
          outbound: { provider: "resend_api", configured: false, from: "" },
          automation: { enabled: true },
          counts: { review: 2, quarantine: 0, approved: 1 },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };
    window.t = (key, vars) => {
      const template = ({
        "compose.connectorPanel.codexApp": "App",
        "compose.connectorPanel.codexSkill": "Skill",
        "compose.connectorPanel.codexNotConfirmed": "Availability not confirmed",
        "compose.connectorPanel.codexAuthUnknown": "Authorization unknown",
        "compose.connectorPanel.codexAuthReady": "Authorized",
        "compose.connectorPanel.codexSkillDisable": "Disable",
        "compose.connectorPanel.codexSkillEnable": "Enable",
        "compose.connectorPanel.codexPluginLoading": "Native Plugin loading",
        "compose.connectorPanel.codexPluginWantedOn": "Requested on · runtime restart required",
        "compose.connectorPanel.codexPluginWantedOff": "Requested off · runtime restart may be required",
        "compose.connectorPanel.codexSync": "Codex capability discovery",
        "compose.connectorPanel.codexSyncWaiting": "Waiting for a Codex task",
        "compose.connectorPanel.codexSyncDiscovered": "Discovery checked",
        "compose.connectorPanel.refresh": "Refresh status",
        "compose.connectorPanel.codexSyncPolicy": "Synchronization policy",
        "compose.connectorPanel.codexSkillPending": "Change pending",
      "compose.agent.loading": "Loading agents…",
      "compose.agent.loadingFailed": "Agents unavailable",
      "compose.agent.none": "No agents available yet.",
      "compose.agent.defaultDetail": "Use Ragent's default conversation behavior",
      "compose.agent.customDetail": "Reusable workflow for the next message",
      "compose.agent.selected": "Selected",
      "settings.apps.ownerOnly": "Only available to the owner.",
      "settings.connectors.loading": "Loading connectors…",
      "settings.connectors.loadingFailed": "Failed to load connectors.",
      "settings.connectors.none": "No connector login surfaces are available yet.",
      "settings.connectors.ownerOnly": "Connector login is only available to the owner.",
      "settings.connectors.connected": "Connected",
      "settings.connectors.needsAction": "Needs action",
      "compose.connectorPanel.otherTitle": "Other connectors",
      "compose.connectorPanel.developerTitle": "Developer connections",
      "compose.connectorPanel.developerOpen": "Show developer connections",
      "compose.connectorPanel.developerClose": "Hide developer connections",
      "compose.connectorPanel.codexTitle": "Codex MCP servers",
      "compose.connectorPanel.codexNone": "No Codex MCP servers configured yet.",
      "compose.connectorPanel.codexAdd": "Add server",
      "compose.connectorPanel.codexAddName": "Name (e.g. github)",
      "compose.connectorPanel.codexAddCommand": "Command or https:// URL",
      "compose.connectorPanel.codexArgs": "Arguments (JSON array, optional)",
      "compose.connectorPanel.codexScope": "Codex account: {provider} · Changes apply when the runtime refreshes.",
      "compose.connectorPanel.codexConnect": "Connect",
      "compose.connectorPanel.codexAuthStarted": "Complete authorization on the host.",
      "compose.connectorPanel.codexAuthLink": "Open authorization link",
      "compose.connectorPanel.codexAuthConnected": "MCP authorization is connected.",
      "compose.connectorPanel.codexAddSubmit": "Add",
      "compose.connectorPanel.claudeTitle": "Claude Code MCP servers",
      "compose.connectorPanel.claudeNone": "No Claude Code MCP servers configured yet.",
      "compose.connectorPanel.claudeAdd": "Add server",
      "compose.connectorPanel.claudeAddName": "Name (e.g. github)",
      "compose.connectorPanel.claudeAddCommand": "Command or https:// URL",
      "compose.connectorPanel.claudeAddSubmit": "Add",
      "compose.connectorPanel.calendarTitle": "Calendar",
      "compose.connectorPanel.googleServicesTitle": "Google",
      "compose.connectorPanel.calendarLoadFailed": "Failed to load calendar status.",
      "compose.connectorPanel.calendarFeedTitle": "Calendar subscription",
      "compose.connectorPanel.calendarSubscriptionShort": "Subscription",
      "compose.connectorPanel.calendarFeedCount": "{count} events",
      "compose.connectorPanel.calendarCopyUrl": "Copy subscribe link",
      "compose.connectorPanel.calendarCopyDone": "Copied",
      "compose.connectorPanel.calendarCopyStatus": "Calendar subscription link copied.",
      "compose.connectorPanel.calendarGoogleTitle": "Google Calendar",
      "compose.connectorPanel.calendarGoogleShort": "Calendar",
      "compose.connectorPanel.googleAccountTitle": "Google account",
      "compose.connectorPanel.googleServicesDetail": "Calendar, Gmail and Drive",
      "compose.connectorPanel.googleAccountDetail": "Uses the shared Google account",
      "compose.connectorPanel.calendarGoogleNotConfigured": "Not configured",
      "compose.connectorPanel.googleConnect": "Connect Google",
      "compose.connectorPanel.calendarConnect": "Connect Google Calendar",
      "compose.connectorPanel.calendarAuthOpened": "Google Calendar authorization opened.",
      "compose.connectorPanel.calendarAuthorizeFailed": "Authorization could not be started.",
      "compose.connectorPanel.gmailTitle": "Gmail",
      "compose.connectorPanel.gmailConnect": "Connect Gmail",
      "compose.connectorPanel.driveTitle": "Google Drive",
      "compose.connectorPanel.driveShort": "Drive",
      "compose.connectorPanel.driveConnect": "Connect Google Drive",
      "compose.connectorPanel.googleLoadFailed": "Failed to load Google status.",
      "compose.connectorPanel.googleUnavailable": "Google status is unavailable.",
      "compose.connectorPanel.mailInboxShort": "Inbox",
      "compose.connectorPanel.mailOutboundShort": "Outbound",
      "compose.connectorPanel.mailAutomationShort": "Automation",
      "compose.connectorPanel.githubTitle": "GitHub",
      "compose.connectorPanel.githubUnavailable": "GitHub status is unavailable.",
      "compose.connectorPanel.githubConfigure": "Configure GitHub App",
      "compose.connectorPanel.githubNotConfigured": "Not configured",
      "compose.connectorPanel.mailTitle": "Mail",
      "compose.connectorPanel.mailLoadFailed": "Failed to load mail status.",
      "compose.connectorPanel.mailUnavailable": "Mail status is unavailable.",
      "compose.connectorPanel.mailBoxTitle": "Mailbox",
      "compose.connectorPanel.mailNotInitialized": "Not initialized",
      "compose.connectorPanel.mailSetupHint": "Finish mailbox setup from Connector settings.",
      "compose.connectorPanel.mailSetup": "Open mail settings",
      "compose.connectorPanel.mailQueueCounts": "{review} to review, {quarantine} quarantined",
      "compose.connectorPanel.mailReviewShort": "review",
      "compose.connectorPanel.mailOutboundTitle": "Outbound mail",
      "compose.connectorPanel.mailOutboundConfigured": "Configured",
      "compose.connectorPanel.mailOutboundNotConfigured": "Not configured",
      "compose.connectorPanel.mailConfigureOutbound": "Configure outbound mail",
      "compose.connectorPanel.mailAutomationTitle": "Mail automation",
      "compose.connectorPanel.mailAutomationOn": "On",
      "compose.connectorPanel.mailAutomationOff": "Off",
      "action.cancel": "Cancel",
      }[key] ?? key);
      return Object.entries(vars || {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        template,
      );
    };
    window.RagentBackHandler = { push: () => null, pop: () => {} };
    window.RagentConnectorPanel = { close: () => window.RagentConnectorPanel._close?.() };
    window.RagentAgentPanel = { close: () => window.RagentAgentPanel._close?.() };
  });
  await page.addScriptTag({ content: agentSource });
  await page.addScriptTag({ content: connectorSource });
  return page;
}

try {
  const light = await makePage({ hasTouch: true });
  await light.evaluate(() => {
    const trigger = document.getElementById("composerAgentsMenuItem");
    trigger.focus();
    window.RagentAgentPanel.open();
  });
  await light.waitForTimeout(220);
  const agentProbe = await light.evaluate(() => {
    const panel = document.getElementById("composerAgentPanel");
    const row = panel.querySelector(".composer-add-panel-row");
    const check = panel.querySelector(".composer-add-panel-check .rl-icon");
    const selectedLabel = panel.querySelector(".composer-agent-selection-label");
    const detail = panel.querySelector(".composer-add-panel-row-detail");
    return {
      visible: !panel.hidden,
      labelled: panel.getAttribute("aria-labelledby") === "composerAgentPanelTitle",
      surface: getComputedStyle(panel).backgroundColor,
      backdrop: getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter || "",
      border: getComputedStyle(panel).borderTopColor,
      focusInside: panel.contains(document.activeElement),
      selected: !!panel.querySelector('[aria-checked="true"]'),
      defaultVisible: Array.from(panel.querySelectorAll(".composer-add-panel-row-label")).some((node) => node.textContent === "Agent"),
      sharedIcon: !!check,
      selectedLabel: selectedLabel?.textContent || "",
      detailVisible: !!detail && getComputedStyle(detail).display !== "none",
      touchHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
    };
  });
  assert.deepEqual(agentProbe, {
    visible: true,
    labelled: true,
    surface: "rgb(255, 255, 255)",
    backdrop: "none",
    border: "rgba(0, 0, 0, 0)",
    focusInside: true,
    selected: true,
    defaultVisible: true,
    sharedIcon: true,
    selectedLabel: "Selected",
    detailVisible: true,
    touchHeight: agentProbe.touchHeight,
  }, "agent panel should use the flat light surface contract");
  assert.equal(agentProbe.visible, true, "agent panel should be visible after open");
  assert.equal(agentProbe.labelled, true, "agent panel should expose its accessible title");
  assert.equal(agentProbe.focusInside, true, "keyboard opening should place focus inside the panel");
  assert.equal(agentProbe.selected, true, "current agent should be selected");
  assert.equal(agentProbe.defaultVisible, true, "default Agent should be available to clear a previous selection");
  assert.equal(agentProbe.sharedIcon, true, "selected state should use the shared SVG icon");
  assert.equal(agentProbe.selectedLabel, "Selected", "selected agent should expose a readable trailing state");
  assert.equal(agentProbe.detailVisible, true, "agent rows should expose supporting text");
  assert.ok(agentProbe.touchHeight >= 44, `agent row should keep a touch target, got ${agentProbe.touchHeight}px`);
  await light.screenshot({ path: join(artifactDir, "composer-panel-agent-mobile-light.png"), fullPage: true });

  const selectedFocus = await light.evaluate(() => {
    const selected = document.querySelector('#composerAgentList [aria-checked="true"]');
    selected?.focus();
    const style = selected ? getComputedStyle(selected) : null;
    return {
      outlineStyle: style?.outlineStyle || "",
      outlineWidth: style?.outlineWidth || "",
      outlineColor: style?.outlineColor || "",
    };
  });
  assert.equal(selectedFocus.outlineStyle, "solid", "selected panel rows should retain a keyboard-visible focus ring");
  assert.equal(selectedFocus.outlineWidth, "2px", "selected panel rows should use a compact focus ring");
  assert.notEqual(selectedFocus.outlineColor, "rgba(0, 0, 0, 0)", "selected panel focus ring should use a visible semantic color");

  await light.locator("#composerAgentList .composer-add-panel-row", { hasText: "Planner" }).click();
  await light.waitForTimeout(180);
  const afterAgentPick = await light.evaluate(() => ({
    value: window.inlineAgentSelect.value,
    hidden: document.getElementById("composerAgentPanel").hidden,
    triggerFocused: document.activeElement?.id === "composerAgentsMenuItem",
  }));
  assert.deepEqual(afterAgentPick, { value: "planner", hidden: true, triggerFocused: true }, "agent selection should close and restore focus");

  await light.evaluate(() => {
    document.getElementById("composerConnectorsMenuItem").focus();
    window.RagentConnectorPanel.open();
  });
  await light.waitForTimeout(220);
  const connectorProbe = await light.evaluate(() => {
    const panel = document.getElementById("composerConnectorPanel");
    const panelStyle = getComputedStyle(panel);
    const backdrop = Array.from(document.querySelectorAll(".composer-add-panel-backdrop")).find((node) => !node.hidden);
    const handle = panel.querySelector(".composer-add-panel-handle-zone");
    const ready = panel.querySelector(".is-static");
    const actionable = panel.querySelector(".is-actionable");
    const codexTitle = Array.from(panel.querySelectorAll(".composer-add-panel-group-title")).some((node) => node.textContent === "Codex MCP servers");
    const claudeTitle = Array.from(panel.querySelectorAll(".composer-add-panel-group-title")).some((node) => node.textContent === "Claude Code MCP servers");
    const otherTitle = Array.from(panel.querySelectorAll(".composer-add-panel-group-title")).some((node) => node.textContent === "Other connectors");
    const developerDisclosure = panel.querySelector(".composer-add-panel-disclosure");
    const calendarTitle = Array.from(panel.querySelectorAll(".composer-add-panel-group-title")).some((node) => node.textContent === "Google");
    const mailTitle = Array.from(panel.querySelectorAll(".composer-add-panel-group-title")).some((node) => node.textContent === "Mail");
    const calendarRows = Array.from(panel.querySelectorAll(".composer-add-panel-row--calendar")).length;
    const mailRows = Array.from(panel.querySelectorAll(".composer-add-panel-row--mail")).length;
    return {
      visible: !panel.hidden,
      mobileSheet: panelStyle.position === "fixed" && Math.round(panel.getBoundingClientRect().left) === 0 && Math.round(panel.getBoundingClientRect().width) === window.innerWidth,
      surface: panelStyle.backgroundColor,
      backdrop: panelStyle.backdropFilter || panelStyle.webkitBackdropFilter || "",
      border: panelStyle.borderTopColor,
      backdropVisible: !!backdrop && !backdrop.hidden,
      listTouchAction: getComputedStyle(panel.querySelector(".composer-add-panel-list")).touchAction,
      handleTouchAction: handle ? getComputedStyle(handle).touchAction : "",
      readyIsStatusRow: ready?.tagName === "DIV",
      actionableIsButton: actionable?.tagName === "BUTTON",
      arrow: !!actionable?.querySelector(".composer-add-panel-arrow .rl-icon"),
      otherTitle,
      developerCollapsed: developerDisclosure?.getAttribute("aria-expanded") === "false",
      mcpSectionsVisible: codexTitle && claudeTitle,
      calendarSectionVisible: calendarTitle && calendarRows >= 2,
      mailSectionVisible: mailTitle && mailRows >= 3,
      duplicateBuiltInRows: Array.from(panel.querySelectorAll(".composer-add-panel-row--connector .composer-add-panel-row-label")).some((node) => node.textContent === "Calendar" || node.textContent === "Email"),
      focusInside: panel.contains(document.activeElement),
    };
  });
  assert.deepEqual(connectorProbe, { visible: true, mobileSheet: true, surface: "rgb(255, 255, 255)", backdrop: "none", border: "rgba(0, 0, 0, 0)", backdropVisible: true, listTouchAction: "pan-y", handleTouchAction: "none", readyIsStatusRow: true, actionableIsButton: true, arrow: true, otherTitle: true, developerCollapsed: true, mcpSectionsVisible: false, calendarSectionVisible: true, mailSectionVisible: true, duplicateBuiltInRows: false, focusInside: true }, "connector panel should use a contained flat light surface");
  const compactActionProbe = await light.evaluate(() => {
    const panel = document.getElementById("composerConnectorPanel");
    const action = panel.querySelector(".composer-add-panel-refresh, .composer-add-panel-action");
    return {
      actionWidth: action ? Math.round(action.getBoundingClientRect().width) : 0,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
    };
  });
  assert.ok(compactActionProbe.actionWidth > 0, "connector should expose a visible compact action when status needs attention");
  assert.ok(compactActionProbe.actionWidth < compactActionProbe.panelWidth * 0.72, "connector actions should remain content-width mobile buttons");
  await light.locator(".composer-add-panel-row--calendar").first().click();
  assert.equal(await light.locator("#composerConnectorPanel").isVisible(), true, "tapping inside a connector status row should not close the panel");
  const touchTarget = await light.locator(".composer-add-panel-row--calendar").first().boundingBox();
  assert.ok(touchTarget, "connector status row should have a touch target");
  await light.touchscreen.tap(touchTarget.x + touchTarget.width / 2, touchTarget.y + touchTarget.height / 2);
  assert.equal(await light.locator("#composerConnectorPanel").isVisible(), true, "a real touch tap inside the connector panel should not close it");
  const connectorListBox = await light.locator("#composerConnectorList").boundingBox();
  if (connectorListBox) {
    await light.mouse.move(connectorListBox.x + connectorListBox.width / 2, connectorListBox.y + connectorListBox.height / 2);
    await light.mouse.wheel(0, 260);
    await light.waitForTimeout(80);
  }
  assert.equal(await light.locator("#composerConnectorPanel").isVisible(), true, "scrolling connector content should not close the panel");
  await light.screenshot({ path: join(artifactDir, "composer-panel-connector-mobile-light.png"), fullPage: true });

  await light.locator("#composerConnectorList .composer-add-panel-disclosure").click();
  await light.waitForTimeout(220);
  assert.equal(await light.locator("#composerConnectorList .composer-add-panel-group-title", { hasText: "Codex MCP servers" }).count(), 1, "developer connections should expand on demand");
  const addServerButton = light.locator("#composerConnectorList .composer-add-panel-add", { hasText: "Add server" }).first();
  await addServerButton.scrollIntoViewIfNeeded();
  await addServerButton.click();
  await light.waitForTimeout(60);
  const formProbe = await light.evaluate(() => {
    const input = document.querySelector(".composer-add-panel-codex-input");
    const submit = document.querySelector(".composer-add-panel-form-actions .composer-add-panel-refresh");
    const cancel = document.querySelector(".composer-add-panel-form-cancel");
    return {
      inputFontSize: input ? getComputedStyle(input).fontSize : "",
      submitHeight: submit ? Math.round(submit.getBoundingClientRect().height) : 0,
      cancelHeight: cancel ? Math.round(cancel.getBoundingClientRect().height) : 0,
      form: !!document.querySelector(".composer-add-panel-codex-form"),
    };
  });
  assert.deepEqual(formProbe, { inputFontSize: "16px", submitHeight: 48, cancelHeight: 48, form: true }, "MCP form should be keyboard-friendly and touch-safe on mobile");
  await light.screenshot({ path: join(artifactDir, "composer-panel-connector-form-mobile-light.png"), fullPage: true });
  await light.locator("#composerConnectorPanel").screenshot({ path: join(artifactDir, "composer-panel-connector-form-mobile-light-element.png") });
  assert.equal(await light.getByText("Drive example").count(), 1, "Codex apps should be visible in the connector panel");
  assert.equal(await light.getByText("Availability not confirmed").count(), 1, "discovery alone must not claim an app is callable");
  await light.locator('#composerConnectorList .composer-add-panel-row', { hasText: 'Native Plugin loading' }).getByRole('button', { name: 'Enable' }).click();
  await light.getByText('Requested on · runtime restart required').waitFor();
  assert.equal(await light.evaluate(() => window.fixturePluginEnabled), true);
  await light.locator('#composerConnectorList .composer-add-panel-row', { hasText: 'Codex capability discovery' }).getByRole('button', { name: 'Refresh status' }).click();
  await light.getByText('Discovery checked').waitFor();
  await light.getByLabel('Synchronization policy').selectOption('manual');
  await light.waitForFunction(() => window.fixtureSyncMode === 'manual');
  await light.locator('#composerConnectorList .composer-add-panel-row', { hasText: 'Review example' }).getByRole('button', { name: 'Disable' }).click();
  await light.locator('#composerConnectorList .composer-add-panel-row', { hasText: 'Review example' }).getByText('Change pending').waitFor();
  assert.equal(await light.evaluate(() => window.fixtureSkillSelection.enabled), false, 'Skill choice must target the current account without claiming immediate effect');
  await light.locator('.composer-add-panel-codex-form input[name="name"]').fill('docs');
  await light.locator('.composer-add-panel-codex-form input[name="command"]').fill('https://example.invalid/mcp');
  await light.locator('.composer-add-panel-codex-form button[type="submit"]').click();
  await light.locator('#composerConnectorList .composer-add-panel-row--codex', { hasText: 'docs' }).waitFor();
  assert.equal(await light.evaluate(() => window.fixtureCodexServers[0].name), 'docs', 'the scoped MCP form must persist its server through the selected-provider API');
  await light.locator('#composerConnectorList .composer-add-panel-row--codex', { hasText: 'docs' }).getByText('Authorization unknown').waitFor();
  await light.locator('#composerConnectorList .composer-add-panel-row--codex', { hasText: 'docs' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await light.locator('#composerConnectorPanelStatus', { hasText: 'MCP authorization is connected.' }).waitFor({ timeout: 7000 });
  await light.locator('#composerConnectorList .composer-add-panel-row--codex', { hasText: 'docs' }).getByText('Authorized', { exact: true }).waitFor();
  await light.mouse.click(8, 8);
  await light.waitForTimeout(180);
  assert.equal(await light.locator("#composerConnectorPanel").isHidden(), true, "tapping the mobile sheet backdrop should dismiss the panel");

  await light.evaluate(() => window.RagentConnectorPanel.close());
  await light.evaluate(() => {
    document.getElementById("composerConnectorsMenuItem").focus();
    window.RagentConnectorPanel.open();
  });
  await light.waitForTimeout(220);
  const handleBox = await light.locator("#composerConnectorPanel .composer-add-panel-handle-zone").boundingBox();
  assert.ok(handleBox, "mobile connector sheet should expose a draggable handle");
  await light.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await light.mouse.down();
  await light.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 140);
  await light.mouse.up();
  await light.waitForTimeout(220);
  assert.equal(await light.locator("#composerConnectorPanel").isHidden(), true, "dragging the sheet handle downward should dismiss the panel");
  await light.evaluate(() => {
    document.getElementById("composerConnectorsMenuItem").focus();
    window.RagentConnectorPanel.open();
  });
  await light.waitForTimeout(220);
  await light.locator("#composerConnectorList .is-actionable").click();
  await light.locator("#composerConnectorPanel").waitFor({ state: "hidden", timeout: 1000 });
  assert.equal(await light.locator("#composerConnectorPanel").getAttribute("hidden"), "", "connector action should close the panel");
  await light.close();

  const dark = await makePage({ theme: "dark" });
  await dark.evaluate(() => window.RagentConnectorPanel.open());
  await dark.waitForTimeout(220);
  await dark.screenshot({ path: join(artifactDir, "composer-panel-connector-mobile-dark.png"), fullPage: true });
  const darkProbe = await dark.evaluate(() => {
    const panel = document.querySelector("#composerConnectorPanel");
    const pill = document.querySelector(".composer-add-panel-pill.is-ready");
    const style = getComputedStyle(panel);
    return {
      surface: style.backgroundColor,
      backdrop: style.backdropFilter || style.webkitBackdropFilter || "",
      pillColor: getComputedStyle(pill).color,
    };
  });
  assert.deepEqual(darkProbe, { surface: "rgb(21, 22, 23)", backdrop: "none", pillColor: darkProbe.pillColor }, "dark mode should use the panel surface defined by the current theme");
  assert.notEqual(darkProbe.pillColor, "rgb(14, 107, 64)", "dark mode should not reuse the light success text color");
  await dark.close();

  const desktop = await makePage({ viewport: { width: 1440, height: 900 } });
  await desktop.evaluate(() => {
    document.getElementById("composerAgentsMenuItem").focus();
    window.RagentAgentPanel.open();
  });
  await desktop.waitForTimeout(220);
  const desktopAgentProbe = await desktop.evaluate(() => {
    const panel = document.getElementById("composerAgentPanel");
    const rect = panel.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      right: Math.round(rect.right),
      viewport: window.innerWidth,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  assert.ok(desktopAgentProbe.width <= 360, `desktop agent panel should stay compact, got ${desktopAgentProbe.width}px`);
  assert.equal(desktopAgentProbe.pageOverflow, false, "desktop agent panel should not create page overflow");
  assert.ok(desktopAgentProbe.right <= desktopAgentProbe.viewport + 1, "desktop agent panel should stay inside the viewport");
  await desktop.screenshot({ path: join(artifactDir, "composer-panel-agent-desktop-light.png"), fullPage: true });
  await desktop.locator("#composerAgentPanel").screenshot({ path: join(artifactDir, "composer-panel-agent-desktop-light-element.png") });
  await desktop.evaluate(() => {
    window.RagentAgentPanel.close();
    document.getElementById("composerConnectorsMenuItem").focus();
    window.RagentConnectorPanel.open();
  });
  await desktop.waitForTimeout(220);
  await desktop.screenshot({ path: join(artifactDir, "composer-panel-connector-desktop-light.png"), fullPage: true });
  await desktop.locator("#composerConnectorPanel").screenshot({ path: join(artifactDir, "composer-panel-connector-desktop-light-element.png") });
  await desktop.evaluate(() => {
    const list = document.getElementById("composerConnectorList");
    if (list) list.scrollTop = list.scrollHeight;
  });
  await desktop.waitForTimeout(60);
  await desktop.locator("#composerConnectorPanel").screenshot({ path: join(artifactDir, "composer-panel-connector-desktop-bottom-element.png") });
  await desktop.close();

  for (const viewport of [
    { width: 360, height: 800 },
    { width: 430, height: 932 },
    { width: 1024, height: 768 },
  ]) {
    const page = await makePage({ viewport, reducedMotion: true });
    await page.evaluate(() => window.RagentConnectorPanel.open());
    await page.waitForTimeout(40);
    const probe = await page.evaluate(() => {
      const panel = document.getElementById("composerConnectorPanel");
      const rect = panel.getBoundingClientRect();
      return {
        visible: !panel.hidden && rect.width > 0 && rect.height > 0,
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        minRowHeight: Math.round(Math.min(...Array.from(panel.querySelectorAll(".composer-add-panel-row")).map((row) => row.getBoundingClientRect().height))),
      };
    });
    assert.equal(probe.visible, true, `connector panel should be visible at ${viewport.width}px`);
    assert.equal(probe.overflow, false, `connector panel should not cause horizontal overflow at ${viewport.width}px`);
    assert.ok(probe.right <= probe.viewportWidth + 1, `connector panel should stay inside ${viewport.width}px viewport`);
    assert.ok(probe.bottom <= probe.viewportHeight + 1, `connector panel should stay inside ${viewport.width}px viewport`);
    assert.ok(probe.minRowHeight >= 44, `connector rows should remain touch-safe at ${viewport.width}px, got ${probe.minRowHeight}px`);
    await page.screenshot({ path: join(artifactDir, `composer-panel-connector-${viewport.width}.png`), fullPage: true });
    await page.close();
  }

  const reduced = await makePage({ reducedMotion: true });
  await reduced.evaluate(() => window.RagentAgentPanel.open());
  await reduced.waitForTimeout(30);
  assert.equal(await reduced.locator("#composerAgentPanel").isVisible(), true, "reduced-motion panel should open immediately");
  await reduced.evaluate(() => window.RagentAgentPanel.close());
  assert.equal(await reduced.locator("#composerAgentPanel").isHidden(), true, "reduced-motion panel should close without a delayed hidden state");
  await reduced.close();

  console.log("test-chat-add-menu-panels-visual: ok");
} finally {
  await browser.close();
}
