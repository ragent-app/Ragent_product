#!/usr/bin/env node
// L1 device bar regression: the current-device button + add-device action
// under the sidebar brand. Loads the real device-bar.js + icons.js modules,
// then asserts:
//   - the bar is visible on the L1 projects level and hidden at L2
//   - it hides whenever the app bar hides (search mode / subpages)
//   - the device name is populated from the stub API (backend not wired yet)
//   - add-device click routes through the cross-device workspace register view
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('../', import.meta.url);
const styles = [
  'static/chat/chat-base.css',
  'static/chat/custom-select.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
];
const css = (await Promise.all(styles.map((p) => readFile(new URL(p, repoRoot), 'utf8')))).join('\n');
const sources = {
  icons: await readFile(new URL('static/chat/icons.js', repoRoot), 'utf8'),
  deviceBar: await readFile(new URL('static/chat/device-bar.js', repoRoot), 'utf8'),
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><body>
    <div id="sidebarAppBar">
      <div class="sidebar-brand">Ragent</div>
    </div>
    <div class="sidebar-device-bar" id="sidebarDeviceBar" hidden>
      <button class="sidebar-device-name-btn" id="sidebarDeviceNameBtn" type="button" data-i18n-title="sidebar.device.switch" data-i18n-aria-label="sidebar.device.switch">
        <span class="sidebar-device-name-icon" data-icon="monitor" aria-hidden="true"></span>
        <span class="sidebar-device-name-text" id="sidebarDeviceNameText"></span>
        <span class="sidebar-device-name-chevron" data-icon="chevron-down" aria-hidden="true"></span>
      </button>
      <button class="sidebar-device-add-btn" id="sidebarDeviceAddBtn" type="button" data-i18n-title="sidebar.device.add" data-i18n-aria-label="sidebar.device.add" data-icon="monitor-plus"></button>
    </div>
    <div id="sidebarSessionSurface" style="position:relative;width:390px;height:600px;overflow:hidden;">
      <div class="sidebar-projects-view" id="projectsView"></div>
      <div id="sessionList"></div>
    </div>
    <div id="sidebarProjectHeader" hidden></div>
    <button id="sidebarAgentBtn"></button>
    <button id="newSessionBtn"><span class="sidebar-new-chat-icon"></span><span></span></button>
  </body></html>`);
  await page.addStyleTag({ content: css });

  await page.evaluate((src) => {
    window.FILTER_ALL_VALUE = '__all__';
    window.marked = { use: () => {} };
    window.ragentT = (key) => ({
      'sidebar.device.localName': 'This device',
      'sidebar.device.comingSoon': 'Device management is coming soon.',
      'sidebar.projects.newProject': 'New project',
      'nav.sessions': 'Sessions',
    }[key] ?? key);
    window.renderUiIcon = () => '';
    const toasts = [];
    window.showSystemToast = (message, level) => toasts.push({ message, level });
    window.__toasts = toasts;
    window.RagentCrossDevicePanel = {
      open(options) {
        window.__crossDeviceOpen = options;
        return true;
      },
    };
    window.getSidebarViewLevel = () => window.__level || 'projects';
    window.ragentProjectsReady = Promise.resolve();
    window.getActiveSidebarTabValue = () => 'sessions';
    window.sidebarSearchMode = false;
    window.sessionSearchQuery = '';
    window.sidebarSessionSearchHeading = document.createElement('div');
    window.sidebarAgentSearchResults = document.createElement('div');
    window.sessionList = document.getElementById('sessionList');
    window.sidebarAgentBtn = document.getElementById('sidebarAgentBtn');
    window.newSessionBtn = document.getElementById('newSessionBtn');
    window.sessionStateModel = {
      createEmptyStatus: () => ({}),
      normalizeSessionActivity: (activity) => activity || {},
      isSessionBusy: () => false,
      getSessionStatusSummary: () => ({ primary: 'idle' }),
      getSessionVisualStatus: () => 'idle',
      getSessionSortTime: (session) => session?.sortTime || 0,
      compareSessionListSessions: (a, b) => (b?.sortTime || 0) - (a?.sortTime || 0),
    };
    window.sessions = [];
    window.hasLoadedSessions = false;
    window.archivedSessionCount = 0;
    window.currentSessionId = '';
    (0, eval)(src.icons);
    (0, eval)(src.deviceBar);
  }, sources);

  // Icons hydrated by icons.js (data-icon -> inline SVG).
  const iconState = await page.evaluate(() => ({
    monitor: !!document.querySelector('#sidebarDeviceNameBtn .sidebar-device-name-icon svg'),
    monitorPlus: !!document.querySelector('#sidebarDeviceAddBtn svg'),
    addIconPaths: Array.from(document.querySelectorAll('#sidebarDeviceAddBtn svg path')).map((p) => p.getAttribute('d') || ''),
  }));
  assert.equal(iconState.monitor, true, 'device name button should render the monitor icon');
  assert.equal(iconState.monitorPlus, true, 'add-device button should render the monitor-plus icon');
  assert.ok(
    iconState.addIconPaths.some((d) => /M16 8v4/.test(d)),
    'monitor-plus should include the plus inside the screen',
  );

  // L1 default: bar visible, name populated from the stub API.
  let state = await page.evaluate(() => ({
    hidden: document.getElementById('sidebarDeviceBar').hidden,
    name: document.getElementById('sidebarDeviceNameText').textContent,
    nameBtnTitle: document.getElementById('sidebarDeviceNameBtn').getAttribute('data-i18n-title'),
    addTitle: document.getElementById('sidebarDeviceAddBtn').getAttribute('data-i18n-title'),
    addBtnSize: document.getElementById('sidebarDeviceAddBtn').getBoundingClientRect().height,
    nameBtnSize: document.getElementById('sidebarDeviceNameBtn').getBoundingClientRect().height,
  }));
  assert.equal(state.hidden, false, 'device bar should be visible on the L1 projects level');
  assert.equal(state.name, 'This device', 'device name should come from the stub API');
  assert.equal(state.nameBtnTitle, 'sidebar.device.switch', 'device button should carry its i18n title');
  assert.equal(state.addTitle, 'sidebar.device.add', 'add button should carry its i18n title');
  assert.ok(state.addBtnSize >= 44, `add-device button must keep the 44px touch contract (got ${state.addBtnSize}px)`);
  assert.ok(state.nameBtnSize >= 44, `device-name button must keep the 44px touch contract (got ${state.nameBtnSize}px)`);

  // Add-device click opens the owner-side registration view.
  await page.evaluate(() => {
    window.RagentDeviceBar.addDevice().then((result) => { window.__addResult = result; });
  });
  await page.waitForFunction(() => window.__addResult !== undefined);
  const addResult = await page.evaluate(() => window.__addResult);
  assert.deepEqual(addResult, { ok: true }, 'addDevice should open the cross-device workspace');
  assert.deepEqual(await page.evaluate(() => window.__crossDeviceOpen), { view: 'register' }, 'addDevice should open registration');

  await page.evaluate(() => {
    window.RagentDeviceBar.openDeviceManager().then((result) => { window.__managerResult = result; });
  });
  await page.waitForFunction(() => window.__managerResult !== undefined);
  assert.deepEqual(await page.evaluate(() => window.__managerResult), { ok: true }, 'openDeviceManager should open the workspace');
  assert.deepEqual(await page.evaluate(() => window.__crossDeviceOpen), { view: 'devices' }, 'device name should open the device list');

  // L2 (project sessions): bar hides.
  await page.evaluate(() => { window.__level = 'project-sessions'; window.syncSidebarDeviceBar(); });
  state = await page.evaluate(() => ({
    hidden: document.getElementById('sidebarDeviceBar').hidden,
  }));
  assert.equal(state.hidden, true, 'device bar should hide on the L2 project-sessions level');

  // Back to L1: bar returns.
  await page.evaluate(() => { window.__level = 'projects'; window.syncSidebarDeviceBar(); });
  state = await page.evaluate(() => ({
    hidden: document.getElementById('sidebarDeviceBar').hidden,
  }));
  assert.equal(state.hidden, false, 'device bar should return when back on the L1 projects level');

  // App bar hidden (search mode / subpage): bar hides with it.
  await page.evaluate(() => {
    document.getElementById('sidebarAppBar').hidden = true;
    window.syncSidebarDeviceBar();
  });
  state = await page.evaluate(() => ({
    hidden: document.getElementById('sidebarDeviceBar').hidden,
  }));
  assert.equal(state.hidden, true, 'device bar should hide when the app bar hides (search/subpage)');

  await page.screenshot({ path: '/tmp/device-bar-l1.png' });
  console.log('test-chat-device-bar: ok');
} finally {
  await browser.close();
}
