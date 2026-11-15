#!/usr/bin/env node
// Browser-level regression tests for the sidebar reopen level.
// Collapsing the sidebar while browsing a project at level two and reopening
// it used to reset to the project overview (L1): openSessionsSidebar called
// backToProjects unconditionally ("always lands on the project overview
// first"). The two-level state survives the collapse untouched, so reopening
// must land back on the project's session list. These tests drive the real
// sidebar-ui.js / project-view-ui.js / project-overview.js on both the
// mobile drawer path (isDesktop=false) and the desktop collapse path.
import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const readAsset = (name) => readFileSync(join(repoRoot, 'static', 'chat', name), 'utf8');
const baseCss = readAsset('chat-base.css');
const sidebarCss = readAsset('chat-sidebar.css');
const sidebarSource = readAsset('sidebar-ui.js');
const overviewSource = readAsset('project-overview.js');
const viewSource = readAsset('project-view-ui.js');

const SHELL = `
  <style>${baseCss}${sidebarCss}</style>
  <div class="sidebar" id="sidebar"></div>
  <div class="sidebar-appbar" id="sidebarAppBar"></div>
  <div class="sidebar-search-mode-header" id="sidebarSearchModeHeader" hidden></div>
  <div class="sidebar-subpage-header" id="sidebarSubpageHeader" hidden>
    <div class="sidebar-subpage-title" id="sidebarSubpageTitle"></div>
    <button class="sidebar-icon-btn" id="sidebarSubpageCloseBtn" type="button"></button>
  </div>
  <nav class="sidebar-primary-nav" id="sidebarPrimaryNav"></nav>
  <div class="sidebar-session-surface" id="sidebarSessionSurface">
    <div class="sidebar-search-results-heading" id="sidebarSessionSearchHeading" hidden>Sessions</div>
    <div class="sidebar-projects-view" id="projectsView" hidden></div>
    <div class="sidebar-list" id="sessionList"></div>
    <div class="sidebar-agent-search-results" id="sidebarAgentSearchResults" hidden></div>
  </div>
  <div class="sidebar-project-header" id="sidebarProjectHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button" title="Back" aria-label="Back"></button>
    <span class="sidebar-project-header-icon" data-icon="folder-solid" aria-hidden="true"></span>
    <span class="sidebar-project-header-title" id="sidebarProjectTitle"></span>
  </div>
  <div class="sidebar-bottom-actions" id="sidebarBottomActions"></div>
  <div class="sidebar-search-shell">
    <input class="sidebar-search-input" id="sessionSearchInput" type="search" />
    <button type="button" id="sidebarSearchBtn">Search</button>
    <button type="button" id="sidebarSearchCloseBtn">Close</button>
  </div>
  <button class="sidebar-icon-btn" id="menuBtn" type="button">Menu</button>
  <button class="sidebar-icon-btn" id="closeSidebar" type="button">Close</button>
  <div class="sidebar-overlay" id="sidebarOverlay"></div>
  <div class="sidebar-account-popover" id="sidebarAccountPopover" role="dialog" aria-labelledby="sidebarAccountTitle" hidden>
    <div class="sidebar-account-title" id="sidebarAccountTitle">Account &amp; cross-device sign-in</div>
    <div class="sidebar-account-status" id="sidebarAccountStatus" role="status" aria-live="polite"></div>
    <div class="sidebar-account-detail" id="sidebarAccountDetail"></div>
    <div class="sidebar-account-actions">
      <button class="sidebar-account-action" id="sidebarAccountAction" type="button" hidden></button>
      <button class="sidebar-account-action sidebar-account-action--secondary" id="sidebarAccountRetry" type="button" hidden>Retry</button>
    </div>
  </div>
  <button class="sidebar-account-btn" id="sidebarAccountBtn2" type="button" aria-expanded="false"><span class="sidebar-account-avatar">A</span><span class="sidebar-account-indicator" aria-hidden="true"></span></button>
  <button class="new-session-btn" id="newSessionBtn" type="button"><span class="sidebar-new-chat-icon"></span><span>New</span></button>
  <button class="sidebar-icon-btn" id="sidebarAccountBtn" type="button">Account</button>
  <button class="sidebar-icon-btn" id="sidebarFilterBtn" type="button">Filter</button>
  <button class="sidebar-agent-btn" id="sidebarAgentBtn" type="button">Agents</button>
  <button type="button" id="sortSessionListBtn">Sort</button>
  <div class="settings-panel" id="settingsPanel"></div>
  <div class="settings-panel" id="agentsPanel"></div>
  <div class="composer-input-area" id="inputArea"></div>
  <textarea id="msgInput"></textarea>
  <button type="button" id="imgBtn">Image</button>
  <input type="file" id="imgFileInput" />
  <div id="imgPreviewStrip"></div>
  <div id="workspacePicker"></div>
  <div id="workspacePopover" hidden></div>
  <button id="workspaceSummaryButton" type="button"></button>
  <span id="workspaceSummaryText"></span>
  <button id="emptyOpenSessionBtn" type="button"></button>
  <button id="emptyCreateAgentBtn" type="button"></button>
  <div id="projectList"></div>
  <button id="projectCreateButton" type="button"></button>
  <select id="workspaceSelect"></select>
  <select id="workspaceBrowserSelect"></select>
  <select id="workspaceCustomFolderSelect"></select>
  <select id="inlineAgentSelect"></select>
  <div id="composerAddMenu"></div>
  <button id="composerAttachFilesBtn" type="button"></button>
  <div id="composerPlanMenuItem"></div>
  <div id="composerAgentsMenuItem"></div>
  <div id="composerConnectorsMenuItem"></div>
  <div id="composerPlanChip"></div>
`;

