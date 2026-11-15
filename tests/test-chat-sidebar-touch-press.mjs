#!/usr/bin/env node
// Sidebar session-row touch contract (real CSS cascade).
//
// Locks the two mobile fixes for the session list:
//   1. the open session must stay visibly marked — an accent rail plus a thin
//      accent wash that survive the full finish-layer cascade (the finish
//      layer paints active rows with a near-invisible neutral tint);
//   2. a touch hold must read as one continuous gesture: light press wash
//      deepening over the hold, an armed long-press state at the threshold,
//      release restoring the row and only then opening the action surface.
// The full page cascade is loaded in order so a later sheet cannot silently
// eat these cues again.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Same cascade order the page uses: chat.css @imports first, then the later
// <link> sheets (m3 tokens, material-finish, organization) override.
const cssChain = [
  'static/chat/chat-base.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-messages.css',
  'static/chat/right-sidebar.css',
  'static/chat/workspace-file-reader.css',
  'static/chat/chat-input.css',
  'static/chat/chat-run-sheet.css',
  'static/chat/chat-responsive.css',
  'static/chat/custom-select.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-goal-ui.css',
  'static/chat/chat-sheet-actions.css',
  'static/chat/chat-sidebar-motion.css',
  'static/chat/chat-home.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-live-action.css',
  'static/chat/chat-decision-sheet.css',
  'static/chat/chat-attention-popup.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
  'static/chat/account-policy.css',
  'static/chat/cross-device-panel.css',
  'static/chat/chat-operational-surfaces.css',
  'static/chat/chat-material-finish.css',
  'static/chat/chat-organization.css',
];

const surfaceSource = await readFile(join(repoRoot, 'static/chat/session-surface-ui.js'), 'utf8');
const cssSources = await Promise.all(cssChain.map((p) => readFile(join(repoRoot, p), 'utf8')));

// Pull the real binding function out of the module so the test exercises the
// shipped gesture state machine, not a reimplementation.
const bindStart = surfaceSource.indexOf('function bindSidebarLongPress');
const bindEnd = surfaceSource.indexOf('function createActiveSessionItem');
assert.ok(bindStart !== -1 && bindEnd > bindStart, 'bindSidebarLongPress should exist in session-surface-ui.js');
const bindSource = surfaceSource.slice(bindStart, bindEnd);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  ${cssSources.join('\n')}
  body { margin: 0; }
</style></head><body>
<div class="sidebar-overlay open" id="sidebarOverlay">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-session-surface" id="sidebarSessionSurface">
      <div class="sidebar-list" id="sessionList"></div>
    </div>
  </aside>
