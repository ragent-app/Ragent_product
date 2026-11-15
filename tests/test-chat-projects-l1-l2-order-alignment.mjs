#!/usr/bin/env node
// Browser-level regression tests for L1/L2 session order alignment.
// The L1 project preview must show exactly the sessions the L2 list shows,
// in the same order: pinned sessions first, then the running section, then
// the rest, all under the shared second-level comparator (attention bands,
// workflow priority, sidebar order, id). Before the fix the preview only
// sorted by recency, so a stale pinned session was in L2's first slot but
// missing from the L1 preview — and the L1→L2 expand animation started from
// a row whose position changed when the list opened.
// These tests drive the real project-view-ui.js / project-overview.js /
// session-state-model.js with stubbed sibling globals.
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
const responsiveCss = readAsset('chat-responsive.css');
const glassCss = readAsset('chat-glass.css');
const modelSource = readAsset('session-state-model.js');
const overviewSource = readAsset('project-overview.js');
const viewSource = readAsset('project-view-ui.js');

const SESSIONS = [
  { id: 's-pinned',  projectId: 'p1', pinned: true,  name: 's-pinned',  lastEventAt: '2026-08-01T10:00:00Z', activity: { run: { state: 'idle' } } },
  { id: 's-fresh-1', projectId: 'p1', name: 's-fresh-1', lastEventAt: '2026-08-05T09:00:00Z', activity: { run: { state: 'idle' } } },
  { id: 's-fresh-2', projectId: 'p1', name: 's-fresh-2', lastEventAt: '2026-08-05T08:00:00Z', activity: { run: { state: 'idle' } } },
  { id: 's-running', projectId: 'p1', name: 's-running', lastEventAt: '2026-08-05T07:00:00Z', activity: { run: { state: 'running', startedAt: '2026-08-05T07:30:00Z' } } },
  { id: 's-fresh-3', projectId: 'p1', name: 's-fresh-3', lastEventAt: '2026-08-05T06:00:00Z', activity: { run: { state: 'idle' } } },
];

const SHELL = `
  <style>${baseCss}${sidebarCss}${responsiveCss}${glassCss}</style>
  <div class="sidebar-project-header" id="sidebarProjectHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button" title="Back" aria-label="Back"></button>
    <span class="sidebar-project-header-icon" data-icon="folder-solid" aria-hidden="true"></span>
    <span class="sidebar-project-header-title" id="sidebarProjectTitle"></span>
  </div>
  <div class="sidebar-session-surface" id="sidebarSessionSurface">
    <div class="sidebar-search-results-heading" id="sidebarSessionSearchHeading" hidden>Sessions</div>
    <div class="sidebar-projects-view" id="projectsView" hidden></div>
    <div class="sidebar-list" id="sessionList"></div>
    <div class="sidebar-agent-search-results" id="sidebarAgentSearchResults" hidden></div>
  </div>
  <div class="sidebar-search-shell">
    <input class="sidebar-search-input" id="sessionSearchInput" type="search" />
  </div>
  <button class="new-session-btn" id="newSessionBtn" type="button"><span class="sidebar-new-chat-icon"></span><span>New</span></button>
  <button class="sidebar-agent-btn" id="sidebarAgentBtn" type="button">Agents</button>
`;

// includeL2Comparator: the production path wires the real second-level
// comparator (window.compareSessionListSessions from bootstrap-session-
// catalog.js); without it the preview falls back to pure recency.
function stubSetup(includeL2Comparator) {
  const comparatorLine = includeL2Comparator
    ? `
  window.getSessionSortTime = function (session) {
    return window.RagentSessionStateModel.getSessionSortTime(session);
  };
  window.compareSessionListSessions = function (a, b) {
    return window.RagentSessionStateModel.compareSessionListSessions(a, b);
  };`
    : '';
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
  window.ragentGetProjects = function () {
    return [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }];
  };
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = function () { return "sessions"; };
  window.sessionSearchQuery = "";
  window.sidebarSearchMode = false;
  window.getFilteredActiveSessions = function () {
    return ${JSON.stringify(SESSIONS).replace(/"/g, "'").replace(/'/g, '"')};
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
  ${comparatorLine}
`;
}

const SETTLE_MS = 900;

function previewNames() {
  return Array.from(document.querySelectorAll(".sidebar-project-preview .session-item-name"))
    .map((el) => el.textContent);
}

function l2Names() {
  return Array.from(document.querySelectorAll("#sessionList .session-item-name"))
    .map((el) => el.textContent);
}

async function withPage(run, { includeL2Comparator = true } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(SHELL);
    await page.addScriptTag({ content: stubSetup(includeL2Comparator) });
    await page.addScriptTag({ content: modelSource });
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

// --- 1. L1 preview order equals the L2 list order (pinned + running + recency) ---
// L2 renders a "running" section above everything else — even pinned
// sessions — then the rest under the shared comparator. "With L2 as the
// source of truth" means the L1 preview mirrors exactly that DOM order.
await withPage(async (page) => {
  const preview = await page.evaluate(previewNames);
  assert.deepEqual(
    preview,
    ['s-running', 's-pinned', 's-fresh-1'],
    'L1 preview mirrors the L2 order: running section first, then pinned, then recency',
  );
});

// --- 2. Clicking into L2: the full list matches and the panel enters cleanly ---
await withPage(async (page) => {
  const preview = await page.evaluate(previewNames);
  const transition = await page.evaluate(() => {
    document.querySelector(".sidebar-project-head").click();
    const viewEl = document.getElementById("projectsView");
    const listEl = document.getElementById("sessionList");
    return {
      viewHidden: viewEl.hidden,
      listHidden: listEl.hidden,
      listPadding: listEl.style.paddingTop,
      listClasses: Array.from(listEl.classList),
      viewClasses: Array.from(viewEl.classList),
    };
  });
  assert.equal(transition.viewHidden, true, 'L1 is hidden before the incoming panel moves');
  assert.equal(transition.listHidden, false, 'L2 is visible before the incoming panel moves');
  assert.equal(transition.listPadding, '', 'level switch does not inject geometry compensation');
  assert.ok(
    transition.listClasses.includes('sidebar-level-panel-enter-forward'),
    'forward navigation uses one short incoming-panel transition',
  );
  assert.doesNotMatch(
    transition.listClasses.join(' '),
    /sidebar-level-(expand|slide|block|exit|return|solo)/,
    'legacy morph classes are absent',
  );
  assert.doesNotMatch(
    transition.viewClasses.join(' '),
    /sidebar-level-(expand|slide|block|exit|return|solo)/,
    'legacy morph classes are absent from L1',
  );
  await page.waitForTimeout(SETTLE_MS);
  const l2 = await page.evaluate(l2Names);
  assert.deepEqual(
    l2,
    ['s-running', 's-pinned', 's-fresh-1', 's-fresh-2', 's-fresh-3'],
    'L2 list order: running section, then pinned + recency under the shared comparator',
  );
  for (let i = 0; i < preview.length; i++) {
    assert.equal(
      l2.indexOf(preview[i]),
      i,
      `preview row ${preview[i]} stays at the same logical index in L2`,
    );
  }
});
// --- 3. Fallback without the shared comparator stays recency-ordered ---
// The running partition still applies (it mirrors L2's section layout), but
// pinned sessions no longer float: recency decides within each section.
await withPage(async (page) => {
  const preview = await page.evaluate(previewNames);
  assert.deepEqual(
    preview,
    ['s-running', 's-fresh-1', 's-fresh-2'],
    'without the shared comparator: running first, then pure recency',
  );
}, { includeL2Comparator: false });
