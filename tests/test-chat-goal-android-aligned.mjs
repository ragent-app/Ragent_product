#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const goalCss = readFileSync(join(repoRoot, 'static/chat/chat-goal-ui.css'), 'utf8');
const goalSource = readFileSync(join(repoRoot, 'static/chat/goal-ui.js'), 'utf8');
const iconsSource = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');

// Assertions on source code
assert.match(iconsSource, /"target-arrow":/, 'icons.js must include target-arrow icon');
assert.match(iconsSource, /play:\s*'<path/, 'icons.js must include play icon');
assert.match(iconsSource, /pause:\s*'<path/, 'icons.js must include pause icon');

assert.match(goalCss, /\.composer-goal-pill/, 'CSS must include .composer-goal-pill rules');
assert.match(goalCss, /\.goal-play-pause-btn/, 'CSS must include .goal-play-pause-btn rules');
assert.match(goalCss, /\.goal-header-icon-badge/, 'CSS must include .goal-header-icon-badge rules');
assert.match(goalCss, /\.goal-modal-status-row/, 'CSS must include .goal-modal-status-row rules');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

await page.setContent(`<!doctype html>
  <style>
    ${goalCss}
    .modal-backdrop[hidden] { display: none !important; }
    .modal-backdrop { position: fixed; inset: 0; display: flex; opacity: 0; }
    .modal-backdrop.is-open { opacity: 1; }
    .modal-backdrop.is-closing { opacity: 0; }
  </style>
  <div class="composer-actions">
    <button class="composer-goal-pill" id="composerGoalPill" type="button" hidden>
      <span class="composer-goal-pill-icon" data-icon="target-arrow" aria-hidden="true"></span>
      <span class="composer-goal-pill-text" id="composerGoalPillText"></span>
    </button>
  </div>
  <div id="composerAddMenu">
    <button class="composer-add-menu-item" id="composerGoalMenuItem" type="button" role="menuitemcheckbox" aria-checked="false">
      <span class="composer-add-menu-icon" data-icon="target-arrow"></span>
      <span class="composer-add-menu-main">Session goal</span>
      <span class="composer-add-menu-note" id="composerGoalMenuNote">Set a tracked objective</span>
      <span class="composer-add-menu-check" data-icon="check"></span>
    </button>
  </div>
  <div class="modal-backdrop" id="goalSheet" hidden>
    <div class="modal">
      <div class="modal-header">
        <div class="goal-header-title-group">
          <div class="goal-header-icon-badge"><span data-icon="target-arrow"></span></div>
          <h2 class="modal-title" id="goalSheetTitle">Session goal</h2>
        </div>
        <button id="goalSheetClose" type="button">Close</button>
      </div>
      <div class="modal-body">
        <div class="goal-input-action-row">
          <div class="goal-objective-field">
            <textarea id="goalObjectiveInput"></textarea>
          </div>
          <button class="goal-play-pause-btn is-play" id="goalPlayPauseBtn" type="button">
            <span id="goalPlayPauseIcon" data-icon="play"></span>
          </button>
        </div>
        <div class="goal-modal-status-row" id="goalModalStatusRow" data-tone="idle">
          <span class="goal-modal-status-dot" id="goalModalStatusDot"></span>
          <span class="goal-modal-status-text" id="goalModalStatusText"></span>
        </div>
        <input id="goalTokenBudgetInput" type="hidden">
        <input id="goalEnabledInput" type="checkbox" checked hidden>
        <div id="goalStatusDisplay" hidden></div>
      </div>
      <div class="goal-sheet-footer">
        <button id="goalSheetClear" type="button">Clear</button>
        <button id="goalSheetSave" type="button">Save</button>
      </div>
    </div>
  </div>`);

await page.addScriptTag({ path: join(repoRoot, 'static/chat/icons.js') });
await page.addScriptTag({ path: join(repoRoot, 'static/chat/motion.js') });
await page.evaluate(() => {
  window.setComposerAddMenuOpen = (open) => {
    const menu = document.getElementById('composerAddMenu');
    menu.hidden = open !== true;
  };
  window.ragentGetSelectedToolDefinition = () => ({
    id: 'codex',
    runtimeFamily: 'codex-app-server-json',
  });
});
await page.addScriptTag({ path: join(repoRoot, 'static/chat/i18n.js') });
await page.addScriptTag({ path: join(repoRoot, 'static/chat/goal-ui.js') });

await page.evaluate(() => {
  globalThis.currentSessionId = 'session-android-aligned';
  window.updateSessionRecord = async (sessionId, payload) => {
    window.__lastUpdatedSession = { sessionId, payload };
    const session = { id: sessionId, goal: payload.goal };
    window.updateGoalChip(session);
    return session;
  };
});

// Initially no goal: inline pill is hidden
assert.equal(await page.locator('#composerGoalPill').isHidden(), true, 'composerGoalPill should initially be hidden');

// Arm pending goal via menu item click
await page.locator('#composerGoalMenuItem').click();

// Verify inline goal pill appears in armed/pending state
assert.equal(await page.locator('#composerGoalPill').isVisible(), true, 'composerGoalPill should be visible when armed');
const pillState = await page.locator('#composerGoalPill').evaluate((el) => ({
  state: el.dataset.state,
  empty: el.dataset.empty,
  title: el.title,
  text: document.getElementById('composerGoalPillText').textContent,
  width: el.getBoundingClientRect().width,
  height: el.getBoundingClientRect().height,
}));
assert.equal(pillState.state, 'pending', 'pill should have pending state');
assert.equal(pillState.empty, 'true', 'pill should have empty=true when pending with no text');
assert.equal(pillState.width, 30, 'pill width should be 30px capsule/circle when empty');
assert.equal(pillState.height, 30, 'pill height should be 30px');

// Verify icon is mathematically centered in the 30px circle
const centering = await page.locator('#composerGoalPill').evaluate((pill) => {
  const pillRect = pill.getBoundingClientRect();
  const iconSpan = pill.querySelector('.composer-goal-pill-icon');
  const iconRect = iconSpan.getBoundingClientRect();
  const circle = pill.querySelector('circle');
  const circleRect = circle ? circle.getBoundingClientRect() : null;
  return {
    leftOffset: iconRect.left - pillRect.left,
    rightOffset: pillRect.right - iconRect.right,
    topOffset: iconRect.top - pillRect.top,
    bottomOffset: pillRect.bottom - iconRect.bottom,
    circleCenterX: circleRect ? circleRect.left + circleRect.width / 2 : 0,
    circleCenterY: circleRect ? circleRect.top + circleRect.height / 2 : 0,
    pillCenterX: pillRect.left + pillRect.width / 2,
    pillCenterY: pillRect.top + pillRect.height / 2,
  };
});
assert.equal(centering.leftOffset, centering.rightOffset, 'icon must be horizontally centered');
assert.equal(centering.topOffset, centering.bottomOffset, 'icon must be vertically centered');
assert.equal(centering.circleCenterX, centering.pillCenterX, 'bullseye dot must be centered horizontally');
assert.equal(centering.circleCenterY, centering.pillCenterY, 'bullseye dot must be centered vertically');

// Verify menu item checked state
const menuItemState = await page.locator('#composerGoalMenuItem').evaluate((el) => ({
  checked: el.getAttribute('aria-checked'),
  hasActiveClass: el.classList.contains('active'),
  note: document.getElementById('composerGoalMenuNote').textContent,
}));
assert.equal(menuItemState.checked, 'true', 'menu item should be checked when armed');
assert.equal(menuItemState.hasActiveClass, true, 'menu item should have active class');
assert.match(menuItemState.note, /Goal mode armed/, 'menu note should indicate armed');

// Click inline goal pill to open modal sheet
await page.locator('#composerGoalPill').click();
assert.equal(await page.locator('#goalSheet').isVisible(), true, 'clicking pill should open goalSheet');

// Verify bottom-left clear/turn-off button exists, is visible and says "关闭目标模式"
const clearBtnState = await page.locator('#goalSheetClear').evaluate((el) => {
  const rect = el.getBoundingClientRect();
  const saveRect = document.getElementById('goalSheetSave').getBoundingClientRect();
  return {
    hidden: el.hidden,
    visible: window.getComputedStyle(el).display !== 'none',
    text: el.textContent.trim(),
    i18n: el.getAttribute('data-i18n'),
    isLeftOfSave: rect.left < saveRect.left,
  };
});
assert.equal(clearBtnState.hidden, false, 'clear/turn-off button must not be hidden when goal is empty');
assert.equal(clearBtnState.visible, true, 'clear/turn-off button must be visible');
assert.equal(clearBtnState.i18n, 'goal.turnOff', 'button should use goal.turnOff key when goal is empty');
assert.ok(clearBtnState.isLeftOfSave, 'clear/turn-off button must be on the left side of footer (bottom-left)');

// Click "Turn off goal mode": should disarm goal mode and close sheet immediately
await page.locator('#goalSheetClear').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'sheet should close after turning off goal mode');
assert.equal(await page.locator('#composerGoalPill').isHidden(), true, 'composerGoalPill should be hidden after turning off goal mode');
const disarmedMenuItemState = await page.locator('#composerGoalMenuItem').evaluate((el) => ({
  checked: el.getAttribute('aria-checked'),
  hasActiveClass: el.classList.contains('active'),
}));
assert.equal(disarmedMenuItemState.checked, 'false', 'menu item should be unchecked after turning off goal mode');
assert.equal(disarmedMenuItemState.hasActiveClass, false, 'menu item should not have active class after turning off goal mode');

// Re-arm pending goal via menu item click
await page.locator('#composerAddMenu').evaluate((el) => { el.hidden = false; });
await page.locator('#composerGoalMenuItem').click();
assert.equal(await page.locator('#composerGoalPill').isVisible(), true, 'composerGoalPill should reappear when armed');
await page.locator('#composerGoalPill').click();
assert.equal(await page.locator('#goalSheet').isVisible(), true, 'reopening goalSheet');

// Verify 48px play/pause button exists and has is-play class
const playBtnState = await page.locator('#goalPlayPauseBtn').evaluate((el) => ({
  isPlay: el.classList.contains('is-play'),
  width: el.getBoundingClientRect().width,
  height: el.getBoundingClientRect().height,
  title: el.title,
}));
assert.equal(playBtnState.isPlay, true, 'button should have is-play');
assert.equal(playBtnState.width, 48, 'button width must be 48px');
assert.equal(playBtnState.height, 48, 'button height must be 48px');

// Verify modal status row in empty state
const statusState = await page.locator('#goalModalStatusRow').evaluate((el) => ({
  tone: el.dataset.tone,
  text: document.getElementById('goalModalStatusText').textContent,
}));
assert.equal(statusState.tone, 'idle');
assert.match(statusState.text, /未设定目标/);

// Type objective into input
await page.locator('#goalObjectiveInput').fill('重构前端页面并完成测试');

// Check modal status row updates to ready tone
const updatedStatus = await page.locator('#goalModalStatusRow').evaluate((el) => ({
  tone: el.dataset.tone,
  text: document.getElementById('goalModalStatusText').textContent,
}));
assert.equal(updatedStatus.tone, 'ready');
assert.match(updatedStatus.text, /目标已就绪/);

// Click play button: should trigger auto-continue save and close sheet
await page.locator('#goalPlayPauseBtn').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'sheet should close after starting auto-continue');

