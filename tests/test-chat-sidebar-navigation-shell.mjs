import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [template, sidebarCss, responsiveCss, glassCss, m3Components, sidebarJs, composeJs, iconsJs, sessionSurfaceJs] = await Promise.all([
  readFile(new URL('../templates/chat.html', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-glass.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/sidebar-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/compose.js', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/icons.js', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/session-surface-ui.js', import.meta.url), 'utf8'),
]);

const workspaceIndex = template.indexOf('id="workspacePicker"');
assert.ok(workspaceIndex >= 0);
// The nav Agent/Settings tabs were removed; the bottom-right pill and funnel
// button are the agents/settings entries.
assert.doesNotMatch(template, /id="tabAgents"/);
assert.doesNotMatch(template, /id="tabSettings"/);
assert.doesNotMatch(template, /id="sourceFilterSelect"/);
assert.doesNotMatch(template, /id="sidebarFilters"/);
assert.match(template, /class="sidebar-brand">Ragent</);
assert.match(template, /id="sidebarSearchBtn"[^>]*data-icon="search"/);
assert.match(template, /id="closeSidebar"[^>]*data-icon="close"/);
assert.match(template, /id="sidebarFilterBtn"[^>]*data-icon="gear-solid"/);
assert.match(template, /id="sidebarFilterBtn"[^>]*data-i18n-title="nav\.settings"/);
assert.match(template, /id="sidebarSubpageIcon"[^>]*data-icon="sparkle-solid"/);
assert.doesNotMatch(template, /id="sidebarFilterBtn"[^>]*aria-expanded/);
assert.match(template, /id="sidebarAgentBtn"[^>]*data-i18n-title="nav\.agents"/);
assert.match(template, /class="[^"]*sidebar-agent-btn[^"]*"[^>]*id="sidebarAgentBtn"/);
assert.match(template, /class="sidebar-agent-icon" data-icon="sparkle-solid"/);
assert.doesNotMatch(template, /id="sidebarAgentBtn"[\s\S]*data-i18n="nav\.agents"/);
assert.match(template, /class="[^"]*sidebar-new-chat-btn[^"]*"[^>]*id="newSessionBtn"/);
assert.match(template, /id="sidebarAccountPopover"[^>]*hidden/);
assert.match(template, /id="sidebarAccountBtn"[^>]*aria-controls="sidebarAccountPopover"/);
assert.match(template, /class="sidebar-account-indicator" aria-hidden="true"/);
assert.match(template, /id="sidebarAccountStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(template, /id="sidebarAccountDetail"/);
assert.match(template, /id="sidebarAccountAction"[^>]*hidden/);
assert.match(template, /id="sidebarAccountRetry"[^>]*hidden/);
assert.doesNotMatch(template, /id="tabAgents"[^>]*>[\s\S]*?sidebar-primary-action-icon[\s\S]*?<\/button>/);
assert.doesNotMatch(template, /id="workspaceSummaryButton"[^>]*>[\s\S]*?sidebar-primary-action-icon[\s\S]*?<\/button>/);

assert.match(sidebarCss, /\.sidebar-brand\s*\{[^}]*font-size:\s*28px;[^}]*font-weight:\s*700;/s);
assert.match(sidebarCss, /\.sidebar-primary-action\s*\{[^}]*min-height:\s*44px;[^}]*border:\s*0;/s);
assert.match(sidebarCss, /\.sidebar-bottom-frost\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/s);
assert.match(sidebarCss, /\.sidebar \.sidebar-new-chat-btn\s*\{[^}]*min-height:\s*52px;[^}]*height:\s*52px;[^}]*box-shadow:\s*none;/s);
assert.match(sidebarCss, /\.sidebar-agent-btn\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;[^}]*border-radius:\s*999px;/s);
assert.match(sidebarCss, /\.sidebar-filter-btn\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/s);
assert.match(sidebarCss, /\.sidebar-subpage-icon\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
assert.match(sidebarCss, /\.sidebar-account-popover\s*\{[^}]*width:\s*min\(320px,[^}]*border-radius:\s*28px;/s);
assert.match(sidebarCss, /\.sidebar-account-action\s*\{[^}]*min-height:\s*44px;[^}]*border-radius:\s*999px;/s);
assert.match(sidebarCss, /\.sidebar-subpage-panel-reveal\s*\{[^}]*animation:\s*sidebar-subpage-panel-reveal/);
assert.match(sidebarCss, /\.sidebar-subpage-panel-reveal[\s\S]*?filter:\s*blur\(3px\)/);
assert.match(sidebarCss, /\.sidebar-action-sheet-panel\.is-content-switching > \*/);
assert.match(sidebarCss, /@keyframes sidebar-action-sheet-panel-in/);
assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?sidebar-action-sheet-panel\.is-content-switching > \*/);
assert.match(sidebarCss, /@media \(max-width: 767px\)[\s\S]*?\.settings-panel\s*\{[^}]*background:\s*var\(--chat-area-bg\)/);
assert.match(responsiveCss, /@media \(max-width: 767px\)[\s\S]*?\.sidebar\s*\{[^}]*width:\s*100vw;/);
assert.match(responsiveCss, /\.sidebar-primary-action-chevron\s*\{[^}]*display:\s*none;/s);
assert.match(responsiveCss, /\.sidebar-primary-nav \.sidebar-workspace-popover\s*\{[^}]*border-radius:\s*30px 30px 0 0;/s);
assert.match(responsiveCss, /\.sidebar-primary-nav \.sidebar-workspace-confirm\s*\{[^}]*min-height:\s*52px;[^}]*border-radius:\s*24px;/s);
assert.doesNotMatch(responsiveCss, /sourceFilterSelect/);
assert.match(responsiveCss, /\.sidebar\[data-sidebar-mode="agents"\] \.sidebar-bottom-frost[\s\S]*?display:\s*none;/);
assert.match(responsiveCss, /\.sidebar\[data-sidebar-mode="agents"\] \.settings-panel#agentsPanel,[\s\S]*?background:\s*transparent;/);
assert.match(glassCss, /\.sidebar \.sidebar-primary-nav \.sidebar-workspace[\s\S]*?background:\s*transparent !important;/);
assert.match(glassCss, /\.sidebar \.sidebar-search-shell \.sidebar-search-input,[\s\S]*?box-shadow:\s*none !important;/);
assert.match(m3Components, /\.sidebar-account-popover\s*\{[\s\S]*?border-radius:\s*var\(--m3-shape-extra-large\) !important;[\s\S]*?box-shadow:\s*var\(--m3-elevation-3\) !important;[\s\S]*?backdrop-filter:\s*none !important;/);
assert.match(m3Components, /\.sidebar-account-action\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?border-radius:\s*var\(--mx-r-button-44\) !important;[\s\S]*?background:\s*var\(--sys-primary\);/);

assert.match(sidebarJs, /function setSidebarSearchMode\(/);
assert.match(sidebarJs, /function renderSidebarAgentSearchResults\(/);
assert.match(sidebarJs, /function closeSidebarTransientSurfaces\(/);
assert.match(sidebarJs, /async function requestSidebarAccountStatus\(/);
assert.match(sidebarJs, /\/api\/auth\/google\/status/);
assert.match(sidebarJs, /RagentCrossDevicePanel\?\.open\?\.\(\{ view: "account" \}\)/);
assert.match(sidebarJs, /function openSidebarSubpageWithSymbol\(/);
assert.match(sidebarJs, /sidebar-symbol-flight/);
assert.match(sidebarJs, /sidebar-subpage-panel-morph-pending/);
assert.match(sidebarJs, /sidebarSubpageIcon/);
assert.match(sessionSurfaceJs, /function bindSidebarLongPress\(/);
assert.match(sessionSurfaceJs, /window\.ragentOpenProjectActionSheet/);
assert.match(sessionSurfaceJs, /className = `sidebar-action-sheet-action/);
assert.match(sessionSurfaceJs, /button\.dataset\.action = action/);
assert.doesNotMatch(sessionSurfaceJs, /className = "session-context-menu"/);
assert.doesNotMatch(sessionSurfaceJs, /session-rename-input/);
// The funnel button is the Settings entry: it switches to the settings tab and
// the source-filter popover machinery is gone.
assert.match(sidebarJs, /sidebarFilterBtn\?\.addEventListener\("click"[\s\S]*?switchTab\("settings"\)/);
assert.doesNotMatch(sidebarJs, /function toggleSidebarFilterPopover/);
assert.doesNotMatch(sidebarJs, /sourceFilterSelect/);
// The Agent pill above the bottom-right controls opens the agents panel.
assert.match(sidebarJs, /sidebarAgentBtn\?\.addEventListener\("click"[\s\S]*?switchTab\("agents"\)/);
assert.match(sidebarJs, /sidebarSubpageCloseBtn\?\.addEventListener/);
assert.match(sidebarJs, /currentTab === "model-providers" \? "settings" : "sessions"/);
assert.match(sidebarJs, /sidebar\.subpage\.backToSettings/);
// Session-creation scope follows the browsed project: while L2 is open, the
// "selected" project/folder getters resolve to the project the user is inside
// (agents panel, managed apps, new-session shortcuts land in THAT project),
// falling back to the persisted selection everywhere else.
assert.match(sidebarJs, /window\.ragentGetSelectedProjectId[\s\S]*?ragentGetBrowsingProject\(\)[\s\S]*?return activeProjectId/);
assert.match(sidebarJs, /window\.ragentGetSelectedSessionFolder[\s\S]*?ragentGetBrowsingProject\(\)[\s\S]*?return getActiveProject\(\)\?\.rootPath/);
assert.match(composeJs, /syncSidebarShellState\(normalizedTab\)/);
assert.doesNotMatch(composeJs, /tabSettings/);
for (const iconName of ['search', 'filter', 'folder', 'agent', 'sparkle', 'new-chat', 'gear-solid', 'trash']) {
  assert.match(iconsJs, new RegExp(`["']?${iconName}["']?:\\s*'<`));
}
assert.match(iconsJs, /viewBox="0 0 24 24"/);
assert.match(iconsJs, /fill="none" stroke="currentColor"/);

console.log('test-chat-sidebar-navigation-shell: ok');
