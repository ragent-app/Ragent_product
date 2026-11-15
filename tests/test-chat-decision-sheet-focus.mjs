#!/usr/bin/env node
// Browser contract for the non-modal Decision Sheet keyboard boundary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(repoRoot, 'static/chat/decision-sheet.js'), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <button id="decision-trigger" type="button">Show pending approval</button>
    <div id="inputArea"><div id="liveBar"></div></div>
  </body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => {
    window.ragentT = (key) => key;
    window.getApprovalTitle = () => 'Review this command';
    window.RagentLayout = { requestPass() {}, syncChatBottomOverlaySpacing() {}, observeOverlay() {} };
    window.RagentBackHandler = { push() {}, pop() {} };
    window.RagentMotion = { prefersReducedMotion: () => true };
    window.RagentDecisions = {
      subscribe(callback) { callback({ pending: false, evt: null }); return () => {}; },
      subscribeBatch(callback) { callback({ pending: false, evt: null }); return () => {}; },
      getPending() {
        return { approvalId: 'focus-1', kind: 'permission', command: 'echo ready' };
      },
      getBatchState() { return { evt: null }; },
    };
  });
  await page.addScriptTag({ content: source });
  await page.locator('#decision-trigger').focus();
  await page.evaluate(() => window.RagentDecisionSheet.reopen());

  const sheet = page.locator('#decisionSheet');
  await sheet.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'decision-trigger', 'an arriving approval preserves the user’s current focus');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('decision-sheet__summary')), true, 'the shared disclosure summary is the first keyboard stop inside the approval');
  assert.equal(await sheet.getAttribute('aria-describedby'), 'decisionSheetContent', 'sheet describes its content region');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(40);
  assert.equal(await sheet.getAttribute('hidden'), '', 'Escape collapses the pending sheet');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'decision-trigger', 'closing restores focus to the trigger');
  await page.close();
} finally {
  await browser.close();
}

console.log('test-chat-decision-sheet-focus: ok');
