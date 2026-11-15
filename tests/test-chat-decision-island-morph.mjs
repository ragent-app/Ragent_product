#!/usr/bin/env node
// Test for Decision Sheet <-> Dynamic Island morphing lifecycle and Live Bar decoupling.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [decisionSheetSource, backHandlerSource, storeSource] = await Promise.all([
  readFile(join(repoRoot, 'static/chat/decision-sheet.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/back-handler.js'), 'utf8'),
  readFile(join(repoRoot, 'static/chat/decisions-store.js'), 'utf8'),
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div id="liveBar" class="live-bar">
      <span class="live-bar__label">Ready</span>
    </div>
    <div class="input-area" id="inputArea">
      <div class="input-stack">
        <div class="queued-panel" id="queuedPanel"></div>
        <div class="input-wrapper">
          <div id="composerEditor" contenteditable="true"></div>
        </div>
      </div>
    </div>
  </body></html>`, { waitUntil: 'load' });

  await page.evaluate(() => {
    window.ragentT = (key, vars) => {
      const map = {
        'decisionSheet.island.title': 'Pending Decision',
        'decisionSheet.island.defaultLabel': 'Pending Approval',
        'decisionSheet.island.view': 'View',
      };
      return map[key] || key;
    };
    window.getApprovalTitle = (evt) => evt.title || 'Execute Command';
    window.RagentLayout = {
      requestPass() {},
      syncChatBottomOverlaySpacing() {},
      observeOverlay() {},
    };
    window.RagentMotion = {
      prefersReducedMotion: () => false,
    };
  });

  await page.addScriptTag({ content: backHandlerSource });
  await page.addScriptTag({ content: storeSource });
  await page.addScriptTag({ content: decisionSheetSource });

  // 1. Live Bar decoupling: liveBar must NOT have decision-sheet-open class
  const liveBar = page.locator('#liveBar');
  assert.equal(await liveBar.evaluate((el) => el.classList.contains('decision-sheet-open')), false, 'Live Bar initially has no decision-sheet-open');

  // 2. An approval arrives
  await page.evaluate(() => {
    window.RagentDecisions.noteRequest({
      approvalId: 'req-1',
      title: 'Run rm -rf /tmp/test',
      kind: 'approval',
      command: 'rm -rf /tmp/test',
      risk: { tier: 'danger' },
    });
  });

  const sheet = page.locator('#decisionSheet');
  await sheet.waitFor({ state: 'attached' });
  assert.equal(await sheet.isHidden(), false, 'Decision sheet should be open');
  assert.equal(await liveBar.evaluate((el) => el.classList.contains('decision-sheet-open')), false, 'Live Bar remains decoupled (no decision-sheet-open)');

  // 3. User presses Escape -> Decision Sheet should collapse to Dynamic Island
  await page.keyboard.press('Escape');

  // Wait for the collapse transition (220ms) and island entrance (240ms)
  await page.waitForTimeout(500);

  assert.equal(await sheet.isHidden(), true, 'Decision sheet collapsed on Escape');
  const island = page.locator('#decisionIsland');
  await island.waitFor({ state: 'attached' });
  assert.equal(await island.isHidden(), false, 'Dynamic Island is visible above queued panel');
  assert.equal(await island.evaluate((el) => el.classList.contains('visible')), true, 'Island has visible class');

  // Island label should reflect the pending command/approval
  const label = island.locator('.decision-island__label');
  assert.equal(await label.textContent(), 'Run rm -rf /tmp/test', 'Island label matches approval title');

  // Island indicator should have pulse element and danger modifier
  const pulse = island.locator('.decision-island__pulse');
  assert.equal(await pulse.count(), 1, 'Island has breathing pulse element');
  const indicator = island.locator('.decision-island__indicator');
  assert.equal(await indicator.evaluate((el) => el.classList.contains('decision-island__indicator--danger')), true, 'Indicator has danger tier');

  // 4. Clicking Dynamic Island should expand back into Decision Sheet
  await island.locator('.decision-island__button').click();
  await page.waitForTimeout(250);

  assert.equal(await sheet.isHidden(), false, 'Decision sheet expands back on island click');
  assert.equal(await island.isHidden(), true, 'Dynamic Island hidden after re-expansion');

  // 5. Simulating Android Back via history.back()
  await page.evaluate(() => {
    history.back();
  });
  await page.waitForTimeout(500);

  assert.equal(await sheet.isHidden(), true, 'Decision sheet collapsed on Android back');
  assert.equal(await island.isHidden(), false, 'Dynamic Island visible again after Android back');

  // 6. Resolving approval -> Both sheet and island are dismissed
  await page.evaluate(() => {
    window.RagentDecisions.noteResponse({ approvalId: 'req-1' });
  });
  await page.waitForTimeout(300);

  assert.equal(await sheet.isHidden(), true, 'Sheet remains hidden after decision resolution');
  assert.equal(await island.isHidden(), true, 'Dynamic Island dismissed after decision resolution');

  await page.close();
} finally {
  await browser.close();
}

console.log('test-chat-decision-island-morph: ok');
