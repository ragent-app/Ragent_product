#!/usr/bin/env node
// Browser contract for the shared long-press surface: both sessions and
// projects open the same wide bottom sheet, rename stays inside that sheet,
// and a long press never falls through into the row's normal click action.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('../', import.meta.url);
const surfaceSource = await readFile(new URL('static/chat/session-surface-ui.js', repoRoot), 'utf8');
const overviewSource = await readFile(new URL('static/chat/project-overview.js', repoRoot), 'utf8');
const projectViewSource = await readFile(new URL('static/chat/project-view-ui.js', repoRoot), 'utf8');
const css = await readFile(new URL('static/chat/chat-sidebar.css', repoRoot), 'utf8');

assert.match(surfaceSource, /const LONG_PRESS_MS = 2000;/, 'sidebar touch long press should use the deliberate two-second threshold');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><body>
    <div class="sidebar-projects-view" id="projectsView"></div>
    <div id="sidebarProjectHeader" hidden><button id="sidebarProjectBackBtn"></button><span id="sidebarProjectTitle"></span></div>
    <div id="sessionList"></div>
    <button id="sidebarAgentBtn"></button>
    <button id="newSessionBtn"></button>
  </body></html>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(({ surfaceSource: surface, overviewSource: overview, projectViewSource: projectView }) => {
    window.ragentT = (key, vars = {}) => ({
      'action.close': 'Close',
      'action.back': 'Back',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'action.pin': 'Pin',
      'action.unpin': 'Unpin',
      'action.rename': 'Rename',
      'action.delete': 'Delete',
      'action.delete': 'Delete',
      'sidebar.session': 'Session',
      'sidebar.session.name': 'Session name',
      'sidebar.session.actions': 'Session actions',
      'sidebar.session.deleteTitle': 'Delete session?',
      'sidebar.session.deleteBody': 'This permanently deletes the session and its run history.',
      'sidebar.renameTitle': 'Rename',
      'sidebar.renameRequired': 'Enter a name first',
      'sidebar.actionFailed': 'Action failed',
      'sidebar.project.name': 'Project name',
      'sidebar.project.untitled': 'Untitled project',
      'sidebar.project.actions': 'Project actions',
      'sidebar.project.deleteTitle': 'Delete project',
      'sidebar.project.deleteBody': `This project contains ${vars.count ?? 0} sessions.`,
      'sidebar.project.deleteAll': 'Delete project and all sessions',
      'sidebar.project.deleteAllHint': 'Permanently removes the project and its sessions.',
      'sidebar.project.keepSessions': 'Delete project, keep sessions',
      'sidebar.project.keepSessionsHint': 'Move sessions to the Inbox at the bottom.',
      'sidebar.projects.newProject': 'New project',
      'sidebar.projects.newInProject': 'New session in {name}',
      'sidebar.projects.noSessions': 'No sessions',
      'sidebar.projects.empty': 'No projects',
      'sidebar.projects.emptyHint': 'Create a project',
      'sidebar.projects.statusRunning': 'Running',
      'sidebar.projects.statusNeedsAction': 'Needs your action',
      'sidebar.projects.statusUnread': 'New updates',
      'sidebar.projects.statusIdle': 'Idle',
      'sidebar.pinned': 'Pinned',
      'sidebar.view.inbox': 'Inbox',
      'session.defaultName': 'Session',
    }[key] || key);
    window.renderUiIcon = (name) => `<svg data-icon-name="${name}" viewBox="0 0 24 24"></svg>`;
    window.currentSessionId = '';
    window.visitorMode = false;
    window.isDesktop = false;
    window.msgInput = document.createElement('textarea');
    window.RagentMotion = { prefersReducedMotion: () => false };
    window.RagentBackHandler = {
      push: () => 'sheet',
      pop: () => {},
    };
    window.__sheetActions = [];
    window.dispatchAction = async (action) => {
      window.__sheetActions.push(action);
      return true;
    };
    window.__projectRequests = [];
    window.__holdNextProjectRequest = false;
    window.__releaseProjectRequest = null;
    window.fetchJsonOrRedirect = async (url, options = {}) => {
      window.__projectRequests.push({ url, options });
      if (window.__holdNextProjectRequest) {
        window.__holdNextProjectRequest = false;
        await new Promise((resolve) => { window.__releaseProjectRequest = resolve; });
        window.__releaseProjectRequest = null;
      }
      if (String(options.method || '').toUpperCase() === 'DELETE') {
        if (window.__projectDeleteMode === 'compat') {
          const error = new Error('Request failed (404)');
          error.status = 404;
          throw error;
        }
        return { ok: true };
      }
      return { project: { id: 'prj_abcdefabcdef', name: 'Renamed project', pinned: true } };
    };
    window.ragentEnsureProjectsReady = async () => [{ id: 'prj_abcdefabcdef', name: 'Alpha', rootPath: '/tmp/alpha' }];
    window.fetchSessionsList = async () => [];
    window.renderProjectsView = () => {};
    window.syncProjectLevelUI = () => {};
    window.getActiveSidebarTabValue = () => 'sessions';
    window.sessionSearchQuery = '';
    window.getFilteredActiveSessions = () => [];
    window.getSessionSortTime = () => 0;
    window.compareSessionListSessions = () => 0;
    window.sessionList = document.getElementById('sessionList');
    window.sidebarAgentBtn = document.getElementById('sidebarAgentBtn');
    window.newSessionBtn = document.getElementById('newSessionBtn');
    window.ragentProjectsReady = Promise.resolve();
    window.ragentGetProjects = () => [{ id: 'prj_abcdefabcdef', name: 'Alpha', rootPath: '/tmp/alpha' }];
    window.ragentSessionMatchesSelectedWorkspace = () => false;
    window.ragentOpenProjectCreateDialog = () => {};
    window.ragentGetSelectedProjectId = () => '';
    window.ragentGetSelectedSessionFolder = () => '';
    window.ragentGetBrowsingProject = () => null;
    window.createActiveSessionItem = () => document.createElement('div');
    window.sessionStateModel = {
      createEmptyStatus: () => ({}),
      normalizeSessionActivity: (activity) => activity || {},
      isSessionBusy: () => false,
      getSessionStatusSummary: () => ({ primary: 'idle' }),
      getSessionVisualStatus: () => 'idle',
      getSessionSortTime: () => 0,
      compareSessionListSessions: () => 0,
    };
    window.sessions = [];
    window.hasLoadedSessions = true;
    window.archivedSessionCount = 0;
    (0, eval)(surface);
    (0, eval)(overview);
    (0, eval)(projectView);
  }, { surfaceSource, overviewSource, projectViewSource });

  await page.evaluate(() => {
    const anchor = document.createElement('button');
    anchor.type = 'button';
    anchor.id = 'session-anchor';
    document.body.appendChild(anchor);
    window.__normalClicks = 0;
    anchor.addEventListener('click', () => { window.__normalClicks += 1; });
    window.ragentBindSidebarLongPress(anchor, () => window.ragentOpenSidebarActionSheet(
      'session',
      { id: 's1', name: 'Weekly report' },
      anchor,
    ));
    window.__anchor = anchor;
  });

  await page.evaluate(() => {
    window.__anchor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  });
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'a short touch hold must not open the session action sheet');
  await page.waitForTimeout(1900);
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'a hold past the threshold stays armed only — the sheet must not open while the finger is still down');
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__anchor.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 20, clientY: 20 })));
  await page.evaluate(() => window.__anchor.click());
  const sessionSheet = await page.evaluate(() => ({
    width: document.querySelector('.sidebar-action-sheet-panel')?.getBoundingClientRect().width,
    actionCount: document.querySelectorAll('.sidebar-action-sheet-action').length,
    hasLegacyMenu: !!document.querySelector('.session-context-menu'),
  }));
  assert.equal(sessionSheet.width, 390, 'session actions should use the full mobile sheet width');
  assert.equal(sessionSheet.actionCount, 3, 'session sheet should expose pin, rename and direct delete');
  assert.equal(await page.locator('[data-action="delete"]').count(), 1,
    'session sheet should offer a direct delete action');
  assert.equal(sessionSheet.hasLegacyMenu, false, 'the old anchored context menu should not be rendered');
  assert.equal(await page.evaluate(() => window.__normalClicks), 0,
    'a long press must not fall through into the row click action');
  const openModalState = await page.evaluate(() => {
    const anchor = document.querySelector('#session-anchor');
    const sheet = document.querySelector('.sidebar-action-sheet');
    return {
      bodyLocked: document.body.classList.contains('sidebar-action-sheet-open'),
      anchorInert: anchor?.inert === true,
      anchorInertAttribute: anchor?.hasAttribute('inert') === true,
      anchorAriaHidden: anchor?.getAttribute('aria-hidden'),
      anchorFilter: getComputedStyle(anchor).filter,
      anchorPointerEvents: getComputedStyle(anchor).pointerEvents,
      sheetFilter: getComputedStyle(sheet).filter,
    };
  });
  assert.equal(openModalState.bodyLocked, true, 'sheet should mark the page as modal while open');
  assert.equal(openModalState.anchorInert, true, 'sheet should make the background inert');
  assert.equal(openModalState.anchorInertAttribute, true, 'sheet should expose inert semantics to older browsers');
  assert.equal(openModalState.anchorAriaHidden, 'true', 'sheet should hide the background from assistive technology');
  assert.match(openModalState.anchorFilter, /grayscale/, 'sheet should desaturate the background page');
  assert.equal(openModalState.anchorPointerEvents, 'none', 'sheet should block background pointer events');
  assert.equal(openModalState.sheetFilter, 'none', 'sheet itself should remain visually clear');
  await page.evaluate(() => document.querySelector('[data-action="rename"]').click());
  assert.equal(await page.locator('.sidebar-action-sheet-name-input').count(), 1,
    'session rename should stay inside the action sheet');
  assert.equal(await page.locator('.sidebar-action-sheet-field-label').getAttribute('for'), 'sidebarActionSheetName',
    'rename sheet label should be associated with its input');
  const keyboardSheetGeometry = await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-height', '460px');
    const sheet = document.querySelector('.sidebar-action-sheet')?.getBoundingClientRect();
    const panel = document.querySelector('.sidebar-action-sheet-panel')?.getBoundingClientRect();
    return {
      sheetTop: sheet?.top,
      sheetBottom: sheet?.bottom,
      sheetHeight: sheet?.height,
      panelBottom: panel?.bottom,
    };
  });
  assert.equal(Math.round(keyboardSheetGeometry.sheetHeight), 460,
    'action sheet should follow the visual viewport height when the keyboard opens');
  assert.equal(Math.round(keyboardSheetGeometry.sheetTop), 0,
    'action sheet should stay anchored to the visible viewport top');
  assert.equal(Math.round(keyboardSheetGeometry.sheetBottom), 460,
    'action sheet should end at the visible viewport bottom');
  assert.ok(keyboardSheetGeometry.panelBottom <= 460.5,
    'rename panel should remain above the keyboard-visible viewport edge');
  if (process.env.SIDEBAR_RENAME_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 390, height: 460 });
    await page.screenshot({
      path: `${process.env.SIDEBAR_RENAME_SCREENSHOT_DIR}/mobile-rename-visual-viewport.png`,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-height'));
  await page.locator('.sidebar-action-sheet-name-input').fill('Monthly report');
  await page.evaluate(() => {
    const input = document.querySelector('.sidebar-action-sheet-name-input');
    input.focus();
    document.querySelector('.sidebar-action-sheet-primary')?.click();
  });
  await page.waitForTimeout(300);
  const renameAction = await page.evaluate(() => window.__sheetActions.filter((action) => action.action === 'rename').at(-1));
  assert.equal(renameAction.name, 'Monthly report', 'sheet rename should submit the edited name');
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0, 'sheet should close after a successful rename');
  const restoredBackground = await page.evaluate(() => {
    const anchor = document.querySelector('#session-anchor');
    return {
      bodyLocked: document.body.classList.contains('sidebar-action-sheet-open'),
      anchorInert: anchor?.inert === true,
      anchorInertAttribute: anchor?.hasAttribute('inert') === true,
      anchorAriaHidden: anchor?.getAttribute('aria-hidden'),
    };
  });
  assert.equal(restoredBackground.bodyLocked, false, 'closing the sheet should restore page interaction');
  assert.equal(restoredBackground.anchorInert, false, 'closing the sheet should release inert state');
  assert.equal(restoredBackground.anchorInertAttribute, false, 'closing the sheet should remove its temporary inert attribute');
  assert.equal(restoredBackground.anchorAriaHidden, null, 'closing the sheet should restore the background aria state');

  await page.evaluate(() => window.ragentOpenSidebarActionSheet(
    'session',
    { id: 's3', name: 'Keyboard rename' },
    document.querySelector('#session-anchor'),
  ));
  await page.locator('[data-action="rename"]').click();
  const keyboardRenameInput = page.locator('.sidebar-action-sheet-name-input');
  await keyboardRenameInput.fill('Saved while focused');
  await keyboardRenameInput.press('Enter');
  await page.waitForTimeout(300);
  const keyboardRenameAction = await page.evaluate(() => window.__sheetActions.filter((action) => action.action === 'rename').at(-1));
  assert.equal(keyboardRenameAction.name, 'Saved while focused',
    'keyboard Done should submit the current rename draft without a blur');
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'sheet should close after keyboard rename submission');

  await page.evaluate(() => window.ragentOpenSidebarActionSheet(
    'session',
    { id: 's4', name: 'Delete me' },
    document.querySelector('#session-anchor'),
  ));
  await page.locator('[data-action="delete"]').click();
  assert.equal(await page.locator('[data-action="confirm-delete-session"]').count(), 1,
    'delete should open a second confirmation view before dispatching');
  await page.waitForFunction(() => document.activeElement?.classList.contains('sidebar-action-sheet-close'));
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'sidebar-action-sheet-close',
    'delete confirmation should move keyboard focus to the visible safe close action');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'sidebar-action-sheet-back',
    'Shift+Tab should loop from the first confirmation control to the safe back action');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'sidebar-action-sheet-close',
    'Tab should loop from the safe back action to the first confirmation control');
  assert.match(await page.locator('.sidebar-action-sheet-panel').innerText(), /This permanently deletes/,
    'delete confirmation should explain that the action is permanent');
  assert.equal(await page.evaluate(() => window.__sheetActions.filter((action) => action.action === 'delete').length), 0,
    'opening the confirmation view must not dispatch deletion');
  await page.locator('[data-action="confirm-delete-session"]').click();
  await page.waitForTimeout(300);
  const deleteAction = await page.evaluate(() => window.__sheetActions.filter((action) => action.action === 'delete').at(-1));
  assert.equal(deleteAction.sessionId, 's4', 'confirmed deletion should dispatch the session delete action');
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'sheet should close after confirmed session deletion');

  await page.evaluate(() => window.ragentOpenSidebarActionSheet(
    'session',
    { id: 's5', name: 'Keep me' },
    document.querySelector('#session-anchor'),
  ));
  await page.locator('[data-action="delete"]').click();
  await page.locator('.sidebar-action-sheet-back').click();
  assert.equal(await page.locator('[data-action="delete"]').count(), 1,
    'the back action should cancel deletion and return to session actions');
  assert.equal(await page.evaluate(() => window.__sheetActions.some((action) => action.action === 'delete' && action.sessionId === 's5')), false,
    'cancelling the confirmation must not dispatch deletion');
  await page.locator('.sidebar-action-sheet-close').click();

  await page.evaluate(() => window.ragentOpenSidebarActionSheet(
    'session',
    { id: 's2', name: 'Closing sheet' },
    document.querySelector('#session-anchor'),
  ));
  await page.locator('.sidebar-action-sheet-close').click();
  const closingModalState = await page.evaluate(() => {
    const sheet = document.querySelector('.sidebar-action-sheet');
    const panel = document.querySelector('.sidebar-action-sheet-panel');
    const anchor = document.querySelector('#session-anchor');
    return {
      closing: sheet?.classList.contains('is-closing'),
      bodyLocked: document.body.classList.contains('sidebar-action-sheet-open'),
      anchorInert: anchor?.inert === true,
      sheetPointerEvents: getComputedStyle(sheet).pointerEvents,
      panelPointerEvents: getComputedStyle(panel).pointerEvents,
    };
  });
  assert.equal(closingModalState.closing, true, 'sheet should retain an exit state during close');
  assert.equal(closingModalState.bodyLocked, true, 'background should stay locked through the exit animation');
  assert.equal(closingModalState.anchorInert, true, 'background should stay inert through the exit animation');
  assert.equal(closingModalState.sheetPointerEvents, 'auto', 'the closing layer should continue intercepting pointer events');
  assert.equal(closingModalState.panelPointerEvents, 'none', 'closing sheet controls should not accept duplicate taps');
  await page.waitForTimeout(260);
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0, 'closed sheet should be removed after its exit animation');

  await page.waitForFunction(() => document.querySelectorAll('.sidebar-project-head').length >= 1);
  const renderedProjectHead = page.locator('.sidebar-project-head').first();
  await renderedProjectHead.dispatchEvent('pointerdown', { bubbles: true, button: 0, clientX: 24, clientY: 24 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator('[data-action="delete-project"]').count(), 0,
    'a short touch hold must not open the project action sheet');
  await page.waitForTimeout(1900);
  assert.equal(await page.locator('[data-action="delete-project"]').count(), 0,
    'a project hold past the threshold stays armed only — the sheet must not open while the finger is still down');
  await page.waitForTimeout(600);
  await renderedProjectHead.dispatchEvent('pointerup', { bubbles: true, button: 0, clientX: 24, clientY: 24 });
  assert.equal(await page.locator('[data-action="delete-project"]').count(), 1,
    'a project row long press should open the project action sheet once the finger lifts');
  await page.locator('.sidebar-action-sheet-close').click();

  await page.setViewportSize({ width: 1024, height: 844 });
  await page.evaluate(() => window.__anchor.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerType: 'mouse', clientX: 20, clientY: 20,
  })));
  await page.waitForTimeout(3050);
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'desktop left-button holds must not open the action sheet');
  await page.evaluate(() => window.__anchor.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerType: 'mouse', clientX: 20, clientY: 20,
  })));
  await page.evaluate(() => window.__anchor.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20,
  })));
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 1,
    'desktop right-click must open the action sheet');
  await page.locator('.sidebar-action-sheet-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-action-sheet').length === 0);
  await page.evaluate(() => window.__anchor.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20,
  })));
  assert.equal(await page.locator('.sidebar-action-sheet').count(), 0,
    'desktop non-right-button context menus must not open the action sheet');

  await page.evaluate(() => window.ragentOpenProjectActionSheet(
    { id: 'prj_abcdefabcdef', name: 'Alpha', sessionCount: 2 },
    document.body,
  ));
  assert.equal(await page.locator('[data-action="delete-project"]').count(), 1,
    'project sheet should expose delete');
  await page.locator('[data-action="delete-project"]').click();
  assert.equal(await page.locator('[data-action="delete-all-sessions"]').count(), 1,
    'project deletion should ask how to handle its sessions');
  assert.equal(await page.locator('[data-action="keep-sessions-inbox"]').count(), 1,
    'project deletion should offer moving sessions to the bottom inbox');
  assert.doesNotMatch(await page.locator('.sidebar-action-sheet-panel').innerText(), /\bL1\b/,
    'project deletion copy should not expose internal level names');
  await page.evaluate(() => { window.__projectDeleteMode = 'compat'; });
  await page.evaluate(() => { window.__holdNextProjectRequest = true; });
  await page.locator('[data-action="keep-sessions-inbox"]').click();
  await page.waitForFunction(() => document.querySelector('.sidebar-action-sheet[data-busy="true"]'));
  const busyGeometry = await page.evaluate(() => {
    const header = document.querySelector('.sidebar-action-sheet-header')?.getBoundingClientRect();
    const spinner = document.querySelector('.sidebar-action-sheet-busy-indicator')?.getBoundingClientRect();
    const close = document.querySelector('.sidebar-action-sheet-close')?.getBoundingClientRect();
    return {
      centered: !!header && !!spinner && Math.abs((spinner.top + spinner.height / 2) - (header.top + header.height / 2)) < 12,
      beforeClose: !!spinner && !!close && spinner.right <= close.left,
    };
  });
  assert.equal(busyGeometry.centered, true, 'delete spinner should sit in the action-sheet header row');
  assert.equal(busyGeometry.beforeClose, true, 'delete spinner should stay clear of the close control');
  await page.evaluate(() => window.__releaseProjectRequest?.());
  await page.waitForTimeout(300);
  const keepRequests = await page.evaluate(() => window.__projectRequests.slice(-2));
  assert.equal(keepRequests[0].options.method, 'DELETE',
    'project deletion should try the canonical DELETE endpoint first');
  assert.equal(keepRequests[1].options.method, 'POST',
    'project deletion should retry through the compatibility route after a 404');
  const keepRequest = keepRequests[1];
  assert.equal(JSON.parse(keepRequest.options.body).deleteSessions, false,
    'the keep-sessions choice should send deleteSessions=false');

  console.log('test-chat-sidebar-action-sheet: ok');
} finally {
  await browser.close();
}
