#!/usr/bin/env node
// Boot-order regression for the two-level sessions sidebar:
// L1 (project overview) renders as soon as the projects catalog resolves —
// before the session fetch lands — so every project briefly shows a zero
// count. The overview must re-render once session state is applied, even when
// the classic session-list render is suppressed by the signature guard (boot
// restore equal to the fetched catalog). Before the fix, L1 kept the stale
// zero counts until the user entered a project and came back.
//
// Loads the real browser modules (bootstrap-session-catalog / session-http-
// list-state / project-overview / project-view-ui) in chat.html order with
// minimal stubs, then drives the REAL applySessionListState through both boot
// shapes: first load (render allowed) and restore-equal fetch (classic list
// render suppressed, project overview must still refresh).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('../', import.meta.url);
const sources = {
  catalog: await readFile(new URL('static/chat/bootstrap-session-catalog.js', repoRoot), 'utf8'),
  listState: await readFile(new URL('static/chat/session-http-list-state.js', repoRoot), 'utf8'),
  overview: await readFile(new URL('static/chat/project-overview.js', repoRoot), 'utf8'),
  view: await readFile(new URL('static/chat/project-view-ui.js', repoRoot), 'utf8'),
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div id="projectsView"></div>
    <div id="sidebarProjectHeader" hidden>
      <button id="sidebarProjectBackBtn" type="button"></button>
      <span id="sidebarProjectTitle"></span>
    </div>
    <div id="sessionList"></div>
    <div id="sidebarSessionSearchHeading" hidden></div>
    <div id="sidebarAgentSearchResults" hidden></div>
    <input id="sessionSearchInput" />
    <button id="sidebarAgentBtn"></button>
    <button id="newSessionBtn"><span class="sidebar-new-chat-icon"></span><span></span></button>
  </body></html>`);

  await page.evaluate((sources) => {
    // ---- app globals the real modules resolve through window ----
    const projectViewStorage = new Map();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key) => projectViewStorage.has(key) ? projectViewStorage.get(key) : null,
        setItem: (key, value) => projectViewStorage.set(key, String(value)),
        removeItem: (key) => projectViewStorage.delete(key),
      },
    });
    window.FILTER_ALL_VALUE = '__all__'; // defined in bootstrap.js in the app
    window.marked = { use: () => {} };   // markdown extensions registered at load
    window.ragentT = (key) => key;
    window.renderUiIcon = () => '<svg aria-hidden="true"></svg>';
    // The projects catalog resolves before any session data exists.
    window.ragentProjectsReady = Promise.resolve();
    window.ragentGetProjects = () => [
      { id: 'p1', name: 'Alpha', rootPath: '/home/example' },
      { id: 'p2', name: 'Beta', rootPath: '/home/example/work' },
    ];
    // Scoped-out workspace: the classic sessions list would see nothing; the
    // two-level navigation must still read the full cross-project catalog.
    window.ragentSessionMatchesSelectedWorkspace = () => false;
    window.ragentOpenProjectCreateDialog = () => {};
    window.ragentGetSelectedProjectId = () => '';
    window.sessionSearchQuery = '';
    window.sidebarSearchMode = false;
    window.getActiveSidebarTabValue = () => 'sessions';
    window.createActiveSessionItem = (session) => {
      const div = document.createElement('div');
      div.className = 'session-item';
      const name = document.createElement('div');
      name.className = 'session-item-name';
      name.textContent = session.name || session.id;
      div.appendChild(name);
      return div;
    };
    window.backToProjects = () => {};
    window.sessionStateModel = {
      createEmptyStatus: () => ({}),
      normalizeSessionActivity: (activity) => activity || {},
      isSessionBusy: () => false,
      getSessionStatusSummary: () => ({ primary: 'idle' }),
      getSessionVisualStatus: () => 'idle',
      getSessionSortTime: (session) => session?.sortTime || 0,
      compareSessionListSessions: (a, b) => (b?.sortTime || 0) - (a?.sortTime || 0),
    };
    // Shared mutable store + load flags — filled by the simulated fetch after
    // the first render, exactly like the real boot.
    window.sessions = [];
    window.hasLoadedSessions = false;
    window.archivedSessionCount = 0;
    window.currentSessionId = '';
    // Navigation-history helpers are not part of this projection fixture;
    // visitor mode keeps bootstrap from initializing that unrelated surface.
    window.visitorMode = true;
    window.shareSnapshotMode = false;
    window.readNavigationStateFromLocation = () => ({});
    window.sessionList = document.getElementById('sessionList');
    window.sessionSearchInput = document.getElementById('sessionSearchInput');
    window.sidebarSessionSearchHeading = document.getElementById('sidebarSessionSearchHeading');
    window.sidebarAgentSearchResults = document.getElementById('sidebarAgentSearchResults');
    window.sidebarAgentBtn = document.getElementById('sidebarAgentBtn');
    window.newSessionBtn = document.getElementById('newSessionBtn');
    // session-http-list-state.js dependencies (session-http.js in the app).
    window.normalizeSessionRecord = (session) => session;
    window.mergeUniqueSessions = (entries) => {
      const seen = new Set();
      return (entries || []).filter((entry) => entry?.id && !seen.has(entry.id) && seen.add(entry.id));
    };
    window.__listRenders = 0;
    window.renderSessionList = () => { window.__listRenders += 1; };
    window.getComparableSessionStateSignature = () => 'SIG-UNCHANGED';
    window.resetAttachedSessionRenderState = () => {};
    window.clearMessages = () => {};
    window.showEmpty = () => {};
    window.restoreDraft = () => {};
    // Real modules in chat.html order.
    (0, eval)(sources.catalog);
    (0, eval)(sources.listState);
    (0, eval)(sources.overview);
    (0, eval)(sources.view);
  }, sources);

  // ---- Phase A: boot render with an empty store ----
  const zeroCounts = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return [...document.querySelectorAll('.sidebar-project-head-count')].map((el) => el.textContent);
  });
  assert.deepEqual(zeroCounts, ['0', '0'], 'boot render with empty store shows zero counts');

  // ---- Phase B: boot restore already filled the store with the same data,
  // then the fetch lands with an equal signature — the classic list render is
  // suppressed, but the project overview must still refresh. ----
  const seeded = [
    { id: 's1', name: 'one', projectId: 'p1', sortTime: 300 },
    { id: 's2', name: 'two', projectId: 'p1', sortTime: 200 },
    { id: 's-fork', name: 'forked child', projectId: 'p1', forkedFromSessionId: 's1', rootSessionId: 's1', sortTime: 250 },
    { id: 's3', name: 'three', projectId: 'p2', sortTime: 100 },
    // Unbound session: folder fallback groups it under p1 (rootPath match).
    { id: 's4', name: 'orphan', projectId: '', folder: '/home/example', sortTime: 50 },
  ];
  const bootResult = await page.evaluate((fetched) => {
    window.sessions = [...fetched];
    window.hasLoadedSessions = true; // restored state
    const result = window.applySessionListState(fetched);
    return { listRenders: window.__listRenders, result: result.length };
  }, seeded);
  assert.equal(bootResult.listRenders, 0, 'classic list render suppressed by signature guard (bug precondition)');
  assert.equal(bootResult.result, 5, 'state applied');

  const counts = await page.evaluate(() =>
    [...document.querySelectorAll('.sidebar-project-head-count')].map((el) => el.textContent));
  assert.deepEqual(counts, ['4', '1'], 'overview refreshed despite suppressed list render and includes project forks');
  const previewRows = await page.evaluate(() =>
    document.querySelectorAll('.sidebar-project-preview .session-item').length);
  assert.equal(previewRows, 4, 'preview rows render for both groups including fork roots');

  // ---- Phase C: a full page refresh restores the project session level from
  // the current browser tab, then the fetched catalog/session state populates
  // the same project list instead of dropping the user back at L1. ----
  const restored = await page.evaluate(() => {
    sessionStorage.setItem('ragent.projectViewState', JSON.stringify({
      level: 'project-sessions',
      projectId: 'p1',
    }));
    const didRestore = window.RagentProjectView.restoreStoredProjectSessionsView();
    return {
      didRestore,
      level: window.RagentProjectView.getSidebarViewLevel(),
      title: document.getElementById('sidebarProjectTitle').textContent,
      rows: [...document.querySelectorAll('#sessionList .session-item-name')].map((el) => el.textContent),
      projectsHidden: document.getElementById('projectsView').hidden,
      listHidden: document.getElementById('sessionList').hidden,
    };
  });
  assert.equal(restored.didRestore, true, 'stored project level restores when the project still exists');
  assert.equal(restored.level, 'project-sessions', 'refresh restores the project session level');
  assert.equal(restored.title, 'Alpha', 'refresh restores the browsed project name');
  assert.deepEqual(restored.rows, ['one', 'forked child', 'two', 'orphan'], 'refresh restores the correct project session list including forks');
  assert.equal(restored.projectsHidden, true, 'project overview is hidden at restored L2');
  assert.equal(restored.listHidden, false, 'restored project session list is visible');

  // ---- Phase D: workspace-scope contract — the two-level source reads the
  // full cross-project catalog even when the selected workspace excludes it. ----
  const scope = await page.evaluate(() => ({
    scoped: window.getFilteredActiveSessions().length,
    crossProject: window.getFilteredActiveSessions({ includeAllProjects: true }).length,
  }));
  assert.equal(scope.scoped, 0, 'classic scoped view sees nothing (stub workspace match)');
  assert.equal(scope.crossProject, 5, 'two-level navigation reads the full root catalog');

  console.log('test-chat-projects-l1-boot-refresh: ok');
} finally {
  await browser.close();
}
