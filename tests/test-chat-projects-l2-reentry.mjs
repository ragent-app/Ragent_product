#!/usr/bin/env node
// Browser-level regression tests for the two-level projects sidebar level
// switch (project-view-ui.js). The L2 header (back button + project name)
// must remain visible on every re-entry. The level transition is state-first;
// the header is never animated and must never retain animation residue. These
// tests drive the real project-view-ui.js / project-overview.js with stubbed
// sidebar globals and assert the header state across enter → back → re-enter.
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
const overviewSource = readAsset('project-overview.js');
const viewSource = readAsset('project-view-ui.js');

// project-view-ui.js touches the sidebar header, the two level containers and
// the bottom-bar buttons, and calls a handful of bare globals provided by
// other classic scripts; all of them are stubbed here.
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
  window.ragentGetProjects = function () {
    return [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }];
  };
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = function () { return "sessions"; };
  window.sessionSearchQuery = "";
  window.sidebarSearchMode = false;
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

const SHELL = `
  <style>${baseCss}${sidebarCss}</style>
  <div class="sidebar-session-surface" id="sidebarSessionSurface">
    <div class="sidebar-search-results-heading" id="sidebarSessionSearchHeading" hidden>Sessions</div>
    <div class="sidebar-projects-view" id="projectsView" hidden></div>
    <div class="sidebar-list" id="sessionList"></div>
    <div class="sidebar-agent-search-results" id="sidebarAgentSearchResults" hidden></div>
  </div>
  <div class="sidebar-search-shell">
    <input class="sidebar-search-input" id="sessionSearchInput" type="search" />
  </div>
  <div class="sidebar-project-header" id="sidebarProjectHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button" title="Back" aria-label="Back"></button>
    <span class="sidebar-project-header-icon" data-icon="folder-solid" aria-hidden="true"></span>
    <span class="sidebar-project-header-title" id="sidebarProjectTitle"></span>
  </div>
  <button class="new-session-btn" id="newSessionBtn" type="button"><span class="sidebar-new-chat-icon"></span><span>New</span></button>
  <button class="sidebar-agent-btn" id="sidebarAgentBtn" type="button">Agents</button>
`;

// clip-path leg 240ms, header enter 260ms, collapse 160ms + margin.
const SETTLE_MS = 900;

// Runs in the page: sleeps then snapshots the L2 header state.
const HEADER_SNAPSHOT = (ms) => `
  (async () => {
    const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));
    await sleep(${ms});
    const header = document.getElementById("sidebarProjectHeader");
    const title = document.getElementById("sidebarProjectTitle");
    return {
      hidden: header.hidden,
      classes: Array.from(header.classList),
      opacity: getComputedStyle(header).opacity,
      title: title.textContent,
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
    await page.addScriptTag({ content: STUB_SETUP });
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

// --- 1. First entry: header becomes visible with the project name ---
await withPage(async (page) => {
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  const state = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.equal(state.hidden, false, 'L2 header shown on first entry');
  assert.equal(state.opacity, '1', 'L2 header fully opaque on first entry');
  assert.equal(state.title, 'Alpha', 'L2 header shows the project name');
});

// --- 2. Back to L1: header hidden with no animation residue ---
await withPage(async (page) => {
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  await page.evaluate(() => document.getElementById("sidebarProjectBackBtn").click());
  const state = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.equal(state.hidden, true, 'L2 header hidden after back');
  assert.doesNotMatch(state.classes.join(' '), /sidebar-project-header-(enter|exit)/, 'header has no transition residue');
});

// --- 3. Regression: re-entry must clear the stale exit class and stay visible ---
await withPage(async (page) => {
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  await page.evaluate(() => document.getElementById("sidebarProjectBackBtn").click());
  await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  // Re-enter a project after a full exit cycle.
  await page.evaluate(() => document.querySelector(".sidebar-project-head").click());
  const during = await page.evaluate(`
    (() => {
      const header = document.getElementById("sidebarProjectHeader");
      return { classes: Array.from(header.classList), hidden: header.hidden };
    })()
  `);
  const settled = await page.evaluate(HEADER_SNAPSHOT(SETTLE_MS));
  assert.ok(
    !during.classes.includes('sidebar-project-header-exit'),
    'stale exit class cleared as the enter animation retriggers',
  );
  assert.equal(settled.hidden, false, 'L2 header shown on re-entry');
  assert.equal(settled.opacity, '1', 'L2 header fully opaque on re-entry');
  assert.equal(settled.title, 'Alpha', 'L2 header shows the project name on re-entry');
});

// --- 4. Rapid gesture regression: stale callbacks must not corrupt the final level ---
await withPage(async (page) => {
  await page.evaluate(() => {
    const enter = () => document.querySelector('.sidebar-project-head')?.click();
    const back = () => document.getElementById('sidebarProjectBackBtn')?.click();
    enter();
    window.setTimeout(back, 20);
    window.setTimeout(enter, 40);
  });
  await page.waitForTimeout(SETTLE_MS + 120);
  const state = await page.evaluate(() => {
    const view = document.getElementById('projectsView');
    const list = document.getElementById('sessionList');
    const header = document.getElementById('sidebarProjectHeader');
    return {
      viewHidden: view.hidden,
      listHidden: list.hidden,
      headerHidden: header.hidden,
      headerOpacity: getComputedStyle(header).opacity,
      headerClasses: Array.from(header.classList),
      viewClasses: Array.from(view.classList),
      listClasses: Array.from(list.classList),
      title: document.getElementById('sidebarProjectTitle').textContent,
    };
  });
  assert.equal(state.viewHidden, true, 'rapid gesture settles in L2, not back at L1');
  assert.equal(state.listHidden, false, 'rapid gesture leaves the L2 list visible');
  assert.equal(state.headerHidden, false, 'rapid gesture leaves the L2 header visible');
  assert.equal(state.headerOpacity, '1', 'rapid gesture leaves the header fully opaque');
  assert.equal(state.title, 'Alpha', 'rapid gesture preserves the selected project');
  assert.doesNotMatch(state.headerClasses.join(' '), /sidebar-project-header-exit/, 'stale collapse class is absent');
  assert.doesNotMatch(state.viewClasses.join(' '), /sidebar-level-(return|block-slide-reverse|solo)/, 'stale reverse morph classes are absent');
  assert.doesNotMatch(state.listClasses.join(' '), /sidebar-level-slide-reverse/, 'stale reverse list animation is absent');
});