const PROVIDER_SETUP = `
  const menuBtn = document.getElementById("menuBtn");
  const closeSidebar = document.getElementById("closeSidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const sidebarAccountPopover = document.getElementById("sidebarAccountPopover");
  const sidebarAccountBtn = document.getElementById("sidebarAccountBtn2");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const imgBtn = document.getElementById("imgBtn");
  const imgFileInput = document.getElementById("imgFileInput");
  const imgPreviewStrip = document.getElementById("imgPreviewStrip");
  const inputArea = document.getElementById("inputArea");
  const msgInput = document.getElementById("msgInput");
  const composerAddMenu = document.getElementById("composerAddMenu");
  const composerAttachFilesBtn = document.getElementById("composerAttachFilesBtn");
  const composerPlanMenuItem = document.getElementById("composerPlanMenuItem");
  const composerAgentsMenuItem = document.getElementById("composerAgentsMenuItem");
  const composerConnectorsMenuItem = document.getElementById("composerConnectorsMenuItem");
  const composerPlanChip = document.getElementById("composerPlanChip");
`;

const SESSIONS = [
  { id: 's1', projectId: 'p1', name: 'first', lastEventAt: '2026-08-05T09:00:00Z', activity: { run: { state: 'idle' } } },
  { id: 's2', projectId: 'p1', name: 'second', lastEventAt: '2026-08-05T08:00:00Z', activity: { run: { state: 'idle' } } },
];