// Verify updated pill shows text
const activePill = await page.locator('#composerGoalPill').evaluate((el) => ({
  state: el.dataset.state,
  empty: el.dataset.empty,
  text: document.getElementById('composerGoalPillText').textContent,
  width: el.getBoundingClientRect().width,
}));
assert.equal(activePill.state, 'active');
assert.equal(activePill.empty, 'false');
assert.match(activePill.text, /重构前端页面/);
assert.ok(activePill.width > 30, 'active pill should expand to show objective text');

// Reopen sheet to verify pause state and clear goal button
await page.locator('#composerGoalPill').click();
assert.equal(await page.locator('#goalSheet').isVisible(), true);
const chasingState = await page.locator('#goalPlayPauseBtn').evaluate((el) => ({
  isPause: el.classList.contains('is-pause'),
  title: el.title,
}));
assert.equal(chasingState.isPause, true, 'active chasing should show pause button');

// Verify clear button now uses goal.clear ("清除目标")
const activeClearBtnState = await page.locator('#goalSheetClear').evaluate((el) => ({
  hidden: el.hidden,
  i18n: el.getAttribute('data-i18n'),
  text: el.textContent.trim(),
}));
assert.equal(activeClearBtnState.hidden, false, 'clear button should be visible when goal is active');
assert.equal(activeClearBtnState.i18n, 'goal.clear', 'button should use goal.clear key when goal is active');

// Accept confirm dialog and click clear
page.on('dialog', (dialog) => dialog.accept());
await page.locator('#goalSheetClear').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'sheet should close after clearing goal');
assert.equal(await page.locator('#composerGoalPill').isHidden(), true, 'composerGoalPill should be hidden after clearing goal');

await browser.close();
console.log('test-chat-goal-android-aligned: ok');
