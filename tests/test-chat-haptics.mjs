#!/usr/bin/env node
// Haptic feedback module tests.
// Behavior (Playwright): the four patterns, capability degradation on
// platforms without navigator.vibrate, reduced-motion gating, same-kind
// throttling, visibility gating, and the run-state observer semantics.
// Static: the four wiring points (decision-sheet approval, stop-run danger,
// session snapshot observer, chat.html script include).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const [hapticsSource, decisionSheetSource, composeSource, sessionHttpSource, chatTemplate] =
  await Promise.all([
    readFile(join(repoRoot, 'static/chat/haptics.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/decision-sheet.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/compose.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
    readFile(join(repoRoot, 'templates/chat.html'), 'utf8'),
  ]);

// ---- Static wiring assertions ----

assert.match(
  chatTemplate,
  /<script src="chat\/haptics\.js\?v=\{\{ASSET_VERSION\}\}" nonce="\{\{NONCE\}\}"><\/script>/,
  'chat.html should include the haptics module',
);

assert.match(
  decisionSheetSource,
  /if \(!ok\) \{[\s\S]*?\} else if \(decision === "approve"\) \{\s*window\.RagentHaptics\?\.approval\?\.\(\);[\s\S]*?\}/,
  'decision sheet should pulse approval haptics only after a successful approve',
);

assert.match(
  composeSource,
  /cancelBtn\.addEventListener\("click", \(\) => \{\s*window\.RagentHaptics\?\.danger\?\.\(\);[\s\S]*?dispatchAction\(\{ action: "cancel" \}\);[\s\S]*?\}\)/,
  'stop-run button should pulse danger haptics before dispatching cancel',
);

assert.match(
  sessionHttpSource,
  /(?:window|chatGlobal)\.RagentHaptics\?\.observeRunState\?\.\(session\);/,
  'attached session state should feed the run-state observer',
);

// ---- Behavior (Playwright) ----

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.addScriptTag({ content: hapticsSource });

  await page.evaluate(() => {
    window.__vibrations = [];
    navigator.vibrate = (pattern) => {
      window.__vibrations.push(pattern);
      return true;
    };
  });

  // 1. The four kinds play their own patterns.
  await page.evaluate(() => {
    window.RagentHaptics.approval();
    window.RagentHaptics.danger();
    window.RagentHaptics.complete();
    window.RagentHaptics.fail();
  });
  assert.deepEqual(
    await page.evaluate(() => window.__vibrations),
    [[10, 50, 10], [20, 40, 20], [10, 40, 10, 40, 10], [10, 40, 10, 40, 30]],
    'each kind should vibrate its own short pattern',
  );

  // 2. Same-kind throttle: a second play inside the window is a no-op.
  // (Wait out the window opened by case 1's approval play.)
  await page.waitForTimeout(650);
  const afterThrottle = await page.evaluate(() => {
    window.__vibrations.length = 0;
    window.RagentHaptics.approval();
    window.RagentHaptics.approval();
    return window.__vibrations.length;
  });
  assert.equal(afterThrottle, 1, 'same-kind plays inside 600ms should be throttled');

  // 3. Reduced-motion gating: the system preference silences haptics.
  const reducedMotionCount = await page.evaluate(() => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query });
    window.__vibrations.length = 0;
    window.RagentHaptics.complete();
    window.matchMedia = realMatchMedia;
    return window.__vibrations.length;
  });
  assert.equal(reducedMotionCount, 0, 'reduced-motion preference should silence haptics');

  // 4. Capability degradation: no navigator.vibrate -> no-op, no throw.
  const degraded = await page.evaluate(() => {
    const realVibrate = navigator.vibrate;
    // Shade the prototype method (delete is a no-op on inherited props).
    navigator.vibrate = undefined;
    const supportedWhileMissing = window.RagentHaptics.isSupported();
    let threw = false;
    try {
      window.RagentHaptics.approval();
      window.RagentHaptics.complete();
    } catch {
      threw = true;
    }
    navigator.vibrate = realVibrate;
    return { threw, supported: supportedWhileMissing };
  });
  assert.deepEqual(degraded, { threw: false, supported: false }, 'missing vibrate API should no-op');

  // 5. Visibility gating: a run finishing in the background must not buzz.
  const visibilityCounts = await page.evaluate(() => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    window.__vibrations.length = 0;
    visibility = 'hidden';
    window.RagentHaptics.observeRunState({ activity: { run: { runId: 'r1', state: 'running' } } });
    window.RagentHaptics.observeRunState({ activity: { run: { runId: 'r1', state: 'completed' } } });
    const backgroundCount = window.__vibrations.length;
    // Coming back to the foreground with the transition already consumed:
    // the observer memory moved on, so no delayed buzz either.
    visibility = 'visible';
    window.RagentHaptics.observeRunState({ activity: { run: { runId: 'r1', state: 'completed' } } });
    const foregroundSameStateCount = window.__vibrations.length;
    return { backgroundCount, foregroundSameStateCount };
  });
  assert.deepEqual(
    visibilityCounts,
    { backgroundCount: 0, foregroundSameStateCount: 0 },
    'background transitions should stay silent and not replay on focus',
  );

  // 6. Observer semantics: same-runId terminal transitions only.
  const observer = await page.evaluate(() => {
    const h = window.RagentHaptics;
    const out = [];
    const probe = (label, runId, state) => {
      const before = window.__vibrations.length;
      h.observeRunState({ activity: { run: { runId, state } } });
      const after = window.__vibrations.length;
      if (after > before) out.push(label);
    };
    window.__vibrations.length = 0;
    // Entering a session that already finished: no buzz.
    probe('enter-finished', 'r2', 'completed');
    // A fresh run ends: complete.
    probe('run-start', 'r2', 'running');
    probe('run-complete', 'r2', 'completed');
    // New run failing: fail.
    probe('enter-failed', 'r3', 'failed');
    probe('fail-start', 'r3', 'running');
    probe('run-failed', 'r3', 'failed');
    // Cancelled transitions are the stop button's job (danger already played).
    probe('cancel-start', 'r4', 'running');
    probe('run-cancelled', 'r4', 'cancelled');
    // Terminal -> terminal (e.g. completed stays after refresh): no replay.
    probe('same-state', 'r2', 'completed');
    return out;
  });
  assert.deepEqual(
    observer,
    ['run-complete', 'run-failed'],
    'only same-runId non-terminal -> terminal transitions should fire',
  );
} finally {
  await browser.close();
}

console.log('test-chat-haptics: ok');
