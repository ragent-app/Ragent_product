#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const goalCss = readFileSync(join(repoRoot, 'static/chat/chat-goal-ui.css'), 'utf8');
const goalSource = readFileSync(join(repoRoot, 'static/chat/goal-ui.js'), 'utf8');
const composerSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
assert.match(goalCss, /#goalSheet \.modal[\s\S]*background:\s*var\(--sys-surface-container\)/, 'Goal sheet should use the M3 surface-container role');
assert.match(goalCss, /\.goal-chip:has\(\.goal-chip-dot\[data-tone="working"\]\)[\s\S]*--goal-chip-bg:\s*var\(--sys-primary-container\)/, 'Goal chip should map working state to the M3 primary container');
assert.match(goalCss, /\.provider-helper-field input[\s\S]*background:\s*var\(--sys-surface-container-high\)/, 'Goal fields should use the M3 filled-field surface');
assert.match(goalCss, /#goalSheet\s*\{[\s\S]*align-items:\s*flex-end/, 'Goal sheet should use a bottom-sheet layout on mobile');
assert.match(goalCss, /#goalSheet \.goal-sheet-footer[\s\S]*min-height:\s*52px/, 'Goal sheet actions should meet the prominent mobile touch target');
assert.match(composerSource, /adoptPendingGoalFromMessage\(sessionId, outboundText\)/, 'the first sent message should adopt a pending goal');
assert.match(goalSource, /chasing:\s*true/, 'pending goal adoption should default auto-continue on');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.setContent(`<!doctype html>
  <style>
    .modal-backdrop[hidden] { display: none !important; }
    .modal-backdrop { position: fixed; inset: 0; display: flex; opacity: 0; }
    .modal-backdrop.is-open { opacity: 1; }
    .modal-backdrop.is-closing { opacity: 0; }
  </style>
  <button class="composer-goal-pill" id="composerGoalPill" type="button" hidden>
    <span class="composer-goal-pill-icon" data-icon="target-arrow"></span>
    <span class="composer-goal-pill-text" id="composerGoalPillText"></span>
  </button>
  <div id="composerAddMenu"><button id="composerGoalMenuItem" type="button">Goal</button></div>
  <div class="modal-backdrop" id="goalSheet" hidden>
    <div class="modal">
      <button id="goalSheetClose" type="button">Close</button>
      <textarea id="goalObjectiveInput"></textarea>
      <input id="goalTokenBudgetInput" type="number">
      <input id="goalEnabledInput" type="checkbox" checked>
      <div id="goalStatusDisplay"></div>
      <div id="goalChaseRow" hidden><span id="goalChaseStatus"></span><button id="goalChaseToggleBtn" type="button"></button></div>
      <button id="goalSheetSave" type="button">Save</button>
      <button id="goalSheetClear" type="button">Clear</button>
    </div>
  </div>`);

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
await page.addScriptTag({ path: join(repoRoot, 'static/chat/goal-ui.js') });

await page.evaluate(() => {
  globalThis.currentSessionId = 'session-pending';
  window.updateSessionRecord = async (sessionId, payload) => {
    window.__goalUpdate = { sessionId, payload };
    const session = { id: sessionId, goal: payload.goal };
    window.updateGoalChip(session);
    return session;
  };
  document.getElementById('composerGoalMenuItem').click();
});
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'initial goal setup should not open the configuration sheet');
assert.deepEqual(await page.locator('#composerGoalPill').evaluate((node) => ({ hidden: node.hidden, state: node.dataset.state, empty: node.dataset.empty })), { hidden: false, state: 'pending', empty: 'true' }, 'initial goal setup should show the composer goal pill');
assert.equal(await page.locator('#goalChaseRow').isHidden(), true, 'auto-continue should stay hidden while the goal is empty');
await page.locator('#composerGoalPill').click();
assert.equal(await page.locator('#goalSheet').isVisible(), true, 'the pending pill should still open the optional configuration panel');
await page.locator('#goalSheetSave').click();
await page.waitForTimeout(180);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'saving an empty pending goal should close the panel');
assert.equal(await page.locator('#goalChaseRow').isHidden(), true, 'empty pending goal should keep auto-continue hidden');
const adopted = await page.evaluate(async () => {
  await window.adoptPendingGoalFromMessage('session-pending', '整理这批文件');
  return {
    update: window.__goalUpdate,
    pillText: document.getElementById('composerGoalPillText').textContent,
    pillEmpty: document.getElementById('composerGoalPill').dataset.empty,
    chaseVisible: !document.getElementById('goalChaseRow').hidden,
    chaseAction: document.getElementById('goalChaseToggleBtn').dataset.action,
    sheetObjective: document.getElementById('goalObjectiveInput').value,
  };
});
assert.equal(adopted.update.payload.goal.chasing, true, 'adopted goal should default auto-continue on');
assert.equal(adopted.pillText, '整理这批文件', 'the composer goal pill should mirror the adopted message');
assert.equal(adopted.pillEmpty, 'false', 'pill empty attribute should be false once adopted');
assert.equal(adopted.chaseVisible, true, 'auto-continue should return after adoption');
assert.equal(adopted.chaseAction, 'pause', 'active auto-continue should offer pause');
assert.equal(adopted.sheetObjective, '整理这批文件', 'the panel should sync the adopted message');
await page.locator('#composerAddMenu').evaluate((node) => { node.hidden = false; });

assert.equal(
  await page.locator('#composerGoalMenuItem').isHidden(),
  false,
  'Goal menu item should be visible for Codex',
);

await page.evaluate(() => {
  window.ragentGetSelectedToolDefinition = () => ({
    id: 'claude-bidi',
    name: 'Claude Code',
    runtimeFamily: 'claude-stream-json',
  });
  window.syncGoalMenuVisibility();
});
assert.equal(
  await page.locator('#composerGoalMenuItem').isHidden(),
  true,
  'Goal menu item should disappear for Claude Code',
);
assert.equal(
  await page.locator('#composerGoalMenuItem').getAttribute('aria-hidden'),
  'true',
  'hidden Goal menu item should be removed from the accessibility tree',
);

await page.evaluate(() => {
  window.ragentGetSelectedToolDefinition = () => ({
    id: 'codex',
    runtimeFamily: 'codex-app-server-json',
  });
  window.syncGoalMenuVisibility();
});
assert.equal(
  await page.locator('#composerGoalMenuItem').isHidden(),
  false,
  'Goal menu item should reappear when switching back to Codex',
);

const result = await page.evaluate(() => {
  window.updateGoalChip({
    goal: { objective: 'Clean up imports', tokenBudget: 25000, status: 'in_progress', chasing: true, enabled: true },
  });
  document.getElementById('composerGoalPill').click();
  return {
    sheetHiddenImmediately: document.getElementById('goalSheet').hidden,
    objective: document.getElementById('goalObjectiveInput').value,
  };
});

assert.equal(result.sheetHiddenImmediately, false, 'clicking the goal pill should show the sheet');
assert.equal(result.objective, 'Clean up imports', 'opening the sheet should populate the current goal');
assert.equal(await page.locator('#goalChaseRow').isHidden(), false, 'active goal chasing should expose its control row');
assert.equal(await page.locator('#goalChaseToggleBtn').getAttribute('data-action'), 'pause', 'active chasing should offer pause');
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
assert.match(
  await page.locator('#goalSheet').getAttribute('class'),
  /\bis-open\b/,
  'goal sheet should enter the visible modal state',
);
assert.equal(
  await page.locator('#goalSheet').evaluate((el) => getComputedStyle(el).opacity),
  '1',
  'visible goal sheet should not remain transparent',
);

await page.locator('#goalSheetClose').click();
await page.waitForTimeout(180);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'close should hide the goal sheet');
assert.equal(await page.evaluate(() => document.activeElement?.id), 'composerGoalPill', 'closing should restore focus to the opening pill');

await page.locator('#composerAddMenu').evaluate((el) => { el.hidden = false; });
await page.locator('#composerGoalMenuItem').click();
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
assert.equal(await page.locator('#composerAddMenu').getAttribute('hidden'), '', 'goal menu action should close the add menu');
assert.equal(await page.locator('#goalSheet').isVisible(), true, 'goal menu action should open the goal sheet');
await page.keyboard.press('Escape');
await page.waitForTimeout(180);
assert.equal(await page.locator('#goalSheet').getAttribute('hidden'), '', 'Escape should close the goal sheet');

await browser.close();
console.log('test-chat-goal-ui: ok');
