#!/usr/bin/env node
// Composer "+" menu inline panels: Agent picker (stage 1) and Connector
// status panel (stage 2a). Asserts the DOM, i18n keys, module wiring and
// the sidebar-ui menu-item handlers against the implemented contract.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const [templateSource, i18nSource, agentPanelSource, connectorPanelSource, sidebarSource, sessionHttpSource, toolingSource, composeSource, inputCss, responsiveCss, sheetActionsCss, connectorRoutesSource, m3ComponentsCss] = await Promise.all([
  readFile(join(repoRoot, 'templates/chat.html'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/i18n.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/agent-panel.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/connector-panel.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/sidebar-ui.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/tooling.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/compose.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-input.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-sheet-actions.css'), 'utf8'),
  readFile(join(repoRoot, 'chat/router-connector-routes.mjs'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/chat-m3-components.css'), 'utf8'),
]);

// --- 1. DOM: both panels exist, start hidden, live next to the add menu ---
assert.match(templateSource, /<div class="composer-add-panel" id="composerAgentPanel"[^>]*role="dialog"[^>]*aria-labelledby="composerAgentPanelTitle"[^>]*hidden>/, 'agent panel should exist as hidden dialog');
assert.match(templateSource, /id="composerAgentList"/, 'agent panel should have a list container');
assert.match(templateSource, /id="composerAgentList"[^>]*aria-live="polite"/, 'agent list should announce async state changes');
assert.match(templateSource, /id="composerAgentList"[^>]*role="radiogroup"/, 'agent choices should expose radio-group semantics');
assert.match(templateSource, /id="composerAgentPanelManage"[^>]*data-i18n="compose\.agent\.manage"/, 'agent panel should have a manage footer');
assert.doesNotMatch(templateSource, /id="composerProviderMenuItem"/, 'Provider should no longer be an add-menu item');
assert.doesNotMatch(templateSource, /id="composerProviderPanel"/, 'the old standalone Provider panel should be removed');
assert.match(templateSource, /id="composerRuntimeProviderView"/, 'Provider should occupy a runtime picker level');
assert.match(templateSource, /id="composerRuntimeProviderOptions"[^>]*role="menu"/, 'runtime Provider choices should use the runtime menu semantics');
assert.match(templateSource, /id="composerRuntimeModelView"/, 'the model picker should remain the next runtime level');
assert.match(templateSource, /<div class="composer-add-panel" id="composerConnectorPanel"[^>]*role="dialog"[^>]*aria-labelledby="composerConnectorPanelTitle"[^>]*hidden>/, 'connector panel should exist as hidden dialog');
assert.match(templateSource, /id="composerConnectorList"/, 'connector panel should have a list container');
assert.match(templateSource, /id="composerConnectorList"[^>]*aria-live="polite"/, 'connector list should announce async state changes');
assert.match(templateSource, /id="composerConnectorPanelStatus"[^>]*role="status"[^>]*aria-live="polite"/, 'connector panel should expose an async status announcement');
assert.match(templateSource, /id="composerConnectorPanelManage"[^>]*data-i18n="compose\.connectorPanel\.manage"/, 'connector panel should have a manage footer');
assert.match(templateSource, /id="composerConnectorsMenuItem"[^>]*aria-haspopup="dialog"/, 'connector trigger should declare its dialog relationship');

const sidebarScriptIndex = templateSource.indexOf('src="chat/sidebar-ui.js');
const agentPanelScriptIndex = templateSource.indexOf('src="chat/agent-panel.js');
const connectorPanelScriptIndex = templateSource.indexOf('src="chat/connector-panel.js');
assert.notEqual(sidebarScriptIndex, -1, 'sidebar-ui script should exist');
assert.ok(agentPanelScriptIndex > sidebarScriptIndex, 'agent-panel.js should load after sidebar-ui.js');
assert.ok(connectorPanelScriptIndex > agentPanelScriptIndex, 'connector-panel.js should load after agent-panel.js');

// --- 2. i18n keys ---
for (const key of [
  'compose.agent.manage',
  'compose.agent.none',
  'compose.agent.defaultDetail',
  'compose.agent.customDetail',
  'compose.agent.selected',
  'compose.add.provider',
  'compose.add.providerNote',
  'compose.provider.title',
  'compose.provider.current',
  'compose.provider.loading',
  'compose.provider.unavailable',
  'compose.provider.loadingFailed',
  'compose.provider.selectFailed',
  'compose.connectorPanel.title',
  'compose.connectorPanel.manage',
  'compose.connectorPanel.otherTitle',
  'compose.connectorPanel.developerTitle',
  'compose.connectorPanel.developerOpen',
  'compose.connectorPanel.developerClose',
  'compose.connectorPanel.none',
  'compose.connectorPanel.back',
  'compose.connectorPanel.refresh',
  'compose.connectorPanel.codexTitle',
  'compose.connectorPanel.codexNone',
  'compose.connectorPanel.codexAdd',
  'compose.connectorPanel.codexAddName',
  'compose.connectorPanel.codexAddCommand',
  'compose.connectorPanel.codexAddSubmit',
  'compose.connectorPanel.codexRemove',
  'compose.connectorPanel.codexLoadFailed',
  'compose.connectorPanel.codexAddFailed',
  'compose.connectorPanel.codexFormError',
  'compose.connectorPanel.codexOAuth',
  'compose.connectorPanel.claudeTitle',
  'compose.connectorPanel.claudeNone',
  'compose.connectorPanel.claudeAdd',
  'compose.connectorPanel.claudeAddName',
  'compose.connectorPanel.claudeAddCommand',
  'compose.connectorPanel.claudeAddSubmit',
  'compose.connectorPanel.claudeRemove',
  'compose.connectorPanel.claudeLoadFailed',
  'compose.connectorPanel.claudeAddFailed',
  'compose.connectorPanel.claudeFormError',
  'compose.connectorPanel.calendarTitle',
  'compose.connectorPanel.calendarLoadFailed',
  'compose.connectorPanel.calendarFeedTitle',
  'compose.connectorPanel.calendarFeedCount',
  'compose.connectorPanel.calendarCopyUrl',
  'compose.connectorPanel.calendarCopyDone',
  'compose.connectorPanel.calendarCopyStatus',
  'compose.connectorPanel.calendarGoogleTitle',
  'compose.connectorPanel.googleAccountTitle',
  'compose.connectorPanel.googleServicesDetail',
  'compose.connectorPanel.googleAccountDetail',
  'compose.connectorPanel.calendarGoogleNotConfigured',
  'compose.connectorPanel.calendarConnect',
  'compose.connectorPanel.calendarAuthOpened',
  'compose.connectorPanel.calendarAuthorizeFailed',
  'compose.connectorPanel.mailTitle',
  'compose.connectorPanel.mailLoadFailed',
  'compose.connectorPanel.mailUnavailable',
  'compose.connectorPanel.mailBoxTitle',
  'compose.connectorPanel.mailNotInitialized',
  'compose.connectorPanel.mailSetupHint',
  'compose.connectorPanel.mailSetup',
  'compose.connectorPanel.mailQueueCounts',
  'compose.connectorPanel.mailReviewShort',
  'compose.connectorPanel.mailOutboundTitle',
  'compose.connectorPanel.mailOutboundConfigured',
  'compose.connectorPanel.mailOutboundNotConfigured',
  'compose.connectorPanel.mailConfigureOutbound',
  'compose.connectorPanel.mailAutomationTitle',
  'compose.connectorPanel.mailAutomationOn',
  'compose.connectorPanel.mailAutomationOff',
]) {
  assert.ok(i18nSource.includes(`"${key}"`), `i18n key ${key} should exist`);
}

// --- 3. agent-panel.js wiring ---
assert.match(agentPanelSource, /window\.RagentAgentPanel = Object\.freeze\(\{\s*open: openPanel,\s*close: closePanel,\s*isOpen: \(\) => panelOpen,\s*\}\)/, 'agent panel should export open/close/isOpen');
assert.match(agentPanelSource, /refreshInlineAgentPicker\(\{ force: true \}\)/, 'agent panel should reuse the existing inlineAgentSelect fill pipeline');
assert.match(agentPanelSource, /dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/, 'agent selection should go through the existing inlineAgentSelect change handler');
assert.match(agentPanelSource, /option\.value !== "__plan"/, 'agent panel should not duplicate the plan-mode entry (menus own it)');
assert.match(agentPanelSource, /option\.value !== "__plan" && String\(option\.textContent/, 'agent panel should keep the default empty-value Agent option selectable');
assert.match(agentPanelSource, /RagentBackHandler/, 'agent panel should register a back-handler entry (mobile close)');
assert.match(agentPanelSource, /event\.key === "Escape"/, 'agent panel should close on Escape');
assert.match(agentPanelSource, /!panel\.contains\(event\.target\)/, 'agent panel should close on outside click');
assert.match(agentPanelSource, /!trigger\?\.contains\(event\.target\)/, 'agent panel should stay open for the trigger click that opened it');
assert.match(agentPanelSource, /panel\?\.addEventListener\("click", \(event\) => event\.stopPropagation\(\)\)/, 'agent panel should stop inside clicks from reaching page-level dismissers');
assert.match(agentPanelSource, /composer-add-panel-handle-zone/, 'agent panel should expose a draggable mobile sheet handle');
assert.match(agentPanelSource, /deltaY >= 120/, 'agent panel should use a deliberate downward dismiss threshold');
assert.match(agentPanelSource, /document\.addEventListener\("pointerdown", \(event\) =>/, 'agent sheet should close from a mobile outside pointerdown');
assert.match(agentPanelSource, /settings\.apps\.ownerOnly/, 'agent panel should degrade for non-owner sessions');
assert.match(agentPanelSource, /RagentIcons(?:\?\.|\.)render\("check"\)/, 'agent selection should use the shared SVG icon system');
assert.match(agentPanelSource, /composer-agent-list-item/, 'agent choices should use the Material list-item structure');
assert.match(agentPanelSource, /composer-agent-row-copy/, 'agent choices should expose supporting text beside the title');
assert.match(agentPanelSource, /compose\.agent\.customDetail/, 'custom agents should carry a supporting description');
assert.match(agentPanelSource, /compose\.agent\.selected/, 'the selected agent should expose an explicit trailing state');
assert.match(agentPanelSource, /focusFirstItem/, 'agent panel should move keyboard focus into the opened panel');
assert.match(agentPanelSource, /RagentMotion\?\.setPresence/, 'agent panel should use the shared motion lifecycle');
assert.match(agentPanelSource, /document\.body\.appendChild\(panel\)/, 'agent panel should escape composer stacking contexts');
assert.match(agentPanelSource, /composer-add-panel--agent/, 'agent sheet should carry its focused visual variant');

// --- 3b. runtime Provider/model picker wiring ---
assert.doesNotMatch(sidebarSource, /composerProviderMenuItem/, 'the add-menu handler should not retain a Provider trigger');
assert.doesNotMatch(sessionHttpSource, /RagentProviderPanel/, 'session attachment should not sync a standalone Provider panel');
assert.match(toolingSource, /function getComposerRuntimeProviderApp/, 'runtime picker should identify tools with Provider selection');
assert.match(toolingSource, /function loadComposerRuntimeProviders/, 'runtime picker should load the native Provider registry');
assert.match(toolingSource, /native-providers\?tool=/, 'runtime picker should request only providers compatible with the selected Harness');
assert.match(toolingSource, /native-providers\?tool=[\s\S]*?cacheMaxAgeMs:\s*10_000/, 'runtime provider picker should reuse a short-lived catalog cache');
assert.match(toolingSource, /applyInlineToolSelection\(toolId, \{ deferModelLoad: !!providerApp \}\)/, 'provider-backed Harness selection should not block on model discovery');
assert.match(toolingSource, /action: "session_preferences"[\s\S]*?providerProfile/, 'runtime Provider selection should persist the attached session preference');
assert.match(toolingSource, /setComposerRuntimeView\(providerApp \? "providers" : "models"/, 'agy-like tools should skip the Provider level');
assert.match(toolingSource, /setComposerRuntimeView\("models", "forward"\)/, 'selecting a Provider should enter the model level');
assert.match(toolingSource, /function filterModelsForSessionProvider/, 'Codex model choices should be filtered by the attached session Provider');
assert.match(toolingSource, /endsWith\(suffix\)/, 'Codex Provider filtering should use the scoped model id suffix');
assert.match(toolingSource, /hasScopedModelIds[\s\S]*?return hasScopedModelIds \? \[\] : models/, 'Provider filtering must fail closed instead of showing another provider\'s models');
// Claude Code sessions scope model ids per native provider too — the model
// sheet must never mix another provider's tiers in.
assert.match(toolingSource, /isClaude = toolId === "claude" \|\| toolId === "claude-bidi"/, 'Claude model choices should also be filtered by the attached session Provider');
// The composer speed panel owns effort input for Claude Code; the model sheet
// keeps its effort state but must not render the dropdown.
assert.match(toolingSource, /currentToolReasoningKind === "enum"[\s\S]*?effortSelect\.style\.display = "none"/, 'model picker should keep effort state out of the model list');

// --- 4. connector-panel.js wiring ---
assert.match(connectorPanelSource, /window\.RagentConnectorPanel = Object\.freeze\(\{\s*open: openPanel,\s*close: closePanel,\s*isOpen: \(\) => panelOpen,\s*\}\)/, 'connector panel should export open/close/isOpen');
assert.match(connectorPanelSource, /fetchConnectorSurfaces\(\)/, 'connector panel should reuse the settings connector surfaces fetch');
assert.match(connectorPanelSource, /connectorSurfacesCache/, 'connector panel should read the shared surfaces cache');
assert.match(connectorPanelSource, /capabilityState === "ready"/, 'connector panel should classify ready vs needs-action');
assert.match(connectorPanelSource, /settings\.connectors\.connected/, 'connector panel should reuse the connected i18n label');
assert.match(connectorPanelSource, /settings\.connectors\.needsAction/, 'connector panel should reuse the needs-action i18n label');
assert.match(connectorPanelSource, /settings\.connectors\.ownerOnly/, 'connector panel should degrade for non-owner sessions');
assert.match(connectorPanelSource, /switchTab\("settings"\)/, 'connector panel should route authorization into Settings');
assert.match(connectorPanelSource, /createElement\(ready \? "div" : "button"\)/, 'connected connector rows should be status rows, not disabled actions');
assert.match(connectorPanelSource, /RagentIcons(?:\?\.|\.)render\("chevron-right"\)/, 'actionable connector rows should use the shared SVG icon system');
assert.match(connectorPanelSource, /RagentMotion\?\.setPresence/, 'connector panel should use the shared motion lifecycle');
assert.match(connectorPanelSource, /!trigger\?\.contains\(event\.target\)/, 'connector panel should stay open for the trigger click that opened it');
assert.match(connectorPanelSource, /panel\?\.addEventListener\("click", \(event\) => event\.stopPropagation\(\)\)/, 'connector panel should stop inside clicks from reaching page-level dismissers');
assert.match(connectorPanelSource, /composer-add-panel-handle-zone/, 'connector panel should expose a draggable mobile sheet handle');
assert.match(connectorPanelSource, /deltaY >= 120/, 'connector panel should use a deliberate downward dismiss threshold');
assert.match(connectorPanelSource, /document\.addEventListener\("pointerdown", \(event\) =>/, 'connector sheet should close from a mobile outside pointerdown');
assert.match(connectorPanelSource, /document\.body\.appendChild\(panel\)/, 'connector panel should escape composer stacking contexts');
assert.match(connectorPanelSource, /composer-add-panel--connector/, 'connector sheet should carry its focused visual variant');

// --- 4b. connector-panel.js in-panel authorize view ---
assert.match(connectorPanelSource, /function openAuthorizeView\(surface\)/, 'connector panel should render an in-panel authorize view');
assert.match(connectorPanelSource, /function resolveSurfaceUrl\(entryUrl\)/, 'connector panel should resolve surface entry urls like settings-ui');
assert.match(connectorPanelSource, /window\.ragentResolveProductUrl/, 'surface resolution should honor the product-url resolver hook');
assert.match(connectorPanelSource, /surface\?\.allowEmbed === true/, 'only embeddable surfaces should open the in-panel authorize view');
assert.match(connectorPanelSource, /"composer-add-panel-frame"/, 'the authorize view should embed the surface in an iframe');
assert.match(connectorPanelSource, /"composer-add-panel-back"/, 'the authorize view should carry a back-to-list button');
assert.match(connectorPanelSource, /t\("compose\.connectorPanel\.back"\)/, 'the back button should use the i18n label');
assert.match(connectorPanelSource, /"composer-add-panel-refresh"/, 'the authorize view should carry a refresh-status button');
assert.match(connectorPanelSource, /t\("compose\.connectorPanel\.refresh"\)/, 'the refresh button should use the i18n label');
assert.match(connectorPanelSource, /void refresh\(\)\.then\(renderList, renderList\)/, 'back and refresh should re-render the connector list');

// --- 4c. connector-panel.js Codex MCP servers group ---
assert.match(connectorPanelSource, /\/api\/providers\/.*\/codex\/mcp-servers/, 'connector panel should scope codex mcp servers to the selected provider');
assert.match(connectorPanelSource, /function fetchCodexMcpServers/, 'connector panel should fetch the codex server list');
assert.match(connectorPanelSource, /function renderCodexSection/, 'connector panel should render a codex section');
assert.match(connectorPanelSource, /function removeCodexServer/, 'connector panel should support removing a codex server');
assert.match(connectorPanelSource, /function submitCodexServer/, 'connector panel should support adding a codex server');
assert.match(connectorPanelSource, /compose\.connectorPanel\.codexTitle/, 'the codex section should use the i18n title');
assert.match(connectorPanelSource, /codexTransportSummary/, 'rows should summarize stdio/http transport');
assert.match(connectorPanelSource, /streamable_http/, 'rows should surface Codex streamable HTTP transport');
assert.match(connectorPanelSource, /state\?\.authorization/, 'rows should surface verified runtime authorization status');
assert.match(connectorPanelSource, /composer-add-panel-codex-input/, 'the add form should use the panel input style');
assert.ok(connectorPanelSource.includes('payload = /^https?:\\/\\//i.test(command)'), 'command vs url should be split by scheme');

// --- 4d. connector-panel.js Claude Code MCP servers group ---
assert.match(connectorPanelSource, /\/api\/claude\/mcp-servers/, 'connector panel should list claude mcp servers from the backend api');
assert.match(connectorPanelSource, /function fetchClaudeMcpServers/, 'connector panel should fetch the claude server list');
assert.match(connectorPanelSource, /function renderClaudeSection/, 'connector panel should render a claude section');
assert.match(connectorPanelSource, /function removeClaudeServer/, 'connector panel should support removing a claude server');
assert.match(connectorPanelSource, /function submitClaudeServer/, 'connector panel should support adding a claude server');
assert.match(connectorPanelSource, /compose\.connectorPanel\.claudeTitle/, 'the claude section should use the i18n title');
assert.match(connectorPanelSource, /claudeTransportSummary/, 'rows should summarize stdio/http transport');
assert.ok(connectorPanelSource.includes('{ name, url: command }'), 'panel payloads carry only name and url — never env values');
assert.ok(connectorPanelSource.includes('{ name, command }'), 'panel payloads carry only name and command — never env values');
assert.match(connectorPanelSource, /composer-add-panel-claude-input/, 'the add form should use the panel input style');

// --- 4e. connector-panel.js Calendar and Mail status groups ---
assert.match(connectorPanelSource, /\/api\/connectors\/calendar\/feed/, 'calendar group should fetch the local iCal feed status');
assert.match(connectorPanelSource, /\/api\/connectors\/calendar\/google\/status/, 'calendar group should fetch the Google Calendar auth status');
assert.match(connectorPanelSource, /\/api\/connectors\/calendar\/google\/authorize/, 'calendar group should start Google Calendar authorization');
assert.match(connectorPanelSource, /function fetchCalendarStatus/, 'connector panel should fetch calendar status');
assert.match(connectorPanelSource, /const \[feedResult, googleResult, ownerResult\] = await Promise\.all/, 'calendar status requests should run in parallel');
assert.match(connectorPanelSource, /await Promise\.all\(\[\s*fetchCalendarStatus\(\),\s*fetchGmailStatus\(\),\s*fetchDriveStatus\(\),\s*fetchGitHubStatus\(\),\s*fetchMailStatus\(\)/, 'connector status groups should load in parallel');
assert.match(connectorPanelSource, /function renderCalendarSection/, 'connector panel should render a calendar section');
assert.match(connectorPanelSource, /googleServicesTitle/, 'Google services should share one group heading');
assert.doesNotMatch(connectorPanelSource, /title\.textContent = i18n\("compose\.connectorPanel\.calendarTitle"/, 'calendar should not render a duplicate group heading');
assert.match(connectorPanelSource, /accountShort/, 'configured GitHub should use a compact account status row');
assert.match(connectorPanelSource, /mailInboxShort/, 'mail rows should use compact labels');
assert.match(connectorPanelSource, /appendConnectorListRow/, 'connector services should share one Material list-item renderer');
assert.doesNotMatch(connectorPanelSource, /isGoogleCompanion/, 'Gmail and Drive should not hide their status rows behind duplicate actions');
assert.match(connectorPanelSource, /function renderGoogleServiceSection[\s\S]*?if \(!status \|\| typeof status !== "object"\)/, 'Google service rows should render without a duplicate group heading');
assert.match(connectorPanelSource, /googleAccountTitle/, 'Google authorization should be attached to a named account row');
assert.match(connectorPanelSource, /function startCalendarAuthorization/, 'connector panel should start google authorization from the panel');
assert.match(connectorPanelSource, /function copyCalendarSubscriptionUrl/, 'connector panel should copy the subscribe link');
assert.match(connectorPanelSource, /composer-add-panel-action--text/, 'calendar subscription copy should use a borderless text action');
assert.match(connectorPanelSource, /compose\.connectorPanel\.calendarTitle/, 'the calendar section should use the i18n title');
assert.match(connectorPanelSource, /\/api\/connectors\/mail\/status/, 'mail group should fetch the mailbox status');
assert.match(connectorPanelSource, /function fetchMailStatus/, 'connector panel should fetch mail status');
assert.match(connectorPanelSource, /function renderMailSection/, 'connector panel should render a mail section');
assert.match(connectorPanelSource, /compose\.connectorPanel\.mailTitle/, 'the mail section should use the i18n title');
assert.doesNotMatch(connectorPanelSource, /mailSetupHint/, 'uninitialized mailboxes should not render a redundant setup hint');
assert.match(connectorPanelSource, /if \(!mailStatus\.initialized\)[\s\S]*?primary:\s*true[\s\S]*?return;/, 'uninitialized mailboxes should render only the setup action');
assert.match(connectorPanelSource, /composer-add-panel-disclosure/, 'developer connections should be collapsible');
assert.match(connectorPanelSource, /isBuiltInStatusSurface/, 'built-in status surfaces should not be duplicated as generic rows');
assert.match(connectorPanelSource, /composer-add-panel-action--primary/, 'important connector actions should have a clear primary treatment');

// --- 4f. backend connector router: read-only mail status endpoint ---
assert.match(connectorRoutesSource, /\/api\/connectors\/mail\/status/, 'connector router should expose the mail status route');
assert.match(connectorRoutesSource, /getMailboxStatus/, 'connector router should read the mailbox status from the mailbox module');
assert.match(connectorRoutesSource, /initialized: false/, 'uninitialized mailboxes should report a setup state instead of an error');

// --- 5. compose.js send path: carry the picker selection as per-run agentId ---
assert.match(composeSource, /const pickerAgentId =/, 'compose should read the agent picker selection when assembling the message');
assert.match(composeSource, /inlineAgentSelect\.value !== "__plan"/, 'plan mode must never be sent as an agent id');
assert.match(composeSource, /if \(pickerAgentId\) msg\.agentId = pickerAgentId;/, 'a picked agent should be carried as msg.agentId');

// --- 5. sidebar-ui menu-item handlers: open the inline panels, fallback to sidebar ---
const agentsHandler = sidebarSource.slice(sidebarSource.indexOf('composerAgentsMenuItem?.addEventListener'), sidebarSource.indexOf('composerConnectorsMenuItem?.addEventListener'));
assert.match(agentsHandler, /window\.RagentAgentPanel\?\.open/, 'Agents and apps item should open the inline agent panel');
assert.match(agentsHandler, /switchTab === "function"\) switchTab\("agents"\)/, 'Agents and apps item should keep the sidebar fallback');

const connectorsHandler = sidebarSource.slice(sidebarSource.indexOf('composerConnectorsMenuItem?.addEventListener'), sidebarSource.indexOf('composerPlanChip?.addEventListener'));
assert.match(connectorsHandler, /window\.RagentConnectorPanel\?\.open/, 'Connectors item should open the inline connector panel');
assert.match(connectorsHandler, /switchTab === "function"\) switchTab\("settings"\)/, 'Connectors item should keep the sidebar fallback');

// --- 6. CSS: panel surface mirrors the add-menu popover contract ---
function cssRuleBlock(stylesheet, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `expected ${selector} rule to exist`);
  return match[1];
}

const panelBlock = cssRuleBlock(inputCss, '.composer-add-panel');
assert.match(panelBlock, /position:\s*absolute;/, 'panel should be positioned like the add menu');
assert.match(panelBlock, /bottom:\s*calc\(100% \+ 10px\);/, 'panel should float above the composer');
assert.match(panelBlock, /var\(--surface-raised/, 'panel should use a stable raised surface');
assert.match(panelBlock, /var\(--shadow-floating/, 'panel should use the floating shadow');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel.is-open'), /composer-menu-rise-in|popover-in/, 'panel should animate in');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel.is-closing'), /composer-menu-sink-out|popover-out/, 'panel should animate out');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel[hidden]'), /display:\s*none !important;/, 'hidden panel should be fully hidden');
const rowBlock = cssRuleBlock(inputCss, '.composer-add-panel-row');
assert.match(rowBlock, /min-height:\s*44px;/, 'panel rows should meet the mobile touch target');
assert.match(rowBlock, /transition:/, 'panel rows should have restrained interaction feedback');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-check'), /visibility:\s*hidden;/, 'inactive agent rows should reserve a stable check slot');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-row--connector.is-actionable'), /18px/, 'actionable connector rows should reserve a chevron slot');
const pillReadyBlock = cssRuleBlock(inputCss, '.composer-add-panel-pill.is-ready');
assert.match(pillReadyBlock, /#0e6b40/, 'ready pill should carry a distinct, readable success tone');
const pillPendingBlock = cssRuleBlock(inputCss, '.composer-add-panel-pill');
assert.match(pillPendingBlock, /#7a4406/, 'pending pill should carry a distinct amber tone');

// --- 6b. CSS: in-panel authorize view ---
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-frame-wrap'), /height:\s*300px;/, 'the embed frame should have a bounded viewport height');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-frame'), /width:\s*100%;/, 'the embed iframe should fill its wrap');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-frame'), /height:\s*100%;/, 'the embed iframe should fill its wrap height');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-back'), /cursor:\s*pointer;/, 'the back button should be tappable');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-refresh'), /cursor:\s*pointer;/, 'the refresh button should be tappable');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-action'), /min-height:\s*44px;/, 'connector actions should meet the desktop hit target');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-disclosure'), /min-height:\s*44px;/, 'developer disclosure should be tappable');
assert.match(inputCss, /\.composer-add-panel-backdrop\s*\{[\s\S]*?display:\s*none;/, 'panel backdrop should be opt-in on desktop');
assert.match(responsiveCss, /\.composer-add-panel-backdrop\s*\{[\s\S]*?z-index:\s*200;/, 'mobile sheet should have a dedicated backdrop layer');
assert.match(responsiveCss, /\.composer-add-panel\s*\{[\s\S]*?position:\s*fixed !important;[\s\S]*?border-radius:\s*24px 24px 0 0;/, 'mobile panel should use a bottom-sheet geometry');
assert.match(responsiveCss, /\.composer-add-panel-list\s*\{[\s\S]*?touch-action:\s*pan-y;/, 'mobile panel list should own vertical touch scrolling');
assert.match(responsiveCss, /\.composer-add-panel-handle-zone\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?touch-action:\s*none;/, 'mobile panel handle should own its drag gesture');
assert.match(responsiveCss, /@keyframes composer-sheet-rise\s*\{[\s\S]*?translate3d\(0, 100%, 0\)[\s\S]*?translate3d\(0, 0, 0\)/, 'mobile sheet should animate upward when opening');
assert.match(responsiveCss, /@keyframes composer-sheet-dismiss\s*\{[\s\S]*?translate3d\(0, 0, 0\)[\s\S]*?translate3d\(0, 100%, 0\)/, 'mobile sheet should animate downward when closing');
assert.match(responsiveCss, /prefers-reduced-motion:\s*reduce[\s\S]*?composer-add-panel\.is-closing/, 'mobile sheet motion should honor reduced-motion');
assert.match(inputCss, /composer-add-panel--agent,[\s\S]*?--panel-radius-sheet:\s*28px;/, 'Agent sheet should use the compact One UI and Material You surface contract');
assert.match(inputCss, /composer-add-panel--connector[\s\S]*?--panel-row-active:/, 'Connector sheet should expose a semantic active surface token');
assert.match(inputCss, /composer-add-panel--agent \.composer-add-panel-row-detail,[\s\S]*?composer-add-panel--connector \.composer-add-panel-row-detail[\s\S]*?display:\s*none;/, 'legacy mobile detail rule should remain as a lower-priority fallback');
assert.match(sheetActionsCss, /#composerConnectorPanel \.composer-connector-list-item[\s\S]*?min-height:\s*68px;/, 'Connector rows should use a readable Material list-item height');
assert.doesNotMatch(sheetActionsCss, /#composerProviderPanel/, 'old Provider sheet styles should be removed');
assert.match(sheetActionsCss, /#composerConnectorPanel \.composer-connector-list-item \.composer-add-panel-row-detail[\s\S]*?display:\s*block !important;/, 'Connector supporting text should remain visible on mobile');
assert.match(inputCss, /composer-add-panel--connector \.composer-add-panel-action,[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*auto;/, 'Connector actions should use compact content-width buttons on mobile');
assert.match(m3ComponentsCss, /\.composer-add-panel--agent,\s*\.composer-add-panel--connector\s*\{[\s\S]*?linear-gradient\(112deg, rgba\(255, 255, 255, 0\.54\)/, 'mobile add panels should share the current composer material');
assert.doesNotMatch(m3ComponentsCss, /\.composer-add-panel--provider/, 'old Provider sheet material should be removed');
assert.match(m3ComponentsCss, /\.composer-add-menu-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 18px !important;/, 'add menu rows should keep only the title and selection columns');
assert.match(m3ComponentsCss, /\.composer-add-menu-note\s*\{[\s\S]*?display:\s*none !important;/, 'add menu explanatory notes should stay hidden');
assert.match(m3ComponentsCss, /\.composer-add-panel--agent \.composer-add-panel-row\.active,[\s\S]*?background:\s*var\(--color-action-container,\s*var\(--accent-dim\)\) !important;[\s\S]*?border:\s*0 !important;[\s\S]*?outline:\s*0 !important;[\s\S]*?box-shadow:\s*none !important;/, 'selected mobile panel rows should keep the shared color without a persistent outline');
assert.match(m3ComponentsCss, /\.composer-add-panel--agent \.composer-add-panel-row\.active:focus-visible,[\s\S]*?outline:\s*2px solid var\(--focus-border\) !important;/, 'selected mobile panel rows should restore a visible keyboard focus ring');

const mobilePanelListRule = responsiveCss.match(/@media\s*\(max-width:\s*767px\)[\s\S]*?\.composer-add-panel-list\s*\{([\s\S]*?)\}/);
assert.ok(mobilePanelListRule, 'mobile composer panel list rule should exist');
assert.match(mobilePanelListRule[1], /scrollbar-width:\s*none;/, 'mobile panel list should hide Firefox scrollbars');
assert.match(mobilePanelListRule[1], /-ms-overflow-style:\s*none;/, 'mobile panel list should hide legacy scrollbars');
assert.match(responsiveCss, /\.composer-add-panel-list::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none;/, 'mobile panel list should hide WebKit scrollbars');

// --- 6c. CSS: Codex MCP servers group ---
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-group-title'), /letter-spacing:\s*normal;/, 'group titles should use comfortable sentence-case typography');
assert.doesNotMatch(cssRuleBlock(inputCss, '.composer-add-panel-group-title'), /text-transform:\s*uppercase;/, 'group titles should not read like developer-only metadata');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-row-detail'), /text-overflow:\s*ellipsis;/, 'transport summaries should ellipsize');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-row-remove'), /var\(--error\)/, 'remove buttons should carry the error tone');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-row-remove'), /min-height:\s*44px;/, 'remove buttons should meet the mobile hit target');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-codex-input'), /border-radius:\s*10px;/, 'the add form inputs should match the panel radius');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-codex-error'), /var\(--error\)/, 'form errors should use the error tone');

// --- 6d. CSS: Claude Code MCP servers group ---
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-row--claude'), /grid-template-columns:\s*minmax\(0, 1fr\) auto;/, 'claude rows should mirror the codex row grid');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-claude-input'), /border-radius:\s*10px;/, 'claude add form inputs should match the panel radius');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-claude-error'), /var\(--error\)/, 'claude form errors should use the error tone');
assert.match(cssRuleBlock(inputCss, '.composer-add-panel-form-cancel'), /min-height:\s*44px;/, 'form cancellation should remain comfortable on touch');

console.log('test-chat-add-menu-panels: ok');
