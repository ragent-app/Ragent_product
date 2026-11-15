#!/usr/bin/env node
// Focused DOM regression for the mobile L2 left-edge back interaction. This
// intentionally avoids the retired long screenshot fixture: it exercises the
// real project-view module against the real mobile CSS and checks direct
// manipulation, rebound, interruption-safe cleanup, and committed back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const styles = [
  read('static/chat/chat-base.css'),
  read('static/chat/chat-sidebar.css'),
  read('static/chat/chat-responsive.css'),
];
const overview = read('static/chat/project-overview.js');
const view = read('static/chat/project-view-ui.js');

const shell = `
  <style>${styles.join('\n')}</style>
  <div class="sidebar-project-header" id="sidebarProjectHeader" hidden>
    <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button"></button>
    <span class="sidebar-project-header-icon"></span>
    <span class="sidebar-project-header-title" id="sidebarProjectTitle"></span>
  </div>
  <div class="sidebar-session-surface" id="sidebarSessionSurface" style="width:390px;height:600px">
    <div class="sidebar-search-results-heading" id="sidebarSessionSearchHeading" hidden></div>
    <div class="sidebar-projects-view" id="projectsView" hidden></div>
    <div class="sidebar-list" id="sessionList"></div>
    <div class="sidebar-agent-search-results" id="sidebarAgentSearchResults" hidden></div>
  </div>
  <button id="newSessionBtn"><span class="sidebar-new-chat-icon"></span><span></span></button>
  <button id="sidebarAgentBtn"></button>
  <input id="sessionSearchInput" />
`;

const setup = `
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem() { return null; }, setItem() {} } });
  window.ragentT = (key) => key;
  window.renderUiIcon = () => "";
  window.ragentGetProjects = () => [{ id: "p1", name: "Alpha", rootPath: "/srv/alpha" }];
  window.ragentProjectsReady = Promise.resolve();
  window.getActiveSidebarTabValue = () => "sessions";
  window.sessionSearchQuery = "";
  window.sidebarSearchMode = false;
  window.getFilteredActiveSessions = () => [{ id: "s1", projectId: "p1", name: "first", activity: { run: null } }];
  window.getSessionSortTime = () => 0;
  window.compareSessionListSessions = () => 0;
  window.createActiveSessionItem = (session) => {
    const item = document.createElement("div");
    item.className = "session-item";
    item.textContent = session.name;
    return item;
  };
  window.matchesSearchQuery = () => false;
  window.createNewSessionShortcut = () => false;
  window.sidebarSessionSearchHeading = document.getElementById("sidebarSessionSearchHeading");
  window.sidebarAgentSearchResults = document.getElementById("sidebarAgentSearchResults");
  window.sessionSearchInput = document.getElementById("sessionSearchInput");
  window.newSessionBtn = document.getElementById("newSessionBtn");
  window.sidebarAgentBtn = document.getElementById("sidebarAgentBtn");
  window.sessionList = document.getElementById("sessionList");
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(shell);
  await page.addScriptTag({ content: setup });
  await page.addScriptTag({ content: overview });
  await page.addScriptTag({ content: view });
  await page.waitForFunction(() => document.querySelector('.sidebar-project-head'));

  const cancelled = await page.evaluate(async () => {
    document.querySelector('.sidebar-project-head').click();
    const api = window.RagentProjectView;
    const began = api.beginEdgeBackSwipe();
    api.updateEdgeBackSwipe(88);
    const during = {
      began,
      level: api.getSidebarViewLevel(),
      viewHidden: document.getElementById('projectsView').hidden,
      listHidden: document.getElementById('sessionList').hidden,
      listTransform: document.getElementById('sessionList').style.transform,
      headerTransform: document.getElementById('sidebarProjectHeader').style.transform,
    };
    api.settleEdgeBackSwipe(false);
    const interruptedBegan = api.beginEdgeBackSwipe();
    api.updateEdgeBackSwipe(36);
    const interrupted = {
      began: interruptedBegan,
      listTransform: document.getElementById('sessionList').style.transform,
    };
    api.settleEdgeBackSwipe(false);
    await new Promise((resolve) => setTimeout(resolve, 260));
    return {
      during,
      interrupted,
      level: api.getSidebarViewLevel(),
      viewHidden: document.getElementById('projectsView').hidden,
      listHidden: document.getElementById('sessionList').hidden,
      surfaceClasses: Array.from(document.getElementById('sidebarSessionSurface').classList),
      listTransform: document.getElementById('sessionList').style.transform,
    };
  });
  assert.equal(cancelled.during.began, true, 'L2 edge-back gesture should begin on mobile');
  assert.equal(cancelled.during.level, 'project-sessions', 'dragging must not change navigation state');
  assert.equal(cancelled.during.viewHidden, false, 'L1 should be exposed underneath the dragged L2 panel');
  assert.equal(cancelled.during.listHidden, false, 'L2 should remain visible while dragged');
  assert.match(cancelled.during.listTransform, /translate3d\(88px/, 'L2 list should follow the finger');
  assert.match(cancelled.during.headerTransform, /translate3d\(88px/, 'L2 header should follow the list');
  assert.equal(cancelled.interrupted.began, true, 'a second edge touch should interrupt an in-flight rebound');
  assert.match(cancelled.interrupted.listTransform, /translate3d\(36px/, 'an interrupted rebound should hand the current panel back to the finger');
  assert.equal(cancelled.level, 'project-sessions', 'below-threshold release should stay in L2');
  assert.equal(cancelled.viewHidden, true, 'cancelled drag should hide the L1 underlay again');
  assert.equal(cancelled.listHidden, false, 'cancelled drag should leave L2 visible');
  assert.equal(cancelled.listTransform, '', 'cancelled drag should clear transform residue');
  assert.doesNotMatch(cancelled.surfaceClasses.join(' '), /sidebar-edge-back-swipe/, 'cancelled drag should clear gesture classes');

  const committed = await page.evaluate(async () => {
    const api = window.RagentProjectView;
    api.beginEdgeBackSwipe();
    api.updateEdgeBackSwipe(130);
    api.settleEdgeBackSwipe(true);
    await new Promise((resolve) => setTimeout(resolve, 260));
    return {
      level: api.getSidebarViewLevel(),
      viewHidden: document.getElementById('projectsView').hidden,
      listHidden: document.getElementById('sessionList').hidden,
      headerHidden: document.getElementById('sidebarProjectHeader').hidden,
      surfaceClasses: Array.from(document.getElementById('sidebarSessionSurface').classList),
    };
  });
  assert.equal(committed.level, 'projects', 'threshold release should return to L1');
  assert.equal(committed.viewHidden, false, 'committed back should show L1');
  assert.equal(committed.listHidden, true, 'committed back should hide L2');
  assert.equal(committed.headerHidden, true, 'committed back should hide the L2 header');
  assert.doesNotMatch(committed.surfaceClasses.join(' '), /sidebar-edge-back-swipe/, 'committed drag should clear gesture classes');
  console.log('test-chat-projects-l2-edge-swipe: ok');
} finally {
  await browser.close();
}