</div>
</body></html>`);

await page.evaluate((source) => {
  (0, eval)(source);
}, bindSource);

await page.evaluate(() => {
  const makeRow = (name, { active = false } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-item' + (active ? ' active' : '');
    button.innerHTML = `
      <span class="session-item-info"><span class="session-item-name">${name}</span></span>
      <time class="session-item-time">12:00</time>
      <span class="session-item-status" aria-hidden="true"></span>`;
    document.getElementById('sessionList').appendChild(button);
    return button;
  };
  const plain = makeRow('Retro notebook');
  const selected = makeRow('Open session', { active: true });
  window.__rows = { plain, selected };
  window.__opened = 0;
  window.ragentBindSidebarLongPress(plain, () => { window.__opened += 1; });
  window.ragentBindSidebarLongPress(selected, () => { window.__opened += 1; });
});

const stateOf = (row) => page.evaluate((key) => {
  const el = window.__rows[key];
  const after = getComputedStyle(el, '::after');
  const before = getComputedStyle(el, '::before');
  return {
    pressing: el.classList.contains('is-pressing'),
    armed: el.classList.contains('is-long-press'),
    washOpacity: Number(after.opacity),
    railWidth: before.width,
    railVisible: before.content !== 'none' && Number.parseFloat(before.width) > 0,
  };
}, row);

// 1. Selected row keeps an unmistakable marker through the full cascade.
const selectedRest = await stateOf('selected');
const plainRest = await stateOf('plain');
assert.equal(selectedRest.railVisible, true, 'the open session must keep its accent rail');
assert.ok(Number.parseFloat(selectedRest.railWidth) >= 3, 'the selected rail should be visible, not hairline');
assert.ok(selectedRest.washOpacity >= 0.08, `selected row must keep a visible accent wash, got ${selectedRest.washOpacity}`);
assert.equal(plainRest.washOpacity, 0, 'unselected rows must not carry the selected wash');
assert.equal(plainRest.railVisible, false, 'unselected rows must not show the rail');

// 2. Touch hold: light press wash deepens across the hold.
await page.evaluate(() => {
  window.__rows.plain.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20,
  }));
});
await page.waitForTimeout(1000);
const midPress = await stateOf('plain');
assert.equal(midPress.pressing, true, 'pointerdown should mark the row as pressing');
assert.ok(midPress.washOpacity > 0 && midPress.washOpacity < 0.07,
  `the press wash should be mid-ramp at 1s of the 2s hold, got ${midPress.washOpacity}`);

// 3. Threshold arms the row (deeper wash) but opens nothing while held.
await page.waitForTimeout(1200);
const armed = await stateOf('plain');
assert.equal(armed.pressing, false, 'threshold should swap the press wash for the armed wash');
assert.equal(armed.armed, true, 'reaching the threshold should arm the long press');
assert.ok(armed.washOpacity > midPress.washOpacity, 'the armed wash must read deeper than the press wash');
assert.equal(await page.evaluate(() => window.__opened), 0,
  'arming must not open the action surface while the finger is still down');

// 4. Lift restores the row, then the action surface opens.
await page.evaluate(() => {
  window.__rows.plain.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20,
  }));
});
assert.equal(await page.evaluate(() => window.__opened), 1,
  'lifting an armed hold should open the action surface');
await page.waitForTimeout(260); // let the restore fade (160ms) finish
const released = await stateOf('plain');
assert.equal(released.pressing, false, 'release should clear the press state');
assert.equal(released.armed, false, 'release should clear the armed state');
assert.equal(released.washOpacity, 0, 'release should restore the row to its original look');

// 5. A quick tap never opens the surface.
await page.evaluate(() => {
  const row = window.__rows.plain;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20 }));
  setTimeout(() => row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20 })), 90);
});
await page.waitForTimeout(700);
assert.equal(await page.evaluate(() => window.__opened), 1, 'a tap must not open the action surface');
assert.equal((await stateOf('plain')).washOpacity <= 0.07, true, 'a tap must leave no long-press wash behind');

// 6. Scroll-scale drift during the hold cancels the gesture.
await page.evaluate(() => {
  const row = window.__rows.plain;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20 }));
  setTimeout(() => row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerType: 'touch', clientX: 52, clientY: 22 })), 60);
});
await page.waitForTimeout(700);
const drifted = await stateOf('plain');
assert.equal(drifted.armed, false, 'a scroll-scale drift must cancel the long press');
assert.equal(drifted.washOpacity, 0, 'a cancelled hold must restore the row');
await page.evaluate(() => {
  window.__rows.plain.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch', clientX: 52, clientY: 22 }));
});
assert.equal(await page.evaluate(() => window.__opened), 1, 'a cancelled hold must not open the action surface');

// 7. Platform pan guard: in-tolerance drift must block the pan (non-passive
// touchmove) or phones cancel the two-second hold with pointercancel before
// the threshold. Verified on a real Android Chrome input pipeline. Runs on a
// touch-enabled page so the Touch constructor exists; the touch emulation
// flips pointer media queries and would desync the visual assertions above.
const touchPage = await (await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true,
})).newPage();
await touchPage.setContent('<!doctype html><html><body><button class="session-item" id="row">row</button></body></html>');
await touchPage.evaluate((source) => {
  (0, eval)(source);
}, bindSource);
const panGuard = await touchPage.evaluate(() => {
  const row = document.getElementById('row');
  window.ragentBindSidebarLongPress(row, () => {});
  row.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20,
  }));
  const touch = (x, y) => new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
  const move = (x, y) => {
    const event = new TouchEvent('touchmove', {
      bubbles: true, cancelable: true, touches: [touch(x, y)],
    });
    row.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const inTolerance = move(24, 26);
  const pressing = row.classList.contains('is-pressing');
  const pastTolerance = move(52, 22);
  row.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerType: 'touch', clientX: 52, clientY: 22,
  }));
  return { inTolerance, pastTolerance, pressing };
});
// touchPage stays open for section 8 below.
assert.equal(panGuard.inTolerance, true,
  'in-tolerance hold drift must preventDefault the platform pan or the hold dies with pointercancel on phones');
assert.equal(panGuard.pastTolerance, false,
  'movement past the tolerance must release the pan so the list scrolls as usual');
assert.equal(panGuard.pressing, true,
  'an in-tolerance drifting hold must stay alive (the platform must not claim the pan)');

// 8. Armed hold vs. the platform pan claim: the guard must keep blocking the
// pan after the threshold, and if the platform still ends the gesture with a
// cancel (slow drift crossing slop right after arming), that cancel must open
// the sheet like a lift — pointerup never arrives after a pointercancel.
await touchPage.setContent('<!doctype html><html><body><button class="session-item" id="row">row</button></body></html>');
await touchPage.evaluate((source) => {
  (0, eval)(source);
}, bindSource);
const armedHold = await touchPage.evaluate(async () => {
  const row = document.getElementById('row');
  let opened = 0;
  window.ragentBindSidebarLongPress(row, () => { opened += 1; });
  row.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerType: 'touch', clientX: 20, clientY: 20,
  }));
  await new Promise((resolve) => setTimeout(resolve, 2150));
  const armed = row.classList.contains('is-long-press');
  const move = new TouchEvent('touchmove', {
    bubbles: true, cancelable: true,
    touches: [new Touch({ identifier: 1, target: row, clientX: 24, clientY: 26 })],
  });
  row.dispatchEvent(move);
  const guardedAfterArm = move.defaultPrevented;
  row.dispatchEvent(new Event('pointercancel', { bubbles: true }));
  return { armed, guardedAfterArm, opened };
});
assert.equal(armedHold.armed, true, 'the hold should arm after the threshold');
assert.equal(armedHold.guardedAfterArm, true,
  'the pan guard must stay alive after arming or the platform claims the pan mid-hold');
assert.equal(armedHold.opened, 1,
  'a cancel after an armed hold must open the sheet (pointerup never fires after pointercancel)');

await touchPage.context().close();
await browser.close();
console.log('sidebar touch press contract: PASS');