function stubSetup(isDesktop) {
  return `
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: function () { return null; },
      setItem: function () {},
    },
  });
  window.ragentT = function (key) { return key; };
  window.renderUiIcon = function () { return ""; };
  window.isDesktop = ${isDesktop};
  window.switchTab = function () {};
  // The real sidebar-ui.js fetches the project catalog at load and publishes
  // its own ragentProjectsReady, which project-view-ui.js awaits before
  // rendering the L1 rows — so the stub must succeed with a real project.
  window.fetch = async function (url) {
    if (String(url).includes("/api/projects")) {
      return {
        ok: true,
        json: async () => ({ projects: [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }] }),
      };
    }
    if (String(url).includes("/api/auth/google/status")) {
      if (window.__googleAccountStatus === "error") {
        return { ok: false, json: async () => ({ error: "offline" }) };
      }
      return {
        ok: true,
        json: async () => window.__googleAccountStatus || { enabled: true, bound: false },
      };
    }
    return { ok: false, json: async () => ({}) };
  };
  window.RagentCrossDevicePanel = {
    open: function (options) {
      window.__openedCrossDeviceView = options?.view || "";
      window.__crossDeviceTriggerId = document.activeElement?.id || "";
      return true;
    },
  };
  window.fetchSessionsList = async function () { return []; };
  window.ragentGetProjects = function () {
    return [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }];
  };
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = function () { return "sessions"; };
  window.sessionSearchQuery = "";
  window.getFilteredActiveSessions = function () {
    return ${JSON.stringify(SESSIONS)};
  };
  window.createActiveSessionItem = function (session) {
    const item = document.createElement("div");
    item.className = "session-item";
    const name = document.createElement("span");
    name.className = "session-item-name";
    name.textContent = session.name;
    item.appendChild(name);
    return item;
  };
  window.matchesSearchQuery = function () { return false; };
  window.createNewSessionShortcut = function () { return false; };
  window.sidebarSessionSearchHeading = document.getElementById("sidebarSessionSearchHeading");
  window.sidebarAgentSearchResults = document.getElementById("sidebarAgentSearchResults");
  window.sessionSearchInput = document.getElementById("sessionSearchInput");
  window.newSessionBtn = document.getElementById("newSessionBtn");
  window.sidebarAgentBtn = document.getElementById("sidebarAgentBtn");
  window.sessionList = document.getElementById("sessionList");
`;
}

const SETTLE_MS = 900;

function levelSnapshot(page) {
  return page.evaluate(() => ({
    level: window.RagentProjectView.getSidebarViewLevel(),
    headerHidden: document.getElementById("sidebarProjectHeader").hidden,
    headerTitle: document.getElementById("sidebarProjectTitle").textContent,
    projectsHidden: document.getElementById("projectsView").hidden,
    listHidden: document.getElementById("sessionList").hidden,
    listRows: Array.from(document.querySelectorAll("#sessionList .session-item-name")).map((el) => el.textContent),
    overlayOpen: document.getElementById("sidebarOverlay").classList.contains("open"),
    bodyCollapsed: document.body.classList.contains("sessions-sidebar-collapsed"),
  }));
}

async function withPage(run, { isDesktop = false } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(SHELL);
    await page.addScriptTag({ content: PROVIDER_SETUP });
    await page.addScriptTag({ content: stubSetup(isDesktop) });
    await page.addScriptTag({ content: sidebarSource });
    await page.addScriptTag({ content: overviewSource });
    await page.addScriptTag({ content: viewSource });
    await page.waitForFunction(() => {
      const view = document.getElementById("projectsView");
      return !view.hidden && view.querySelectorAll(".sidebar-project-head").length > 0;
    });
    await run(page);
  } finally {
    await browser.close();
  }
}

const L1_LEVEL = 'projects';
const L2_LEVEL = 'project-sessions';

async function enterL2(page) {
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  await page.waitForTimeout(SETTLE_MS);
  const state = await levelSnapshot(page);
  assert.equal(state.level, L2_LEVEL, 'entered level two');
  assert.equal(state.headerHidden, false, 'L2 header visible');
  assert.equal(state.headerTitle, 'Alpha', 'L2 header shows the project name');
  return state;
}

// --- 1. Mobile drawer: collapse at L2, reopen restores L2 ---
await withPage(async (page) => {
  await enterL2(page);
  await page.evaluate(() => closeSidebarFn());
  let state = await levelSnapshot(page);
  assert.equal(state.overlayOpen, false, 'drawer collapsed');
  assert.equal(state.level, L2_LEVEL, 'level two survives the collapse');

  await page.evaluate(() => openSessionsSidebar());
  state = await levelSnapshot(page);
  assert.equal(state.overlayOpen, true, 'drawer reopened');
  assert.equal(state.level, L2_LEVEL, 'reopening stays at level two');
  assert.equal(state.headerHidden, false, 'L2 header visible after reopen');
  assert.equal(state.headerTitle, 'Alpha', 'project name restored after reopen');
  assert.equal(state.projectsHidden, true, 'L1 overview stays hidden');
  assert.equal(state.listHidden, false, 'L2 session list visible');
  assert.deepEqual(state.listRows, ['first', 'second'], 'L2 rows intact');
});

