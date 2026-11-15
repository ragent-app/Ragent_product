#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || '/tmp/ragent-sidebar-navigation-visual';
mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/custom-select.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const icons = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');

function fixtureHtml() {
  const sessionTimes = ['12:42', '11:08', 'Aug 4', '', '09:17', '', 'Aug 3', '', '08:54', '', 'Aug 2', '', '07:31', '', 'Aug 1', ''];
  const sessions = Array.from({ length: 16 }, (_, index) => `
    <button class="session-item${index === 1 ? ' active' : ''}" type="button">
      <span class="session-item-info"><span class="session-item-name">${index === 0 ? 'A very long session name that must remain inside the sidebar' : `Session ${index + 1}`}</span></span>
      ${sessionTimes[index]
        ? `<time class="session-item-time" datetime="2026-08-05T12:42:00.000Z">${sessionTimes[index]}</time>`
        : '<span class="session-item-time" aria-hidden="true"></span>'}
      <span class="session-item-status${index === 1 ? ' session-item-status--unread' : ''}" aria-hidden="true"></span>
    </button>`).join('');
  return `<!doctype html>
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style>
  <style>*{box-sizing:border-box}body{margin:0;background:#ddd;font-family:Inter,system-ui,sans-serif}.sidebar-overlay{opacity:1;visibility:visible;pointer-events:auto}.sidebar{transform:none}.settings-panel{display:none}.settings-panel.visible{display:block}.sidebar-workspace-popover,.custom-select-panel{animation:none!important;transition:none!important;transform:none!important}</style></head>
  <body><div class="sidebar-overlay open"><aside class="sidebar" id="sidebar" data-sidebar-mode="sessions">
    <div class="sidebar-app-bar" id="sidebarAppBar"><div class="sidebar-brand">Ragent</div><div class="sidebar-app-bar-actions"><button class="sidebar-icon-btn" aria-label="Search" data-icon="search"></button><button class="sidebar-icon-btn" aria-label="Back" data-icon="chevron-left"></button></div></div>
    <div class="sidebar-search-mode-header" id="sidebarSearchModeHeader" hidden><label class="sidebar-search-shell"><span class="sidebar-search-shell-icon" data-icon="search"></span><input class="sidebar-search-input" value="report" aria-label="Search"></label><button class="sidebar-icon-btn" aria-label="Close search" data-icon="close"></button></div>
    <div class="sidebar-subpage-header" id="sidebarSubpageHeader" hidden><button class="sidebar-icon-btn" aria-label="Back" data-icon="chevron-left"></button><span class="sidebar-subpage-icon" id="sidebarSubpageIcon" data-icon="sparkle-solid"></span><div class="sidebar-subpage-title" id="sidebarSubpageTitle">Agent</div></div>
    <nav class="sidebar-primary-nav" id="sidebarPrimaryNav"><div class="sidebar-workspace" id="workspacePicker"><button class="sidebar-workspace-summary sidebar-primary-action"><span class="sidebar-workspace-summary-text">Workspace: “Quarterly reporting workspace with a long name”</span><span class="sidebar-primary-action-chevron" data-icon="chevron-down"></span></button><div class="sidebar-workspace-popover" id="workspacePopover" hidden><div class="sidebar-section-title">Switch workspace</div><div class="custom-select-wrap"><button class="cs-trigger">Default workspace</button></div><button class="sidebar-workspace-confirm">Confirm</button></div></div></nav>
    <div class="sidebar-session-surface" id="sidebarSessionSurface"><div class="sidebar-search-results-heading sidebar-session-search-heading" hidden>Sessions</div><div class="sidebar-list">${sessions}</div><div class="sidebar-agent-search-results" hidden><div class="sidebar-search-results-heading">Agent</div><button class="sidebar-agent-search-result"><span class="sidebar-agent-search-result-icon" data-icon="agent"></span><span class="sidebar-agent-search-result-copy"><span class="sidebar-agent-search-result-name">Reporting Agent</span><span class="sidebar-agent-search-result-meta">codex</span></span></button></div></div>
    <div class="settings-panel" id="agentsPanel">
      <div class="settings-section">
        <div class="settings-app-header"><button class="settings-app-btn settings-app-btn-primary" id="createAgentBtn" type="button"><span class="settings-app-btn-icon" data-icon="plus"></span><span>Create Agent</span></button></div>
        <div class="settings-app-card">
          <div class="settings-app-card-header"><span class="settings-app-icon" data-icon="sparkle-solid"></span><div class="settings-app-name">Reporting Agent</div><div class="settings-app-kind">Custom</div></div>
          <div class="settings-app-actions"><button class="settings-app-btn settings-app-btn-primary" type="button">Open session</button><button class="settings-app-btn settings-app-btn-danger" type="button">Delete</button></div>
        </div>
        <div class="settings-app-card">
          <div class="settings-app-card-header"><span class="settings-app-icon" data-icon="sparkle-solid"></span><div class="settings-app-name">Monthly cleanup</div><div class="settings-app-kind">Custom</div></div>
          <div class="settings-app-actions"><button class="settings-app-btn settings-app-btn-primary" type="button">Open session</button><button class="settings-app-btn settings-app-btn-danger" type="button">Delete</button></div>
        </div>
      </div>
    </div>
    <div class="settings-panel" id="settingsPanel">
      <section class="settings-group">
        <div class="settings-group-heading"><span class="settings-group-icon" data-icon="gear"></span><h2 class="settings-group-title">Appearance &amp; display</h2></div>
        <div class="settings-group-card">
          <div class="settings-row"><span class="settings-row-copy"><span class="settings-row-title">Language</span><span class="settings-row-note">This browser only.</span></span><span class="settings-row-control"><div class="custom-select-wrap cs-settings-row"><button class="cs-trigger" type="button">English</button></div></span></div>
          <div class="settings-row"><span class="settings-row-copy"><span class="settings-row-title">Theme</span><span class="settings-row-note">Material 3 color presets apply in this browser.</span></span><span class="settings-row-control"><div class="custom-select-wrap cs-settings-row"><button class="cs-trigger" type="button">System</button></div></span></div>
        </div>
      </section>
      <section class="settings-group">
        <div class="settings-group-heading"><span class="settings-group-icon" data-icon="monitor"></span><h2 class="settings-group-title">App &amp; account</h2></div>
        <div class="settings-group-card">
          <div class="settings-row settings-row-action"><div class="settings-row-copy"><div class="settings-row-title">Install App</div><div class="settings-row-note">Install Ragent on this device.</div></div><button class="settings-row-button" type="button">Install Ragent</button></div>
          <div class="settings-row settings-row-action"><div class="settings-row-copy"><div class="settings-row-title">Password</div></div><button class="settings-row-button" type="button">Change password</button></div>
        </div>
      </section>
      <section class="settings-group">
        <div class="settings-group-heading"><span class="settings-group-icon" data-icon="share"></span><h2 class="settings-group-title">Connectivity</h2></div>
        <div class="settings-group-card">
          <div class="settings-row settings-row-expanded settings-row-connectivity"><span class="settings-row-copy"><span class="settings-row-title">Direct P2P connection</span><span class="settings-row-status">Not connected</span></span><span class="settings-row-control"><button class="settings-row-button settings-row-button-primary" type="button">Create pairing &amp; connect</button></span></div>
        </div>
      </section>
      <section class="settings-group">
        <div class="settings-group-heading"><span class="settings-group-icon" data-icon="terminal"></span><h2 class="settings-group-title">Runtime</h2></div>
        <div class="settings-group-note">Configuration switches apply immediately to future runs.</div>
        <div class="settings-group-card">
          <div class="settings-row settings-row-action"><span class="settings-row-copy"><span class="settings-row-title">Model providers</span></span><button class="settings-row-button settings-row-button-primary" id="modelProvidersOpenBtn" type="button">Open model providers</button></div>
        </div>
      </section>
    </div>
    <div class="sidebar-bottom-frost"></div><div class="sidebar-bottom-actions" id="sidebarBottomActions"><button class="new-session-btn sidebar-new-chat-btn"><span class="sidebar-new-chat-icon" data-icon="new-chat"></span><span>New project</span></button><button class="sidebar-agent-btn" aria-label="Agents"><span class="sidebar-agent-icon" data-icon="sparkle-solid"></span></button><button class="sidebar-filter-btn" aria-label="Settings" data-icon="gear-solid"></button><button class="sidebar-account-btn" id="sidebarAccountBtn" aria-label="Account &amp; cross-device sign-in"><span class="sidebar-account-avatar">A</span><span class="sidebar-account-indicator" aria-hidden="true"></span></button></div>
    <div class="sidebar-account-popover" id="sidebarAccountPopover" role="dialog" aria-labelledby="sidebarAccountTitle" hidden><div class="sidebar-account-title" id="sidebarAccountTitle">Account &amp; cross-device sign-in</div><div class="sidebar-account-status" id="sidebarAccountStatus" role="status" aria-live="polite"></div><div class="sidebar-account-detail" id="sidebarAccountDetail"></div><div class="sidebar-account-actions"><button class="sidebar-account-action" id="sidebarAccountAction" type="button" hidden></button><button class="sidebar-account-action sidebar-account-action--secondary" id="sidebarAccountRetry" type="button" hidden>Retry</button></div></div>
  </aside></div>
  <div class="sidebar-action-sheet" id="visualActionSheet" hidden>
    <div class="sidebar-action-sheet-backdrop" aria-hidden="true"></div>
    <section class="sidebar-action-sheet-panel" role="dialog" aria-modal="true">
      <div class="sidebar-action-sheet-header">
        <span class="sidebar-action-sheet-header-icon" data-icon="sidebar"></span>
        <div class="sidebar-action-sheet-title-block"><h2 class="sidebar-action-sheet-title">Session actions</h2><p class="sidebar-action-sheet-subtitle">Weekly report</p></div>
        <button class="sidebar-action-sheet-close" type="button" aria-label="Close" data-icon="close"></button>
      </div>
      <div class="sidebar-action-sheet-actions">
        <button class="sidebar-action-sheet-action" type="button"><span class="sidebar-action-sheet-action-icon" data-icon="pin"></span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Pin</span></span></button>
        <button class="sidebar-action-sheet-action" type="button"><span class="sidebar-action-sheet-action-icon" data-icon="edit"></span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Rename</span></span></button>
        <button class="sidebar-action-sheet-action is-danger" type="button"><span class="sidebar-action-sheet-action-icon" data-icon="trash"></span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Delete</span></span></button>
      </div>
    </section>
  </div>
  <script>${icons}\nwindow.RagentIcons.hydrate(document);</script></body></html>`;
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const browser = await chromium.launch({ headless: true });
try {
  const scenarios = [
    { name: 'mobile-home-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'sessions' },
    { name: 'mobile-project-sessions-light', viewport: { width: 360, height: 800 }, theme: 'light', mode: 'sessions-l2' },
    { name: 'mobile-search-dark', viewport: { width: 360, height: 800 }, theme: 'dark', mode: 'search' },
    { name: 'mobile-workspace-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'workspace' },
    { name: 'mobile-agent-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'agents' },
    { name: 'mobile-agent-narrow-light', viewport: { width: 360, height: 800 }, theme: 'light', mode: 'agents' },
    { name: 'mobile-settings-dark', viewport: { width: 390, height: 844 }, theme: 'dark', mode: 'settings' },
    { name: 'mobile-settings-light', viewport: { width: 430, height: 932 }, theme: 'light', mode: 'settings' },
    { name: 'desktop-agent-light', viewport: { width: 1440, height: 900 }, theme: 'light', mode: 'agents' },
    { name: 'desktop-settings-light', viewport: { width: 1440, height: 900 }, theme: 'light', mode: 'settings' },
    { name: 'mobile-session-actions-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'session-actions' },
    { name: 'mobile-session-delete-confirm-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'session-delete-confirm' },
    { name: 'mobile-session-rename-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'session-rename' },
    { name: 'mobile-project-delete-dark', viewport: { width: 390, height: 844 }, theme: 'dark', mode: 'project-delete' },
    { name: 'mobile-account-pending-light', viewport: { width: 390, height: 844 }, theme: 'light', mode: 'account-pending' },
    { name: 'mobile-account-ready-dark', viewport: { width: 390, height: 844 }, theme: 'dark', mode: 'account-ready' },
  ];
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: scenario.viewport, colorScheme: scenario.theme });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.evaluate((mode) => {
      const sidebar = document.getElementById('sidebar');
      sidebar.dataset.sidebarMode = mode;
      const search = mode === 'search';
      const agents = mode === 'agents';
      const settings = mode === 'settings';
      const subpage = agents || settings;
      const workspace = mode === 'workspace';
      const accountState = mode === 'account-pending' ? 'pending' : mode === 'account-ready' ? 'ready' : '';
      const actionSheet = document.getElementById('visualActionSheet');
      const accountPopover = document.getElementById('sidebarAccountPopover');
      const accountButton = document.getElementById('sidebarAccountBtn');
      document.getElementById('sidebarAppBar').hidden = search || subpage;
      document.getElementById('sidebarSearchModeHeader').hidden = !search;
      document.getElementById('sidebarSubpageHeader').hidden = !subpage;
      document.getElementById('sidebarSubpageTitle').textContent = settings ? 'Settings' : 'Agent';
      const subpageIcon = document.getElementById('sidebarSubpageIcon');
      subpageIcon.setAttribute('data-icon', settings ? 'gear-solid' : 'sparkle-solid');
      subpageIcon.innerHTML = window.RagentIcons.render(settings ? 'gear-solid' : 'sparkle-solid');
      document.getElementById('sidebarPrimaryNav').hidden = search || subpage;
      document.getElementById('sidebarSessionSurface').hidden = subpage;
      document.getElementById('sidebarBottomActions').hidden = search || subpage;
      document.querySelector('.sidebar-filter-btn').hidden = search || subpage;
      // The production project overview is L1: the Agent shortcut only joins
      // the bottom row while a project's L2 session list is open.
      const sessionsL2 = mode === 'sessions-l2';
      document.querySelector('.sidebar-agent-btn').hidden = !sessionsL2;
      if (sessionsL2) {
        document.querySelector('.sidebar-new-chat-btn span:last-child').textContent = 'New chat';
      }
      document.getElementById('workspacePicker').classList.toggle('is-expanded', workspace);
      document.getElementById('workspacePopover').hidden = !workspace;
      document.getElementById('agentsPanel').classList.toggle('visible', agents);
      document.getElementById('settingsPanel').classList.toggle('visible', settings);
      accountPopover.hidden = !accountState;
      accountButton.dataset.accountState = accountState;
      document.getElementById('sidebarAccountStatus').textContent = accountState === 'pending'
        ? 'Google sign-in is ready to bind'
        : accountState === 'ready' ? 'Google cross-device sign-in is enabled' : '';
      document.getElementById('sidebarAccountDetail').textContent = accountState === 'pending'
        ? 'Bind a Google account once to sign in as the owner from other devices.'
        : accountState === 'ready' ? 'This Google account can sign in as the owner from other devices.' : '';
      const accountAction = document.getElementById('sidebarAccountAction');
      accountAction.hidden = !accountState;
      accountAction.dataset.tone = accountState === 'pending' ? 'primary' : 'secondary';
      accountAction.textContent = accountState === 'pending' ? 'Bind Google account' : 'Manage cross-device login';
      const sessionHeading = document.querySelector('.sidebar-session-search-heading');
      const agentResults = document.querySelector('.sidebar-agent-search-results');
      sessionHeading.hidden = !search;
      agentResults.hidden = !search;
      actionSheet.hidden = !['session-actions', 'session-delete-confirm', 'session-rename', 'project-delete'].includes(mode);
      if (actionSheet.hidden) return;
      const panel = actionSheet.querySelector('.sidebar-action-sheet-panel');
      const icon = mode === 'project-delete' ? 'folder-solid' : 'sidebar';
      const title = mode === 'project-delete'
        ? 'Delete project'
        : mode === 'session-delete-confirm'
          ? 'Delete session?'
          : mode === 'session-rename' ? 'Rename' : 'Session actions';
      const subtitle = mode === 'project-delete' ? 'Quarterly reporting' : 'Weekly report';
      panel.innerHTML = `
        <div class="sidebar-action-sheet-header">
          <span class="sidebar-action-sheet-header-icon">${window.RagentIcons.render(icon)}</span>
          <div class="sidebar-action-sheet-title-block"><h2 class="sidebar-action-sheet-title">${title}</h2><p class="sidebar-action-sheet-subtitle">${subtitle}</p></div>
          <button class="sidebar-action-sheet-close" type="button" aria-label="Close">${window.RagentIcons.render('close')}</button>
        </div>`;
      if (mode === 'session-rename') {
        panel.insertAdjacentHTML('beforeend', `
          <form class="sidebar-action-sheet-rename-form">
            <label class="sidebar-action-sheet-field-label">Session name</label>
            <input class="sidebar-action-sheet-name-input" value="Weekly report" aria-label="Session name">
            <div class="sidebar-action-sheet-form-actions"><button class="sidebar-action-sheet-secondary" type="button">Cancel</button><button class="sidebar-action-sheet-primary" type="submit">Save</button></div>
          </form>`);
      } else if (mode === 'session-delete-confirm') {
        panel.insertAdjacentHTML('beforeend', `
          <p class="sidebar-action-sheet-confirm-copy">This permanently deletes the session and its run history.</p>
          <div class="sidebar-action-sheet-actions">
            <button class="sidebar-action-sheet-action is-danger" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('trash')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Delete</span></span></button>
          </div>`);
      } else if (mode === 'project-delete') {
        panel.insertAdjacentHTML('beforeend', `
          <p class="sidebar-action-sheet-confirm-copy">This project contains 6 sessions. Choose what happens next.</p>
          <div class="sidebar-action-sheet-actions">
            <button class="sidebar-action-sheet-action is-danger" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('trash')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Delete project and all sessions</span><span class="sidebar-action-sheet-action-hint">Permanently removes the project and its sessions.</span></span></button>
            <button class="sidebar-action-sheet-action" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('archive')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Delete project, keep sessions</span><span class="sidebar-action-sheet-action-hint">Move sessions to the Inbox at the bottom.</span></span></button>
          </div>`);
      } else {
        panel.insertAdjacentHTML('beforeend', `
          <div class="sidebar-action-sheet-actions">
            <button class="sidebar-action-sheet-action" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('pin')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Pin</span></span></button>
            <button class="sidebar-action-sheet-action" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('edit')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Rename</span></span></button>
            <button class="sidebar-action-sheet-action is-danger" type="button"><span class="sidebar-action-sheet-action-icon">${window.RagentIcons.render('trash')}</span><span class="sidebar-action-sheet-action-copy"><span class="sidebar-action-sheet-action-label">Delete</span></span></button>
          </div>`);
      }
      actionSheet.classList.add('is-open');
    }, scenario.mode);
    if (['session-actions', 'session-delete-confirm', 'session-rename', 'project-delete'].includes(scenario.mode)) {
      // Let the bottom sheet settle before capturing the visual evidence; the
      // interaction test separately covers the opening behavior itself.
      await page.waitForTimeout(320);
    }
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });
    const metrics = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect?.() || null;
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        bodyScrollWidth: document.documentElement.scrollWidth,
        sidebar: rect('.sidebar'),
        brand: rect('.sidebar-brand'),
        actions: rect('.sidebar-app-bar-actions'),
        workspace: rect('#workspacePicker'),
        filter: rect('.sidebar-filter-btn'),
        agentPill: rect('.sidebar-agent-btn'),
        list: rect('.sidebar-list'),
        sheetPanel: rect('.sidebar-action-sheet-panel'),
        bottom: rect('.sidebar-bottom-actions'),
        newChat: rect('.sidebar-new-chat-btn'),
        newChatRadius: getComputedStyle(document.querySelector('.sidebar-new-chat-btn')).borderRadius,
        activeSessionRadius: getComputedStyle(document.querySelector('.session-item.active')).borderRadius,
        account: rect('.sidebar-account-btn'),
        accountPopover: rect('#sidebarAccountPopover'),
        accountAction: rect('#sidebarAccountAction'),
        accountPopoverRadius: getComputedStyle(document.querySelector('#sidebarAccountPopover')).borderTopLeftRadius,
        accountActionRadius: getComputedStyle(document.querySelector('#sidebarAccountAction')).borderRadius,
        searchHeader: rect('.sidebar-search-mode-header'),
        subpageHeader: rect('.sidebar-subpage-header'),
        subpageIcon: rect('.sidebar-subpage-icon'),
        agentsPanel: rect('#agentsPanel'),
        settingsPanel: rect('#settingsPanel'),
        workspacePopover: rect('#workspacePopover'),
        workspaceConfirm: rect('.sidebar-workspace-confirm'),
        frost: rect('.sidebar-bottom-frost'),
        chevronDisplay: getComputedStyle(document.querySelector('.sidebar-primary-action-chevron')).display,
        workspaceRadius: getComputedStyle(document.querySelector('#workspacePopover')).borderTopLeftRadius,
        sidebarBackground: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
        agentsPanelBackground: getComputedStyle(document.querySelector('#agentsPanel')).backgroundColor,
        settingsPanelBackground: getComputedStyle(document.querySelector('#settingsPanel')).backgroundColor,
        activeSessionBorder: getComputedStyle(document.querySelector('.session-item.active')).borderWidth,
        activeSessionShadow: getComputedStyle(document.querySelector('.session-item.active')).boxShadow,
        settingsGroupBorder: getComputedStyle(document.querySelector('.settings-group-card')).borderWidth,
        settingsGroupBackground: getComputedStyle(document.querySelector('.settings-group-card')).backgroundColor,
        settingsGroupRadius: getComputedStyle(document.querySelector('.settings-group-card')).borderTopLeftRadius,
        settingsGroupCount: document.querySelectorAll('#settingsPanel .settings-group').length,
        settingsHeadingCount: document.querySelectorAll('#settingsPanel .settings-group-heading').length,
        settingsPrimaryHeight: rect('#settingsPanel .settings-row-button-primary')?.height || 0,
        settingsControlBorder: getComputedStyle(document.querySelector('.settings-row .cs-trigger')).borderWidth,
        searchInputBorderWidth: getComputedStyle(document.querySelector('.sidebar-search-input')).borderWidth,
        searchInputBoxShadow: getComputedStyle(document.querySelector('.sidebar-search-input')).boxShadow,
        chatAreaBackground: (() => {
          const probe = document.createElement('div');
          probe.style.background = 'var(--chat-area-bg)';
          document.body.append(probe);
          const background = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return background;
        })(),
      };
    });
    assert.ok(metrics.bodyScrollWidth <= metrics.viewportWidth + 1, `${scenario.name}: no horizontal overflow`);
    assert.ok(metrics.sidebar.height <= metrics.viewportHeight + 1, `${scenario.name}: sidebar stays inside viewport`);
      if (scenario.mode === 'sessions' || scenario.mode === 'sessions-l2') {
      assert.ok(!overlaps(metrics.brand, metrics.actions), 'brand must not overlap app bar actions');
      assert.ok(metrics.filter.right <= metrics.account.left + 1, 'filter should sit immediately left of the account button');
      assert.ok(!overlaps(metrics.newChat, metrics.account), 'bottom actions must not overlap');
      assert.equal(metrics.newChat.height, 52, 'primary project/session control should be 52px tall');
      if (scenario.viewport.width <= 767) {
        assert.ok(Math.abs(parseFloat(metrics.newChatRadius) - (52 * 0.5)) < 0.5, 'mobile primary project/session control should use the capsule ratio');
        assert.ok(Math.abs(parseFloat(metrics.activeSessionRadius) - (52 * 0.5)) < 0.5, 'mobile selected session should use the capsule ratio');
      }
      assert.equal(metrics.filter.height, 48, 'Settings control should be 48px tall');
        assert.equal(metrics.account.height, 48, 'Account control should be 48px tall');
        assert.equal(metrics.activeSessionBorder, '0px', 'selected session should not draw an outline');
        assert.equal(metrics.activeSessionShadow, 'none', 'selected session should use surface state instead of shadow');
      if (scenario.viewport.width <= 767) {
        if (scenario.mode === 'sessions-l2') {
          assert.equal(metrics.newChat.width, 136, 'L2 primary action should make room for the Agent control');
          assert.equal(metrics.agentPill.height, 48, 'L2 Agent control should be 48px tall');
          assert.ok(!overlaps(metrics.agentPill, metrics.newChat), 'L2 Agent action must not overlap the new-chat button');
          assert.ok(!overlaps(metrics.agentPill, metrics.filter), 'L2 Agent action must not overlap the Settings button');
          assert.ok(!overlaps(metrics.agentPill, metrics.account), 'L2 Agent action must not overlap the account button');
      } else {
          assert.equal(metrics.agentPill.height, 0, 'L1 Agent control stays out of the bottom row');
          assert.equal(metrics.newChat.width, 160, 'L1 primary action should keep a substantial label width');
        }
      }
      if (scenario.mode === 'sessions-l2') {
        assert.ok(
          metrics.agentPill.right <= metrics.filter.left + 1
            && metrics.agentPill.top >= metrics.bottom.top - 1,
          'L2 Agent action should sit in the same bottom row before Settings',
        );
      }
      assert.ok(metrics.bottom.bottom <= metrics.viewportHeight + 1, 'bottom actions remain viewport-safe');
      if (scenario.viewport.width <= 767) assert.equal(metrics.chevronDisplay, 'none', 'mobile workspace chevron should hide');
    } else if (scenario.mode === 'search') {
      assert.ok(metrics.searchHeader.height >= 72, 'search header remains touch-friendly');
      assert.equal(metrics.bottom.height, 0, 'bottom actions hide during search');
      assert.equal(metrics.searchInputBorderWidth, '0px', 'search input should not draw its own border');
      assert.equal(metrics.searchInputBoxShadow, 'none', 'search input should not draw an inset frame');
      assert.equal(metrics.frost.height, 0, 'search mode should not keep the bottom frost on any viewport');
    } else if (scenario.mode === 'workspace') {
      assert.ok(metrics.workspacePopover.bottom >= metrics.viewportHeight - 1, 'workspace sheet should reach the viewport bottom');
      assert.ok(metrics.workspacePopover.height > 0 && metrics.workspacePopover.top < metrics.viewportHeight, 'workspace sheet should be visible inside the viewport');
      assert.equal(metrics.workspaceRadius, '30px', 'workspace sheet should use a large top radius');
      assert.ok(metrics.workspaceConfirm.height >= 51.5, 'workspace confirm should be thumb-friendly');
      assert.equal(metrics.chevronDisplay, 'none', 'mobile workspace chevron should hide');
    } else if (['session-actions', 'session-delete-confirm', 'session-rename', 'project-delete'].includes(scenario.mode)) {
      assert.ok(metrics.sheetPanel.width >= scenario.viewport.width - 1, `${scenario.name}: sheet should span the mobile viewport`);
      assert.ok(metrics.sheetPanel.bottom >= metrics.viewportHeight - 1, `${scenario.name}: sheet should reach the safe bottom edge`);
      assert.ok(metrics.sheetPanel.top < metrics.viewportHeight, `${scenario.name}: sheet should be visible`);
      const actionButtons = await page.locator('.sidebar-action-sheet-action').count();
      if (scenario.mode === 'session-actions') {
        assert.equal(actionButtons, 3, 'session sheet should show three actions');
        const deleteAction = page.locator('.sidebar-action-sheet-action.is-danger');
        assert.equal(await deleteAction.count(), 1, 'session sheet should expose one direct delete action');
        assert.match(await deleteAction.innerText(), /^Delete$/, 'session sheet should label the danger action as Delete');
      }
      if (scenario.mode === 'session-delete-confirm') {
        assert.equal(actionButtons, 1, 'session confirmation should expose one explicit destructive action');
        assert.match(await page.locator('.sidebar-action-sheet-panel').innerText(), /permanently deletes/,
          'session confirmation should state the permanent consequence');
        const deleteAction = await page.locator('.sidebar-action-sheet-action.is-danger').boundingBox();
        assert.ok(deleteAction?.y >= 0 && deleteAction.y + deleteAction.height <= scenario.viewport.height,
          'session confirmation action should remain fully visible in the mobile viewport');
      }
      if (scenario.mode === 'session-rename') assert.equal(await page.locator('.sidebar-action-sheet-name-input').count(), 1, 'rename sheet should expose one field');
      if (scenario.mode === 'project-delete') {
        assert.equal(actionButtons, 2, 'delete sheet should show two session policies');
        assert.doesNotMatch(await page.locator('.sidebar-action-sheet-panel').innerText(), /\bL1\b/, 'delete sheet should not expose internal level names');
      }
    } else if (['account-pending', 'account-ready'].includes(scenario.mode)) {
      assert.ok(metrics.accountPopover.width > 0 && metrics.accountPopover.width <= metrics.viewportWidth - 31, `${scenario.name}: account surface stays inside the viewport`);
      assert.ok(metrics.accountPopover.bottom <= metrics.bottom.top - 8, `${scenario.name}: account surface clears the bottom action row`);
      assert.equal(metrics.accountPopoverRadius, '28px', `${scenario.name}: account surface uses the MD3 temporary-surface radius`);
      assert.ok(metrics.accountAction.height >= 44, `${scenario.name}: account action remains touch-friendly`);
      assert.equal(metrics.accountActionRadius, '22px', `${scenario.name}: account action uses the shared half-height button radius`);
      assert.equal(await page.locator('#sidebarAccountRetry').isVisible(), false, `${scenario.name}: healthy account states do not show a redundant retry action`);
      if (scenario.mode === 'account-pending') {
        assert.match(await page.locator('#sidebarAccountPopover').innerText(), /ready to bind/i, 'pending state clearly states that binding is the next step');
        assert.equal(await page.locator('#sidebarAccountBtn').getAttribute('data-account-state'), 'pending');
      } else {
        assert.match(await page.locator('#sidebarAccountPopover').innerText(), /enabled/i, 'ready state confirms cross-device sign-in availability');
        assert.equal(await page.locator('#sidebarAccountBtn').getAttribute('data-account-state'), 'ready');
      }
    } else {
      const panelTop = scenario.mode === 'settings'
        ? metrics.settingsPanel.top
        : metrics.agentsPanel.top;
      assert.ok(metrics.subpageHeader.height >= 72, 'subpage header remains touch-friendly');
      assert.ok(metrics.subpageIcon.width >= 20 && metrics.subpageIcon.height >= 20, 'subpage should expose its semantic symbol');
      assert.ok(panelTop >= metrics.subpageHeader.bottom - 1, 'subpage content starts below its header');
      const panelText = await page.locator(scenario.mode === 'agents' ? '#agentsPanel' : '#settingsPanel').innerText();
        assert.doesNotMatch(panelText, /Create and reuse agents|Reusable agent you created|Default tool\s*[·:]/, `${scenario.name}: noisy helper copy should be absent`);
        if (scenario.mode === 'settings') {
          assert.equal(metrics.settingsGroupBorder, '0px', 'settings groups should not become nested outlined cards');
          assert.equal(metrics.settingsControlBorder, '0px', 'settings controls should stay borderless like L1/L2 controls');
          assert.notEqual(metrics.settingsGroupBackground, 'rgba(0, 0, 0, 0)', 'settings groups should expose a tonal surface');
          assert.equal(metrics.settingsGroupRadius, '20px', 'settings groups should use one large MD3 surface radius');
          assert.equal(metrics.settingsGroupCount, 4, 'settings should expose four non-duplicated functional groups');
          assert.equal(metrics.settingsHeadingCount, 4, 'each settings group should have one heading');
          assert.ok(metrics.settingsPrimaryHeight >= 51.5, 'primary settings actions should keep a prominent touch target');
        }
      if (scenario.viewport.width <= 767) {
        const activePanelBackground = scenario.mode === 'settings'
          ? metrics.settingsPanelBackground
          : metrics.agentsPanelBackground;
        if (scenario.mode === 'settings') {
          assert.notEqual(activePanelBackground, 'rgba(0, 0, 0, 0)', `${scenario.name}: settings should expose a readable surface`);
        } else {
          assert.ok(
            activePanelBackground === 'rgba(0, 0, 0, 0)'
              || activePanelBackground === metrics.sidebarBackground,
            `${scenario.name}: agent panel should inherit the sidebar surface color`,
          );
        }
      }
      if (scenario.viewport.width <= 767) assert.equal(metrics.frost.height, 0, 'mobile subpages should not keep the bottom frost');
      assert.equal(metrics.frost.height, 0, 'subpages should not keep the bottom frost on any viewport');
    }
    await page.close();
  }
  console.log(`test-chat-sidebar-navigation-visual: ok (${outputDir})`);
} finally {
  await browser.close();
}
