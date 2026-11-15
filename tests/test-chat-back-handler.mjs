#!/usr/bin/env node
// Unified Android back handler tests.
// Behavior (Playwright): history entry per layer, popstate consumption by
// tagged id, refusal re-push, conservative stack-top fallback, LIFO order
// across layers, non-top pop safety, active() state.
// Static: every core overlay registers/unregisters with the manager.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const [handlerSource, runSheetSource, decisionSheetSource, sidebarUiSource, toolingSource, rightSidebarSource, fullscreenSource] =
  await Promise.all([
    readFile(join(repoRoot, 'static/chat/back-handler.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/run-sheet.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/decision-sheet.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/sidebar-ui.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/tooling.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/right-sidebar.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/composer-fullscreen.js'), 'utf8'),
  ]);

// ---- Static wiring: every core overlay talks to the manager ----
assert.match(
  runSheetSource,
  /window\.RagentBackHandler\?\.push\?\.\(\{\s*id: "run-sheet",[\s\S]*?state\.readerOpen[\s\S]*?closeMarkdownPreview\(\)/,
  'run sheet should register with reader-first back semantics',
);
assert.match(
  runSheetSource,
  /window\.RagentBackHandler\?\.pop\?\.\(backEntryId\);/,
  'run sheet close should unregister',
);
assert.match(
  decisionSheetSource,
  /window\.RagentBackHandler\?\.push\?\.\(\{\s*id: "decision-sheet",[\s\S]*?hideSheet\(\)/,
  'decision sheet should register and collapse without deciding on back',
);
assert.match(
  sidebarUiSource,
  /id: "sidebar-drawer",[\s\S]*?sidebarSearchMode[\s\S]*?setSidebarSearchMode\(false/,
  'the drawer should exit search mode before closing on back',
);
assert.match(
  sidebarUiSource,
  /id: "composer-add-menu",[\s\S]*?setComposerAddMenuOpen\(false\)/,
  'the add menu should register with the manager',
);
assert.match(
  toolingSource,
  /id: "composer-runtime-menu",[\s\S]*?setComposerRuntimeMenuOpen\(false\)/,
  'the runtime menu should register with the manager',
);
assert.match(
  toolingSource,
  /id: "composer-permission-menu",[\s\S]*?setComposerPermissionMenuOpen\(false\)/,
  'the permission menu should register with the manager',
);
assert.match(
  toolingSource,
  /syncComposerPermissionMenuBackEntry\(false\);/,
  'opening one menu should unwind the other mutual-exclusion back entry',
);
assert.match(
  rightSidebarSource,
  /id: "right-sidebar",[\s\S]*?state\.view === "files"[\s\S]*?openHome\(\)/,
  'the right sidebar should step home from deep views before closing on back',
);
assert.match(
  fullscreenSource,
  /id: "composer-fullscreen",[\s\S]*?close\(\{ skipSync: false, viaHistory: true \}\)/,
  'the full-screen composer should collapse via the manager',
);

// ---- Secondary overlays ----
const [bootstrapSource, customSelectSource, sessionSurfaceSource, workbenchSource, decisionsStoreSource, liveStatusSource] =
  await Promise.all([
    readFile(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/custom-select.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/session-surface-ui.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/workbench-inspector.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/decisions-store.js'), 'utf8'),
    readFile(join(repoRoot, 'static/chat/live-status-ui.js'), 'utf8'),
  ]);
assert.match(
  decisionSheetSource,
  /root\.RagentDecisionSheet = Object\.freeze\(\{[^}]*\breopen\b[^}]*\}\);/,
  'the decision sheet should expose a reopen entry point',
);
assert.match(
  decisionSheetSource,
  /if \(!hostEl\.hidden && renderedApprovalId === evtId && !hostEl\.classList\.contains\("is-closing"\)\) return;/,
  'renderSheet should stay idempotent for the already-visible approval, but win over an in-flight collapse',
);
assert.match(
  liveStatusSource,
  /window\.RagentDecisions\.getPending\(\)[\s\S]*?window\.RagentDecisionSheet\.reopen\(\);/,
  'the Live Bar should reopen the pending approval sheet',
);
assert.match(
  decisionSheetSource,
  /hostEl\.classList\.add\("is-closing"\);[\s\S]*?hideSheetTimer = setTimeout\(\(\) => \{\s*hideSheetTimer = null;\s*finishHideSheet\(\);[\s\S]*?SHEET_HIDE_ANIMATION_MS\);/,
  'the sheet collapse should play the closing animation before hiding',
);
assert.match(
  decisionSheetSource,
  /window\.RagentMotion\?\.prefersReducedMotion\?\.\(\)[\s\S]*?finishHideSheet\(\);/,
  'reduced-motion users should skip the collapse animation',
);
assert.match(
  decisionSheetSource,
  /if \(hideSheetTimer\) \{\s*clearTimeout\(hideSheetTimer\);[\s\S]*?hostEl\.classList\.remove\("is-closing"\);/,
  'showing an approval should cancel an in-flight collapse',
);
const decisionSheetCss = await readFile(join(repoRoot, 'static/chat/chat-decision-sheet.css'), 'utf8');
assert.match(
  decisionSheetCss,
  /@keyframes decision-sheet-out[\s\S]*?translate3d\(0, 100%, 0\);/,
  'the collapse keyframes should mirror the rise',
);
assert.match(
  decisionSheetCss,
  /#decisionSheet\.is-closing \{[\s\S]*?animation: decision-sheet-out var\(--motion-exit, 180ms\)/,
  'the closing class should drive the tokenized collapse animation',
);
assert.doesNotMatch(
  decisionSheetCss,
  /#liveBar[^\{]*\{[^}]*\btransition\s*:/,
  'Decision Sheet must not replace the Live Bar transition list with an ID shorthand',
);
assert.match(
  decisionSheetCss,
  /#liveBar\.decision-sheet-open \{\s*opacity: 0;\s*pointer-events: none;\s*\}/,
  'the Live Bar should fade out under the open sheet via a class-driven transition',
);
assert.match(
  sidebarUiSource,
  /id: "workspace-picker",[\s\S]*?setWorkspacePickerExpanded\(false\)/,
  'the workspace picker should register with the manager',
);
assert.match(
  sidebarUiSource,
  /id: "sidebar-account-popover",[\s\S]*?closeSidebarAccountPopover\(\)/,
  'the account popover should register with the manager',
);
assert.match(
  sidebarUiSource,
  /id: "project-create-dialog",[\s\S]*?closeProjectCreateDialog\(\)/,
  'the project dialog should register with the manager',
);
assert.match(
  sidebarUiSource,
  /sidebar\.dataset\.sidebarMode[\s\S]*?switchTab\("sessions"\)/,
  'the drawer should step back from agents/settings subpages first',
);
assert.match(
  bootstrapSource,
  /id: "header-overflow",[\s\S]*?setHeaderOverflowOpen\(false\)/,
  'the header overflow menu should register with the manager',
);
assert.match(
  bootstrapSource,
  /id: "composer-controls",[\s\S]*?setComposerControlsOpen\(false\)/,
  'the composer controls panel should register with the manager',
);
assert.match(
  toolingSource,
  /id: "add-tool-modal",[\s\S]*?closeAddToolModal\(\)/,
  'the add-tool modal should register with the manager',
);
assert.match(
  customSelectSource,
  /customSelectBackEntrySeq[\s\S]*?onBack: \(\) => \{\s*this\.close\(\);/,
  'custom select dropdowns should register per instance',
);
assert.match(
  sessionSurfaceSource,
  /id: "session-context-menu",[\s\S]*?closeSessionContextMenu\(\)/,
  'the session context menu should register with the manager',
);
assert.match(
  sessionSurfaceSource,
  /id: "queued-steer-menu",[\s\S]*?closeQueuedSteerMenu\(\)/,
  'the queued steer menu should register with the manager',
);
assert.match(
  workbenchSource,
  /id: "markdown-reader",[\s\S]*?closeMarkdownReader\(\)/,
  'the workbench markdown reader should register with the manager',
);

// ---- Behavior ----
const browser = await chromium.launch({ headless: true });

try {

async function newHandlerPage() {
  const p = await browser.newPage();
  await p.setContent('<!doctype html><html><body></body></html>');
  await p.addScriptTag({ content: handlerSource });
  return p;
}

  // 1. push registers a tagged history entry and reports active.
  const page = await newHandlerPage();
  const pushed = await page.evaluate(() => {
    const before = history.length;
    const id = window.RagentBackHandler.push({ id: 'layer-a', onBack: () => true });
    return { id, grew: history.length > before, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(pushed, { id: 'layer-a', grew: true, active: true }, 'push should add a history entry and activate');

  // 2. popstate consumes the tagged entry and invokes its onBack.
  const consumedPage = await newHandlerPage();
  const consumed = await consumedPage.evaluate(async () => {
    window.__closed = [];
    window.RagentBackHandler.push({ id: 'layer-b', onBack: () => { window.__closed.push('b'); return true; } });
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return {
      closed: window.__closed,
      active: window.RagentBackHandler.active(),
    };
  });
  assert.deepEqual(consumed, { closed: ['b'], active: false }, 'back should consume the top layer only');

  // 3. Refusal (onBack false) restores the entry so the next back retries.
  const refusedPage = await newHandlerPage();
  const refused = await refusedPage.evaluate(async () => {
    let attempts = 0;
    // onBack returns true = consumed; false = refused (entry restored).
    window.RagentBackHandler.push({ id: 'layer-c', onBack: () => { attempts += 1; return attempts >= 3; } });
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    const afterFirst = attempts;
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return { afterFirst, afterSecond: attempts, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(refused, { afterFirst: 1, afterSecond: 2, active: true }, 'a refused close should retry on the next back');

  // 4. Unknown history state falls back to closing the stack top.
  const foreignPage = await newHandlerPage();
  const foreign = await foreignPage.evaluate(async () => {
    window.__closed = [];
    window.RagentBackHandler.push({ id: 'layer-d', onBack: () => { window.__closed.push('d'); return true; } });
    history.pushState({ foreign: true }, '');
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return { closed: window.__closed, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(foreign, { closed: ['d'], active: false }, 'an unknown entry should conservatively close the top layer');

  // 5. LIFO across layers: the top layer closes first, then the one below.
  const lifoPage = await newHandlerPage();
  const lifo = await lifoPage.evaluate(async () => {
    window.__closed = [];
    window.RagentBackHandler.push({ id: 'outer', onBack: () => { window.__closed.push('outer'); return true; } });
    window.RagentBackHandler.push({ id: 'inner', onBack: () => { window.__closed.push('inner'); return true; } });
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return { closed: window.__closed, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(lifo, { closed: ['inner', 'outer'], active: false }, 'backs should unwind layers in LIFO order');

  // 6. Closing a non-top layer must not mis-close the still-open top layer.
  const nonTopPage = await newHandlerPage();
  const nonTop = await nonTopPage.evaluate(async () => {
    window.__closed = [];
    window.RagentBackHandler.push({ id: 'bottom', onBack: () => { window.__closed.push('bottom'); return true; } });
    window.RagentBackHandler.push({ id: 'top', onBack: () => { window.__closed.push('top'); return true; } });
    window.RagentBackHandler.pop('bottom');
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return { closed: window.__closed, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(nonTop, { closed: ['top'], active: false }, 'popping a lower layer should not close the top layer');

  // 7. pop of the top layer unwinds its entry: the following back does nothing.
  const unwindPage = await newHandlerPage();
  const unwind = await unwindPage.evaluate(async () => {
    window.__closed = [];
    const id = window.RagentBackHandler.push({ id: 'solo', onBack: () => { window.__closed.push('solo'); return true; } });
    window.RagentBackHandler.pop(id);
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return { closed: window.__closed, active: window.RagentBackHandler.active() };
  });
  assert.deepEqual(unwind, { closed: [], active: false }, 'after a user close the next back should not re-trigger');

  // 8. Empty stack: back does nothing (browser default exit).
  const emptyPage = await newHandlerPage();
  const empty = await emptyPage.evaluate(async () => {
    window.RagentBackHandler.push({ id: 'temp', onBack: () => true });
    window.RagentBackHandler.pop('temp');
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    return window.RagentBackHandler.active();
  });
  assert.equal(empty, false, 'an empty stack should leave the back to the browser');

  // 9. Decision sheet lifecycle: back collapses without deciding, and the
  //    Live Bar entry point reopens the still-pending approval.
  const decisionPage = await browser.newPage();
  await decisionPage.setContent(`<!doctype html><html><body>
    <div class="input-area" id="inputArea"></div>
  </body></html>`);
  await decisionPage.addScriptTag({ content: handlerSource });
  await decisionPage.addScriptTag({ content: decisionsStoreSource });
  await decisionPage.addScriptTag({ content: decisionSheetSource });
  const decisionFlow = await decisionPage.evaluate(async () => {
    window.submitRuntimeApprovalDecision = async () => true;
    const sheet = document.getElementById('decisionSheet');
    window.RagentDecisions.noteRequest({ approvalId: 'a1', title: 'Run command?', kind: 'approval', command: 'ls' });
    const opened = !sheet.hidden;
    const pendingBefore = !!window.RagentDecisions.getPending();
    // Android back: sheet collapses, approval stays pending, no decision.
    history.back();
    await new Promise((r) => setTimeout(r, 450));
    const collapsed = sheet.hidden;
    const pendingAfter = !!window.RagentDecisions.getPending();
    // Live Bar tap: reopen the still-pending approval.
    window.RagentDecisionSheet.reopen();
    const reopened = !sheet.hidden;
    // Reopen is idempotent while already visible.
    window.RagentDecisionSheet.reopen();
    const idempotent = !sheet.hidden;
    // Reopen mid-collapse: a back while the close animation is in flight
    // must cancel the collapse and re-expand, not get swallowed by the
    // idempotence guard.
    history.back();
    await new Promise((r) => setTimeout(r, 120));
    const closingInFlight = sheet.classList.contains('is-closing');
    window.RagentDecisionSheet.reopen();
    const reopenedMidCollapse = !sheet.hidden && !sheet.classList.contains('is-closing');
    // Approval resolved: noteResponse clears the store, the sheet collapses
    // through the same animated path and empties after the animation.
    window.RagentDecisions.noteResponse({ approvalId: 'a1' });
    await new Promise((r) => setTimeout(r, 120));
    const resolving = sheet.classList.contains('is-closing');
    await new Promise((r) => setTimeout(r, 300));
    const resolved = sheet.hidden && sheet.childElementCount === 0;
    return { opened, pendingBefore, collapsed, pendingAfter, reopened, idempotent, closingInFlight, reopenedMidCollapse, resolving, resolved };
  });
  assert.deepEqual(decisionFlow, {
    opened: true,
    pendingBefore: true,
    collapsed: true,
    pendingAfter: true,
    reopened: true,
    idempotent: true,
    closingInFlight: true,
    reopenedMidCollapse: true,
    resolving: true,
    resolved: true,
  }, 'back should collapse without deciding; reopen should restore the pending approval, even mid-collapse');
} finally {
  await browser.close();
}

console.log('test-chat-back-handler: ok');