// --- 2. Desktop: collapse at L2, reopen restores L2 ---
await withPage(async (page) => {
  await enterL2(page);
  await page.evaluate(() => closeSidebarFn());
  let state = await levelSnapshot(page);
  assert.equal(state.bodyCollapsed, true, 'desktop sidebar collapsed');
  assert.equal(state.level, L2_LEVEL, 'level two survives the desktop collapse');

  await page.evaluate(() => openSessionsSidebar());
  state = await levelSnapshot(page);
  assert.equal(state.bodyCollapsed, false, 'desktop sidebar expanded');
  assert.equal(state.level, L2_LEVEL, 'reopening stays at level two');
  assert.equal(state.headerHidden, false, 'L2 header visible after reopen');
  assert.equal(state.projectsHidden, true, 'L1 overview stays hidden');
  assert.deepEqual(state.listRows, ['first', 'second'], 'L2 rows intact');
}, { isDesktop: true });

// --- 3. From L1 the reopen still lands on L1 (previous behavior kept) ---
await withPage(async (page) => {
  const before = await levelSnapshot(page);
  assert.equal(before.level, L1_LEVEL, 'starts at level one');
  await page.evaluate(() => openSessionsSidebar());
  const state = await levelSnapshot(page);
  assert.equal(state.level, L1_LEVEL, 'opening from L1 stays at L1');
  assert.equal(state.headerHidden, true, 'no project header at L1');
  assert.equal(state.projectsHidden, false, 'L1 overview visible');
});

// --- 4. Account entry reflects Google status and routes into the existing
// cross-device account workspace instead of leaving a static unavailable label.
await withPage(async (page) => {
  const accountButton = page.locator('#sidebarAccountBtn2');
  await accountButton.click();
  await page.waitForFunction(() => document.getElementById('sidebarAccountStatus')?.textContent === 'Google sign-in is ready to bind');
  assert.equal(
    await page.locator('#sidebarAccountDetail').textContent(),
    'Bind a Google account once to sign in as the owner from other devices.',
    'configured but unbound instances explain the next step',
  );
  assert.equal(await page.locator('#sidebarAccountAction').textContent(), 'Bind Google account');
  assert.equal(await accountButton.getAttribute('data-account-state'), 'pending', 'account entry exposes pending binding state');
  assert.match(await accountButton.getAttribute('aria-label'), /ready to bind/i, 'account entry carries the current state for assistive tech');

  await page.locator('#sidebarAccountAction').click();
  await page.waitForFunction(() => window.__openedCrossDeviceView === 'account');
  assert.equal(await page.locator('#sidebarAccountPopover').getAttribute('hidden'), '', 'workspace handoff closes the transient popover');
  assert.equal(await page.evaluate(() => window.__crossDeviceTriggerId), 'sidebarAccountBtn2', 'workspace restores focus to the persistent account entry, never a hidden action');

  await page.evaluate(() => { window.__googleAccountStatus = { enabled: true, bound: true }; });
  await accountButton.click();
  await page.waitForFunction(() => document.getElementById('sidebarAccountStatus')?.textContent === 'Google cross-device sign-in is enabled');
  assert.equal(await page.locator('#sidebarAccountAction').textContent(), 'Manage cross-device login');
  assert.equal(await accountButton.getAttribute('data-account-state'), 'ready', 'bound accounts expose ready state');

  await accountButton.click();
  await page.evaluate(() => { window.__googleAccountStatus = 'error'; });
  await accountButton.click();
  await page.waitForFunction(() => document.getElementById('sidebarAccountStatus')?.textContent === "Couldn't get account status");
  assert.equal(await page.locator('#sidebarAccountRetry').isVisible(), true, 'failed status gives the user a direct recovery action');

  await page.evaluate(() => { window.__googleAccountStatus = { enabled: true, bound: false }; });
  await page.locator('#sidebarAccountRetry').click();
  await page.waitForFunction(() => document.getElementById('sidebarAccountStatus')?.textContent === 'Google sign-in is ready to bind');
  assert.equal(await page.locator('#sidebarAccountRetry').isVisible(), false, 'retry clears after the status recovers');
});

console.log('test-chat-sidebar-reopen-preserves-level: ok');
