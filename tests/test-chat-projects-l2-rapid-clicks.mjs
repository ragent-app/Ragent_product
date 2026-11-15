#!/usr/bin/env node
// Dedicated rapid-click regression for the two-level projects sidebar.
// A new gesture must invalidate every older animation callback: after a
// enter → back → enter → back → enter burst, the final L2 surface must be the
// only visible level and must not inherit reverse/exit animation residue.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readAsset = (name) => readFileSync(join(repoRoot, 'static/chat', name), 'utf8');
const baseCss = readAsset('chat-base.css');
const sidebarCss = readAsset('chat-sidebar.css');
const overviewSource = readAsset('project-overview.js');
const viewSource = readAsset('project-view-ui.js');

const shell = `
  <style>${baseCss}${sidebarCss}</style>
  <div class="sidebar-session-surface" id="sidebarSessionSurface">
    <div class="sidebar-search-results-heading" id="sidebarSessionSearchHeading" hidden></div>
    <div class="sidebar-projects-view" id="projectsView" hidden></div>
    <div class="sidebar-list" id="sessionList"></div>
    <div class="sidebar-agent-search-results" id="sidebarAgentSearchResults" hidden></div>
  </div>
  <div class="sidebar-search-shell"><input id="sessionSearchInput" /></div>
  <div class="sidebar-project-header" id="sidebarProjectHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button"></button>
    <span class="sidebar-project-header-title" id="sidebarProjectTitle"></span>
  </div>
  <button id="newSessionBtn" type="button"></button>
  <button id="sidebarAgentBtn" type="button"></button>
`;

const setup = `
  window.ragentT = (key) => key;
  window.renderUiIcon = () => '';
  window.ragentGetProjects = () => [
    { id: 'p1', name: 'Alpha', rootPath: '/srv/alpha' },
    { id: 'p2', name: 'Beta', rootPath: '/srv/beta' },
  ];
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = () => 'sessions';
  window.sessionSearchQuery = '';
  window.sidebarSearchMode = false;
  window.getFilteredActiveSessions = () => [
    { id: 's1', projectId: 'p1', name: 'one', activity: { run: null } },
    { id: 's2', projectId: 'p2', name: 'two', activity: { run: null } },
  ];
  window.getSessionSortTime = () => 0;
  window.createActiveSessionItem = (session) => {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.textContent = session.name;
    return item;
  };
  window.matchesSearchQuery = () => false;
  window.compareSessionListSessions = () => 0;
  window.createNewSessionShortcut = () => false;
  window.sidebarSessionSearchHeading = document.getElementById('sidebarSessionSearchHeading');
  window.sidebarAgentSearchResults = document.getElementById('sidebarAgentSearchResults');
  window.sessionSearchInput = document.getElementById('sessionSearchInput');
  window.newSessionBtn = document.getElementById('newSessionBtn');
  window.sidebarAgentBtn = document.getElementById('sidebarAgentBtn');
  window.sessionList = document.getElementById('sessionList');
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(shell);
  await page.addScriptTag({ content: setup });
  await page.addScriptTag({ content: overviewSource });
  await page.addScriptTag({ content: viewSource });
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-project-head').length >= 2);

  await page.evaluate(() => {
    const clickProject = (id) => document.querySelector(`.sidebar-project-head[data-project-id="${id}"]`)?.click();
    const clickBack = () => document.getElementById('sidebarProjectBackBtn')?.click();
    clickProject('p1');
    setTimeout(clickBack, 18);
    setTimeout(() => clickProject('p2'), 36);
    setTimeout(clickBack, 54);
    setTimeout(() => clickProject('p1'), 72);
  });
  await page.waitForTimeout(1000);

  const state = await page.evaluate(() => {
    const view = document.getElementById('projectsView');
    const list = document.getElementById('sessionList');
    const header = document.getElementById('sidebarProjectHeader');
    return {
      level: window.RagentProjectView.getSidebarViewLevel(),
      viewHidden: view.hidden,
      listHidden: list.hidden,
      headerHidden: header.hidden,
      title: document.getElementById('sidebarProjectTitle').textContent,
      headerOpacity: getComputedStyle(header).opacity,
      headerClasses: Array.from(header.classList),
      viewClasses: Array.from(view.classList),
      listClasses: Array.from(list.classList),
      inlineClip: list.style.clipPath,
    };
  });

  assert.equal(state.level, 'project-sessions', 'final rapid click lands in the last selected L2');
  assert.equal(state.viewHidden, true, 'stale callbacks do not reveal the L1 view');
  assert.equal(state.listHidden, false, 'final L2 list remains visible');
  assert.equal(state.headerHidden, false, 'final L2 header remains visible');
  assert.equal(state.title, 'Alpha', 'last click selection wins after the burst');
  assert.equal(state.headerOpacity, '1', 'stale exit animation does not pin the header transparent');
  assert.equal(state.inlineClip, '', 'rapid gesture settles without an inline clip residue');
  assert.doesNotMatch(state.headerClasses.join(' '), /sidebar-project-header-exit/);
  assert.doesNotMatch(state.viewClasses.join(' '), /sidebar-level-(return|block-slide-reverse|solo)/);
  assert.doesNotMatch(state.listClasses.join(' '), /sidebar-level-slide-reverse/);

  console.log('test-chat-projects-l2-rapid-clicks: ok');
} finally {
  await browser.close();
}
