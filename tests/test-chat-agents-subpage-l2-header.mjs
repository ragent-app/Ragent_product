#!/usr/bin/env node
// Browser-level regression tests for the L2 project header on subpage tabs.
// The agents/settings subpages are second-level views: the L2 project header
// (back button + project name) belongs to the project's session list, and
// showing it again above the subpage header duplicates the project name the
// L2 level already provides. syncSidebarShellState (sidebar-ui.js) must hide
// the project header on subpages and strip its enter/exit animation classes —
// a stale class with `animation-fill-mode: both` pins opacity 0 and the
// header would come back invisible when the sessions tab restores it.
// The same fixture also checks the new shared-symbol Agent/Settings transition.
// These tests drive the real sidebar-ui.js / project-view-ui.js /
// project-overview.js with stubbed sibling globals.
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

// sidebar-ui.js runs several top-level bindings at load: event listeners on
// bare sibling globals and an async project-catalog fetch. The shell below
// provides every element those top-level paths touch (plus the L2 header
// surface), and the stub setup supplies the bare identifiers as window props.
const SHELL = `
  <style>${baseCss}${sidebarCss}</style>
  <div class="sidebar" id="sidebar"></div>
  <div class="sidebar-appbar" id="sidebarAppBar"></div>
  <div class="sidebar-search-mode-header" id="sidebarSearchModeHeader" hidden></div>
  <div class="sidebar-subpage-header" id="sidebarSubpageHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarSubpageCloseBtn" type="button"></button>
    <span class="sidebar-subpage-icon" id="sidebarSubpageIcon"></span>
    <div class="sidebar-subpage-title" id="sidebarSubpageTitle"></div>
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
  <button class="new-session-btn" id="newSessionBtn" type="button"><span class="sidebar-new-chat-icon"></span><span>New</span></button>
  <button class="sidebar-icon-btn" id="sidebarAccountBtn" type="button">Account</button>
  <button class="sidebar-icon-btn" id="sidebarFilterBtn" type="button"><svg class="rl-icon" viewBox="0 0 24 24"><path d="M12 3v18" /></svg></button>
  <button class="sidebar-agent-btn" id="sidebarAgentBtn" type="button"><span class="sidebar-agent-icon"><svg class="rl-icon" viewBox="0 0 24 24"><path d="M12 3v18" /></svg></span></button>
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

// bootstrap.js declares the shared sidebar/composer elements as top-level
// lexical bindings; sidebar-ui.js reads them as bare identifiers. Recreate
// those bindings the same way so the real sidebar-ui.js loads unmodified.
const PROVIDER_SETUP = `
  const menuBtn = document.getElementById("menuBtn");
  const closeSidebar = document.getElementById("closeSidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
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

const STUB_SETUP = `
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: function () { return null; },
      setItem: function () {},
    },
  });
  window.ragentT = function (key) { return key; };
  window.renderUiIcon = function () { return ""; };
  window.RagentIcons = {
    render: function () { return '<svg class="rl-icon" viewBox="0 0 24 24"><path d="M12 3v18" /></svg>'; },
    hydrate: function () {},
  };
  window.isDesktop = false;
  window.__activeTab = "sessions";
  window.switchTab = function (tab) {
    window.__activeTab = tab;
    document.getElementById("sidebar").dataset.sidebarMode = tab;
    document.getElementById("agentsPanel").classList.toggle("visible", tab === "agents");
    document.getElementById("settingsPanel").classList.toggle("visible", tab === "settings");
    if (typeof window.syncSidebarShellState === "function") window.syncSidebarShellState(tab);
  };
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
    return { ok: false, json: async () => ({}) };
  };
  window.fetchSessionsList = async function () { return []; };
  window.ragentGetProjects = function () {
    return [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }];
  };
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = function () { return window.__activeTab; };
  window.sessionSearchQuery = "";
  window.getFilteredActiveSessions = function () {
    return [{ id: "s1", projectId: "p1", name: "first", activity: { run: null } }];
  };
  window.getSessionSortTime = function () { return 0; };
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
  window.compareSessionListSessions = function () { return 0; };
  window.createNewSessionShortcut = function () { return false; };
  window.sidebarSessionSearchHeading = document.getElementById("sidebarSessionSearchHeading");
  window.sidebarAgentSearchResults = document.getElementById("sidebarAgentSearchResults");
  window.sessionSearchInput = document.getElementById("sessionSearchInput");
  window.newSessionBtn = document.getElementById("newSessionBtn");
  window.sidebarAgentBtn = document.getElementById("sidebarAgentBtn");
  window.sessionList = document.getElementById("sessionList");
`;

const SETTLE_MS = 900;

const HEADER_SNAPSHOT = (ms) => `
  (async () => {
    const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));
    await sleep(${ms});
    const header = document.getElementById("sidebarProjectHeader");
    return {
      hidden: header.hidden,
      classes: Array.from(header.classList),
      opacity: getComputedStyle(header).opacity,
      title: document.getElementById("sidebarProjectTitle").textContent,
    };
  })()
`;

async function withPage(run) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(SHELL);
    await page.addScriptTag({ content: PROVIDER_SETUP });
    await page.addScriptTag({ content: STUB_SETUP });
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

// Enter L2 from L1 so the project header is showing with the project name.
async function enterLevelTwo(page) {
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  const state = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.equal(state.hidden, false, 'L2 header shown on entry');
  assert.equal(state.opacity, '1', 'L2 header fully opaque on entry');
  assert.equal(state.title, 'Alpha', 'L2 header shows the project name');
  return state;
}

// --- 1. Subpage tabs hide the L2 project header (no duplicate project name) ---
await withPage(async (page) => {
  await enterLevelTwo(page);
  await page.evaluate(() => window.syncSidebarShellState("agents"));
  const subpage = await page.evaluate(HEADER_SNAPSHOT(0));
  assert.equal(subpage.hidden, true, 'agents subpage hides the L2 project header');
  assert.ok(
    !subpage.classes.includes('sidebar-project-header-enter')
      && !subpage.classes.includes('sidebar-project-header-exit'),
    'subpage entry strips the header animation classes',
  );

  await page.evaluate(() => window.syncSidebarShellState("settings"));
  const settingsSubpage = await page.evaluate(HEADER_SNAPSHOT(0));
  assert.equal(settingsSubpage.hidden, true, 'settings subpage hides the L2 project header too');
});

// --- 2. Back to sessions while still inside the project: header returns ---
await withPage(async (page) => {
  await enterLevelTwo(page);
  await page.evaluate(() => window.syncSidebarShellState("agents"));
  await page.evaluate(() => window.syncSidebarShellState("sessions"));
  const state = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.equal(state.hidden, false, 'L2 header restored when returning to sessions');
  assert.equal(state.opacity, '1', 'restored header fully opaque (no fill-both residue)');
  assert.equal(state.title, 'Alpha', 'restored header still shows the project name');
});

// --- 3. From L1 (no project open) a subpage tab never reveals the header ---
await withPage(async (page) => {
  const atL1 = await page.evaluate(HEADER_SNAPSHOT(0));
  assert.equal(atL1.hidden, true, 'L1 has no project header');
  await page.evaluate(() => window.syncSidebarShellState("agents"));
  const subpage = await page.evaluate(HEADER_SNAPSHOT(0));
  assert.equal(subpage.hidden, true, 'agents subpage from L1 keeps header hidden');
  await page.evaluate(() => window.syncSidebarShellState("sessions"));
  const back = await page.evaluate(HEADER_SNAPSHOT(0));
  assert.equal(back.hidden, true, 'returning to sessions from L1 keeps header hidden');
});

// --- 4. Stale exit class cannot leak through a subpage round-trip ---
// Simulates: L2 entered → back to L1 (exit class left pinned at opacity 0) →
// re-enter L2 → agents subpage → sessions. The subpage hop must clear the
// residue so the header reappears instead of staying transparent.
await withPage(async (page) => {
  await enterLevelTwo(page);
  await page.evaluate(() => document.getElementById("sidebarProjectBackBtn").click());
  await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  await page.evaluate(() => window.syncSidebarShellState("agents"));
  await page.evaluate(() => window.syncSidebarShellState("sessions"));
  const state = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.equal(state.hidden, false, 'L2 header visible after subpage round-trip');
  assert.equal(state.opacity, '1', 'no fill-both opacity residue after subpage round-trip');
});

// --- 5. Shared symbols and the panel reveal share one continuous timeline ---
await withPage(async (page) => {
  await page.evaluate(() => {
    const sidebar = document.getElementById("sidebar");
    Object.assign(sidebar.style, {
      position: "relative",
      left: "0",
      top: "0",
      width: "390px",
      height: "844px",
      display: "flex",
      flexDirection: "column",
      transform: "none",
    });
    const agentButton = document.getElementById("sidebarAgentBtn");
    Object.assign(agentButton.style, {
      position: "absolute",
      left: "320px",
      top: "780px",
      width: "48px",
      height: "48px",
      display: "inline-flex",
    });
    const settingsButton = document.getElementById("sidebarFilterBtn");
    Object.assign(settingsButton.style, {
      position: "absolute",
      left: "320px",
      top: "780px",
      width: "48px",
      height: "48px",
      display: "inline-flex",
    });
    for (const panel of [document.getElementById("agentsPanel"), document.getElementById("settingsPanel")]) {
      Object.assign(panel.style, {
        position: "absolute",
        left: "0",
        top: "72px",
        width: "390px",
        height: "700px",
        overflow: "hidden",
      });
    }
  });

  await page.evaluate(() => {
    window.ragentOpenSidebarSubpage("agents", document.getElementById("sidebarAgentBtn"));
  });
  await page.waitForFunction(() => (
    document.querySelector(".sidebar-symbol-flight")
      && document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-morph-pending")
  ));
  const agentPending = await page.evaluate(() => ({
    mode: document.getElementById("sidebar").dataset.sidebarMode,
    flight: Boolean(document.querySelector(".sidebar-symbol-flight svg")),
    pending: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-morph-pending"),
    titleOpacity: getComputedStyle(document.getElementById("sidebarSubpageTitle")).opacity,
  }));
  assert.equal(agentPending.mode, "agents", "Agent transition should enter the Agent mode immediately");
  assert.equal(agentPending.flight, true, "Agent transition should render the moving star");
  assert.equal(agentPending.pending, true, "Agent panel should wait for the star to land");
  assert.equal(agentPending.titleOpacity, "0", "Agent title should wait with the landing symbol");

  await page.waitForFunction(() => document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"), null, { timeout: 1500 });
  const agentRevealOverlap = await page.evaluate(() => ({
    flight: Boolean(document.querySelector(".sidebar-symbol-flight")),
    reveal: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"),
    iconName: document.getElementById("sidebarSubpageIcon").getAttribute("data-icon"),
  }));
  assert.equal(agentRevealOverlap.flight, true, "Agent star should remain in flight while the panel reveal begins");
  assert.equal(agentRevealOverlap.reveal, true, "Agent panel should reveal before the flight finishes");
  assert.equal(agentRevealOverlap.iconName, "sparkle-solid", "Agent header should keep the solid star mark");

  await page.waitForFunction(() => !document.querySelector(".sidebar-symbol-flight"), null, { timeout: 1500 });
  const agentLanded = await page.evaluate(() => ({
    flight: Boolean(document.querySelector(".sidebar-symbol-flight")),
    reveal: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"),
  }));
  assert.equal(agentLanded.flight, false, "Agent star should hand off to the header at the end of the shared timeline");
  assert.equal(agentLanded.reveal, true, "Agent panel reveal should still be settling at handoff");

  await page.waitForTimeout(560);
  const agentSettled = await page.evaluate(() => ({
    reveal: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"),
    morphing: document.getElementById("sidebarSubpageHeader").classList.contains("sidebar-subpage-header-symbol-morphing"),
  }));
  assert.equal(agentSettled.reveal, false, "Agent reveal class should clean up after the authored moment");
  assert.equal(agentSettled.morphing, false, "Agent header should settle without a stale morph class");

  await page.evaluate(() => {
    window.ragentOpenSidebarSubpage("agents", document.getElementById("sidebarAgentBtn"));
  });
  await page.waitForFunction(() => document.querySelector(".sidebar-symbol-flight"));
  await page.evaluate(() => window.switchTab("sessions"));
  await page.waitForTimeout(80);
  const cancelled = await page.evaluate(() => ({
    flight: Boolean(document.querySelector(".sidebar-symbol-flight")),
    pending: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-morph-pending"),
    reveal: document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"),
  }));
  assert.equal(cancelled.flight, false, "Returning to sessions should remove an in-flight symbol");
  assert.equal(cancelled.pending, false, "Returning to sessions should clear the pending clip");
  assert.equal(cancelled.reveal, false, "Returning to sessions should clear the reveal class");

  await page.evaluate(() => window.switchTab("sessions"));
  await page.evaluate(() => {
    window.ragentOpenSidebarSubpage("settings", document.getElementById("sidebarFilterBtn"));
  });
  await page.waitForFunction(() => document.getElementById("settingsPanel").classList.contains("sidebar-subpage-panel-morph-pending"));
  await page.waitForFunction(() => document.getElementById("settingsPanel").classList.contains("sidebar-subpage-panel-reveal"), null, { timeout: 1500 });
  const settingsLanded = await page.evaluate(() => ({
    iconName: document.getElementById("sidebarSubpageIcon").getAttribute("data-icon"),
    flight: Boolean(document.querySelector(".sidebar-symbol-flight")),
  }));
  assert.equal(settingsLanded.iconName, "gear-solid", "Settings header should use the solid gear mark");
  assert.equal(settingsLanded.flight, true, "Settings gear should overlap the start of the panel reveal");

  // Exiting either subpage sends the same symbol back to its bottom action;
  // the destination is hidden during flight so there is no duplicate glyph.
  await page.evaluate(() => {
    Object.assign(document.getElementById("sidebar").style, {
      position: "relative",
      left: "0",
      top: "0",
      width: "390px",
      height: "844px",
    });
    for (const [id, left] of [["sidebarAgentBtn", "320px"], ["sidebarFilterBtn", "320px"]]) {
      Object.assign(document.getElementById(id).style, {
        position: "absolute",
        left,
        top: "780px",
        width: "48px",
        height: "48px",
        display: "inline-flex",
      });
    }
  });
  await page.locator("#sidebarSubpageCloseBtn").click();
  await page.waitForFunction(() => document.querySelector(".sidebar-symbol-flight-return"), null, { timeout: 1500 });
  const settingsReturn = await page.evaluate(() => ({
    mode: document.getElementById("sidebar").dataset.sidebarMode,
    flight: Boolean(document.querySelector(".sidebar-symbol-flight-return")),
    hiddenDestination: document.getElementById("sidebarFilterBtn").querySelector("svg")?.style.visibility,
  }));
  assert.equal(settingsReturn.mode, "sessions", "Settings exit should return to the sessions mode immediately");
  assert.equal(settingsReturn.flight, true, "Settings gear should fly back to the bottom action");
  assert.equal(settingsReturn.hiddenDestination, "hidden", "Settings destination should stay hidden during return flight");
  await page.waitForFunction(() => !document.querySelector(".sidebar-symbol-flight-return"), null, { timeout: 1500 });
  assert.equal(await page.evaluate(() => document.getElementById("sidebarFilterBtn").querySelector("svg")?.style.visibility), "",
    "Settings destination should be restored after return flight");

  await page.evaluate(() => window.ragentOpenSidebarSubpage("agents", document.getElementById("sidebarAgentBtn")));
  await page.waitForFunction(() => document.getElementById("agentsPanel").classList.contains("sidebar-subpage-panel-reveal"), null, { timeout: 1500 });
  await page.locator("#sidebarSubpageCloseBtn").click();
  await page.waitForFunction(() => document.querySelector(".sidebar-symbol-flight-return"), null, { timeout: 1500 });
  assert.equal(await page.evaluate(() => document.getElementById("sidebarAgentBtn").querySelector("svg")?.style.visibility), "hidden",
    "Agent destination should stay hidden during return flight");
  await page.waitForFunction(() => !document.querySelector(".sidebar-symbol-flight-return"), null, { timeout: 1500 });
  assert.equal(await page.evaluate(() => document.getElementById("sidebarAgentBtn").querySelector("svg")?.style.visibility), "",
    "Agent destination should be restored after return flight");
});

console.log('test-chat-agents-subpage-l2-header: ok');
