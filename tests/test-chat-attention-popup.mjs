#!/usr/bin/env node
// Contract checks for the global in-app attention surface. Browser behavior is
// covered by the synthetic Playwright fixture used during the visual pass;
// these assertions protect the event boundary and loading order.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static/chat/attention-popup.js'), 'utf8');
const css = readFileSync(join(repoRoot, 'static/chat/chat-attention-popup.css'), 'utf8');
const html = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');

for (const token of [
  'onRealtimeEvents',
  'onSessionsApplied',
  'getChatStoreStateSnapshot',
  'approval_request',
  'privileged_batch_request',
  'privileged_batch_response',
  'planEventRef',
  'syntheticWaiting',
  'runtime_approval',
  'session_confirmation',
  'submitPrivilegedBatchCategory',
  'oneui-notification__optrow',
  'oneui-notification__answer',
  'enterKeyHint',
  'attention.question.optrow.expand',
]) {
  assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${token} is wired`);
}
assert.doesNotMatch(css, /@media \(max-width: 767px\)[\s\S]*\.oneui-notification/, 'mobile notification does not fork the desktop material');
assert.match(css, /prefers-reduced-motion/, 'reduced-motion state exists');
assert.match(css, /min-height: 44px/, 'touch targets meet the minimum');
assert.match(css, /--oneui-ink: var\(--sys-on-surface\)/, 'notification text uses the M3 on-surface role');
assert.match(css, /--oneui-surface: color-mix\(in srgb, var\(--sys-surface-container-high\) 82%, transparent\)/, 'notification uses a translucent M3 container tint');
assert.match(css, /border-radius: var\(--m3-shape-extra-large\)/, 'notification surface uses the M3 extra-large shape');
assert.match(css, /backdrop-filter: blur\(24px\) saturate\(1\.08\)/, 'notification uses the restrained One UI-style frosted treatment');
assert.match(css, /border: 0;/, 'notification keeps a flat glass perimeter without a highlight edge');
assert.match(html, /chat\/chat-m3-tokens\.css/, 'chat loads the shared M3 role layer');
assert.match(html, /chat\/chat-operational-surfaces\.css/, 'chat loads the final operational surface layer');
assert.match(css, /transition: transform/, 'popup motion uses interruptible transitions');
assert.match(css, /oneui-notification--entering/, 'notification enters from the top');
assert.match(css, /oneui-notification--leaving-up/, 'timeout dismissal exits upward');
assert.match(css, /oneui-notification--leaving-right/, 'touch dismissal exits to the right');
assert.match(css, /oneui-notification--dragging/, 'notification can follow a direct-manipulation gesture');
assert.match(css, /oneui-notification--snap-back/, 'incomplete swipes use a cancelable snap-back');
assert.match(css, /touch-action: none/, 'brief notification reserves the vertical gesture for direct manipulation');
assert.match(css, /touch-action: pan-y/, 'notification keeps native vertical panning while reserving horizontal dismissal');
assert.match(css, /oneui-notification__close/, 'desktop notification has an explicit close affordance');
assert.match(css, /@media \(min-width: 768px\)/, 'desktop close affordance is separated from the touch surface');
assert.match(css, /oneui-notification__action--secondary/, 'completion actions use a compact secondary button');
assert.match(css, /border-radius: var\(--m3-shape-full\)/, 'secondary notification action uses the M3 full shape');
assert.match(css, /min-height: 52px/, 'notification action targets use the prominent M3 touch height');
assert.match(source, /oneui-notification__actions/, 'completion action is visually secondary');
assert.match(css, /height: clamp\(136px, 15dvh, 184px\)/, 'collapsed notification uses the compact top-card height');
assert.match(css, /oneui-notification--detailed/, 'notification has a detailed state');
assert.match(css, /oneui-notification__details/, 'verbose details are behind progressive disclosure');
assert.match(source, /oneui-notification__summary/, 'notification has one compact disclosure summary row');
assert.match(source, /"chevron-right"/, 'notification uses the shared right-facing chevron when collapsed');
assert.match(css, /oneui-notification__disclosure-icon/, 'notification disclosure icon has a dedicated visual treatment');
assert.match(css, /rotate\(90deg\)/, 'notification chevron turns down when details are expanded');
assert.match(css, /transition: transform 180ms/, 'notification chevron has a purposeful state-change transition');
assert.match(source, /oneui-notification__batch-actions/, 'batch decisions are grouped beside their operation category');
assert.match(source, /oneui-notification__batch-footer-actions/, 'batch decisions stay in the fixed notification footer');
assert.match(source, /data-approved-action-approve/, 'approved-action notifications expose a dedicated approve control');
assert.match(source, /syncApprovedActionNotificationState/, 'approved-action checkbox selection updates the approve control');
assert.match(source, /approved_action_batch_response/, 'approved-action batch responses dismiss the notification');
assert.doesNotMatch(source, /categories\.forEach\(\(category\) => \{[\s\S]{0,500}batch-approve/, 'batch decisions are not flattened into a duplicate footer rail');
assert.doesNotMatch(source, /showSystemToast\?\.\(tr\("attention\.submitted"/, 'successful notification decisions close silently');
assert.doesNotMatch(source, /\.attention-popup|attention-popup__/, 'retired notification DOM classes are not reused');
assert.doesNotMatch(css, /\.attention-popup|attention-popup__/, 'retired notification CSS is deleted');
assert.doesNotMatch(source, /attention\.compact\.requestBody/, 'generic request copy is not used as compact content');
assert.doesNotMatch(source, /attention\.action\.submit/, 'ask-user cards no longer render a generic submit button');
assert.doesNotMatch(source, /oneui-notification__custom-answer/, 'the collapsed-only write-in textarea is retired from the popup');
assert.match(source, /kind === "question"\s*\?\s*meaningfulText\(question\?\.question/, 'ask-user titles prefer the question text');
assert.match(css, /oneui-notification__optrow-label/, 'the collapsed first-option row is styled');
assert.match(css, /oneui-notification__answer-input/, 'the footer answer input is styled');
assert.match(css, /oneui-notification--question\s*{[^}]*height: auto/, 'ask-user cards are not clipped by the brief height clamp');
assert.doesNotMatch(source, /attention\.completion\.body/, 'completion popup keeps only outcome and source session instead of generic duplicate copy');
assert.match(source, /host\.setAttribute\("aria-live", item\.type === "completion" \? "polite" : "assertive"\)/, 'completion announcements are polite while approvals remain urgent');
assert.match(source, /card\.tabIndex = isCompletion \? -1 : 0/, 'completion status cards are not inert keyboard stops');
assert.match(source, /meaningfulText/, 'notification title is derived from human-readable action text');
assert.match(source, /card\.addEventListener\("keydown"/, 'card expansion is keyboard accessible');
assert.match(source, /clearDismissTimer/, 'interaction cancels timeout');
assert.match(source, /host\.contains\?\.\(event\.target\)/, 'outside interaction dismisses the expanded popup');
assert.match(source, /getChatStoreStateSnapshot/, 'current session comes from the chat store');
assert.doesNotMatch(source, /shouldSynthesizeWaitingNotification/, 'workflow state cannot synthesize a generic waiting popup');
assert.match(source, /pointermove/, 'popup tracks an upward pointer gesture');
assert.match(source, /velocity > 0\.45/, 'fast upward swipes can dismiss the popup');
assert.match(source, /HORIZONTAL_SWIPE_THRESHOLD_RATIO/, 'right swipe has a width-based completion threshold');
assert.match(source, /HORIZONTAL_SWIPE_VELOCITY/, 'right swipe has a velocity completion threshold');
assert.match(source, /offsetX/, 'right swipe preserves the current horizontal position during exit');
assert.match(source, /cancelAnimationFrame/, 'pointer motion frames can be canceled before a new gesture takes over');
assert.match(source, /cancelSnapBack/, 'snap-back cleanup is canceled before a new gesture takes over');
assert.match(source, /allowVertical/, 'detailed notification bodies keep native vertical scrolling while allowing horizontal dismissal');
assert.match(source, /attention\.action\.dismiss/, 'desktop close uses the localized dismiss label');
assert.match(source, /preserveMotion: true/, 'completed swipes keep their current position during exit');
const popupScript = html.indexOf('chat/attention-popup.js');
const decisionScript = html.indexOf('chat/decision-sheet.js');
assert.ok(popupScript > -1 && decisionScript > popupScript, 'popup loads before decision sheet actions');

// ---- behavioral: the popup never duplicates the currently open session ----
function stubNode(tag) {
  return {
    id: '',
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    dataset: {},
    hidden: false,
    textContent: '',
    style: {
      setProperty(key, value) { this[key] = value; },
      removeProperty(key) { delete this[key]; },
    },
    type: '',
    checked: false,
    value: '',
    children: [],
    classList: {
      _classes: new Set(),
      toggle(name, force) {
        const next = force === undefined ? !this._classes.has(name) : force;
        if (next) this._classes.add(name);
        else this._classes.delete(name);
      },
      contains(name) { return this._classes.has(name); },
      add(...names) { names.forEach((name) => this._classes.add(name)); },
      remove(...names) { names.forEach((name) => this._classes.delete(name)); },
    },
    _listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    insertAdjacentHTML() {},
    setAttribute(key, value) { this[key] = value; },
    getAttribute(key) { return this[key] ?? null; },
    removeAttribute(key) { delete this[key]; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    click() { for (const fn of this._listeners.click || []) fn({ target: this }); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
  };
}

const STUB_GLOBAL_KEYS = [
  'document', 'currentSessionId', 'getChatStoreStateSnapshot', 'ragentT', 'getChatStoreSession',
  'RagentAttentionPopup', 'RagentDecisionSheet', 'matchMedia', 'dispatchAction',
];
const savedGlobals = Object.fromEntries(STUB_GLOBAL_KEYS.map((key) => [key, globalThis[key]]));
try {
  for (const key of STUB_GLOBAL_KEYS) delete globalThis[key];
  const doc = { visibilityState: 'visible', hidden: false, createElement: (tag) => stubNode(tag) };
  doc.body = stubNode('body');
  doc.body.appendChild = function appendToBody(node) { node.__inBody = true; this.children.push(node); return node; };
  doc.body.contains = (node) => node.__inBody === true;
  const sidebarOverlay = stubNode('div');
  sidebarOverlay.id = 'sidebarOverlay';
  sidebarOverlay.classList.add('open');
  const closeSidebar = stubNode('button');
  closeSidebar.id = 'closeSidebar';
  let sidebarCloseClicks = 0;
  closeSidebar.addEventListener('click', () => { sidebarCloseClicks += 1; });
  doc.getElementById = (id) => ({ sidebarOverlay, closeSidebar }[id] || null);
  globalThis.document = doc;
  globalThis.getChatStoreStateSnapshot = () => ({ currentSessionId: 'current-1' });
  globalThis.ragentT = (key) => key;
  globalThis.getChatStoreSession = (id) => ({ id, name: 'test' });
  let desktopMode = false;
  globalThis.matchMedia = () => ({ matches: desktopMode });

  eval(source);

  const popup = globalThis.RagentAttentionPopup;
  assert.ok(popup && typeof popup.onRealtimeEvents === 'function', 'popup API exposed');
  const host = doc.body.children.find((node) => node.id === 'attentionPopupHost');
  assert.ok(host, 'popup host mounted');
  const visible = () => host.hidden !== true && host.children.length > 0;
  const findNode = (node, predicate) => {
    if (!node) return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const match = findNode(child, predicate);
      if (match) return match;
    }
    return null;
  };

  popup._reset();
  popup.onRealtimeEvents('current-1', [{ type: 'approval_request', approvalId: 'a1', kind: 'permission', status: 'pending' }]);
  assert.equal(visible(), false, 'approval in the open session must not pop');

  popup.onRealtimeEvents('other-2', [{ type: 'approval_request', approvalId: 'a2', kind: 'permission', status: 'pending' }]);
  assert.equal(visible(), true, 'approval in a background session must pop');

  popup._reset();
  popup.onRealtimeEvents('other-2', [{ type: 'approval_request', approvalId: 'swipe-1', kind: 'permission', status: 'pending' }]);
  const swipeCard = host.children[0];
  swipeCard._listeners.pointerdown[0]({
    pointerId: 7, pointerType: 'touch', button: 0, clientX: 120, clientY: 120, target: swipeCard,
  });
  swipeCard._listeners.pointermove[0]({
    pointerId: 7, clientX: 120, clientY: 20, timeStamp: 100, preventDefault() {},
  });
  assert.match(String(swipeCard.style.transform), /-100px/, 'card position follows the finger during an upward swipe');
  swipeCard._listeners.pointerup[0]({
    pointerId: 7, clientX: 120, clientY: 20, timeStamp: 140, preventDefault() {},
  });
  assert.equal(visible(), false, 'an upward swipe dismisses a background approval card');

  popup._reset();
  popup.onRealtimeEvents('other-2', [{ type: 'approval_request', approvalId: 'swipe-right-1', kind: 'permission', status: 'pending' }]);
  const rightSwipeCard = host.children[0];
  rightSwipeCard._listeners.pointerdown[0]({
    pointerId: 8, pointerType: 'touch', button: 0, clientX: 20, clientY: 120, target: rightSwipeCard,
  });
  rightSwipeCard._listeners.pointermove[0]({
    pointerId: 8, clientX: 220, clientY: 120, timeStamp: 100, preventDefault() {},
  });
  assert.match(String(rightSwipeCard.style.transform), /200px/, 'card position follows the finger during a right swipe');
  rightSwipeCard._listeners.pointerup[0]({
    pointerId: 8, clientX: 220, clientY: 120, timeStamp: 140, preventDefault() {},
  });
  assert.equal(visible(), false, 'a right swipe dismisses a background approval card');

  popup._reset();
  popup.onRealtimeEvents('other-2', [{ type: 'approval_request', approvalId: 'interrupt-1', kind: 'permission', status: 'pending' }]);
  const interruptedCard = host.children[0];
  interruptedCard._listeners.pointerdown[0]({
    pointerId: 9, pointerType: 'touch', button: 0, clientX: 20, clientY: 120, target: interruptedCard,
  });
  interruptedCard._listeners.pointermove[0]({
    pointerId: 9, clientX: 50, clientY: 120, timeStamp: 100, preventDefault() {},
  });
  interruptedCard._listeners.pointerup[0]({
    pointerId: 9, clientX: 50, clientY: 120, timeStamp: 140, preventDefault() {},
  });
  interruptedCard._listeners.pointerdown[0]({
    pointerId: 10, pointerType: 'touch', button: 0, clientX: 20, clientY: 120, target: interruptedCard,
  });
  interruptedCard._listeners.pointermove[0]({
    pointerId: 10, clientX: 100, clientY: 120, timeStamp: 200, preventDefault() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.match(String(interruptedCard.style.transform), /80px/, 'a new gesture keeps its transform after the previous snap-back duration');
  interruptedCard._listeners.pointercancel[0]({ pointerId: 10 });

  popup._reset();
  popup.onRealtimeEvents('other-2', [{ type: 'approval_request', approvalId: 'detail-right-1', kind: 'permission', status: 'pending' }]);
  const detailedCard = host.children[0];
  detailedCard.click();
  const detailedContentTarget = { closest(selector) { return selector === '.oneui-notification__content' ? this : null; } };
  detailedCard._listeners.pointerdown[0]({
    pointerId: 11, pointerType: 'touch', button: 0, clientX: 20, clientY: 120, target: detailedContentTarget,
  });
  detailedCard._listeners.pointermove[0]({
    pointerId: 11, clientX: 220, clientY: 120, timeStamp: 100, preventDefault() {},
  });
  assert.match(String(detailedCard.style.transform), /200px/, 'expanded notification body still accepts a right swipe');
  detailedCard._listeners.pointerup[0]({
    pointerId: 11, clientX: 220, clientY: 120, timeStamp: 140, preventDefault() {},
  });
  assert.equal(visible(), false, 'a right swipe from expanded notification content dismisses the card');

  popup._reset();
  popup.onRealtimeEvents('other-2', [{
    type: 'plan', planId: 'progress-1', planIntent: 'progress', state: 'awaiting_decision',
  }]);
  assert.equal(visible(), false, 'progress plan cards must stay in-session and never pop');

  popup.onRealtimeEvents('other-2', [{
    type: 'plan', planId: 'progress-2', interactionMode: 'agent', state: 'awaiting_decision',
  }]);
  assert.equal(visible(), false, 'agent-mode progress plan cards must stay in-session and never pop');

  popup.onRealtimeEvents('other-2', [{
    type: 'approval_request', approvalId: 'progress-approval', kind: 'plan', planIntent: 'progress', status: 'pending',
  }]);
  assert.equal(visible(), false, 'progress plan approval-shaped events must never pop a notification');

  // ---- behavioral: ask-user cards answer through options and the footer rail ----
  popup._reset();
  let dispatched = [];
  globalThis.dispatchAction = async (action) => { dispatched.push(action); return true; };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  popup.onRealtimeEvents('other-2', [{
    type: 'approval_request', approvalId: 'q-1', kind: 'question', status: 'pending', runId: 'run-1',
    questions: [{ question: '迁移数据库需要停机十分钟，现在开始吗？', options: [{ label: '现在迁移' }, { label: '午夜再迁移' }] }],
  }]);
  assert.equal(visible(), true, 'a background ask-user approval pops a notification');
  const questionCard = host.children[0];
  assert.match(String(questionCard.className), /oneui-notification--question/, 'ask-user card carries its kind');
  assert.equal(questionCard.children[0].children[0].children[0].textContent, '迁移数据库需要停机十分钟，现在开始吗？', 'the question text is the card title');
  assert.equal(questionCard.children[0].children[0].children.length, 2, 'the title row keeps the close affordance without a separate disclosure chevron');
  assert.match(String(questionCard.children[0].children[0].children[1].className), /oneui-notification__close/, 'ask-user cards also expose the desktop close affordance');
  const answerForm = questionCard.children[2].children[0];
  assert.equal(answerForm.tagName, 'FORM', 'the footer holds the answer form');
  assert.equal(answerForm.children.length, 2, 'the answer form is one reply input plus one deny button');
  assert.equal(answerForm.children[0].enterKeyHint, 'send', 'the reply input exposes the IME send action');
  const optrow = questionCard.children[1].children[0];
  assert.match(String(optrow.className), /oneui-notification__optrow/, 'the collapsed card discloses through the first option row');
  optrow.click();
  assert.equal(optrow.getAttribute('aria-expanded'), 'true', 'tapping the option row expands the card');
  const choicesWrap = questionCard.children[1].children[1].children[0];
  assert.equal(choicesWrap.children.length, 2, 'the expanded card discloses every option');
  choicesWrap.children[1].click();
  await flush();
  assert.deepEqual(dispatched[0], {
    action: 'runtime_approval', runId: 'run-1', approvalId: 'q-1', decision: 'approve', choices: [1], customAnswer: '',
  }, 'tapping an option approves the question with that choice');

  popup._reset();
  dispatched = [];
  popup.onRealtimeEvents('other-2', [{
    type: 'approval_request', approvalId: 'q-2', kind: 'question', status: 'pending', runId: 'run-2',
    questions: [{ question: '用哪个名字发布？', options: [{ label: 'A' }] }],
  }]);
  const rail = host.children[0].children[2].children[0];
  rail.children[0].value = '  就叫 Agent  ';
  rail._listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.deepEqual(dispatched[0], {
    action: 'runtime_approval', runId: 'run-2', approvalId: 'q-2', decision: 'approve', choices: [], customAnswer: '就叫 Agent',
  }, 'the typed reply submits as a custom answer');

  // A background privileged batch may be stale by the time its action reaches
  // the server. The Decision Sheet returns an explicit terminal result so the
  // popup removes the entire batch, including any untouched category.
  globalThis.RagentDecisionSheet = {
    submitPrivilegedBatchCategory: async () => ({ ok: true, alreadyEnded: true }),
  };
  popup._reset();
  popup.onRealtimeEvents('other-2', [{
    type: 'privileged_batch_request',
    batchId: 'stale-batch',
    runId: 'stale-run',
    other: [{ opId: 'stale-op', command: 'systemctl restart nginx' }],
    delete: [{ opId: 'stale-delete', command: 'rm -rf /var/lib/foo' }],
  }]);
  assert.equal(visible(), true, 'a stale background privileged batch initially pops');
  const staleBatchButton = findNode(host.children[0], (node) => node.dataset?.action === 'batch-deny');
  assert.ok(staleBatchButton, 'stale batch test finds the category action');
  staleBatchButton.click();
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(visible(), false, 'a stale batch action removes the entire background card');

  popup._reset();
  dispatched = [];
  popup.onRealtimeEvents('other-2', [{
    type: 'approval_request', approvalId: 'q-3', kind: 'question', status: 'pending', runId: 'run-3',
    questions: [{ question: '继续吗？', options: [{ label: '是' }] }],
  }]);
  host.children[0].children[2].children[0].children[1].click();
  await flush();
  assert.deepEqual(dispatched[0], {
    action: 'runtime_approval', runId: 'run-3', approvalId: 'q-3', decision: 'deny', choices: [], customAnswer: '',
  }, 'deny stays available as the compact footer action');

  popup._reset();
  dispatched = [];
  popup.onRealtimeEvents('other-2', [{
    type: 'approval_request', approvalId: 'q-4', kind: 'question', status: 'pending', runId: 'run-4',
    questions: [{ question: '现在开始吗？', options: [{ label: '是' }] }],
  }]);
  host.children[0].children[2].children[0]._listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.deepEqual(dispatched, [], 'an empty reply never submits a no-answer approval');

  popup.onRealtimeEvents('other-2', [{
    type: 'plan', planId: 'proposal-1', planIntent: 'proposal', state: 'awaiting_decision',
  }]);
  assert.equal(visible(), true, 'proposal plans awaiting a decision must still pop a notification');

  popup._reset();
  popup.onSessionsApplied(
    new Map([['other-2', { id: 'other-2', workflowState: 'running' }]]),
    [{
      id: 'other-2',
      workflowState: 'waiting_user',
      activity: { run: { state: 'waiting_user', kind: 'planning', actionRequired: false } },
    }],
  );
  assert.equal(visible(), false, 'non-action progress waits must not synthesize a notification');

  popup.onSessionsApplied(
    new Map([['other-2', { id: 'other-2', workflowState: 'running' }]]),
    [{
      id: 'other-2',
      workflowState: 'waiting_user',
      activity: { run: { state: 'waiting_user', kind: 'approval', actionRequired: true } },
    }],
  );
  assert.equal(visible(), false, 'workflow waits without a concrete request must not synthesize a notification');

  popup.onSessionsApplied(
    new Map([['current-1', { id: 'current-1', workflowState: 'running' }]]),
    [{
      id: 'current-1',
      workflowState: 'waiting_user',
      activity: { run: { state: 'waiting_user', kind: 'approval', actionRequired: true } },
    }],
  );
  assert.equal(visible(), false, 'the open session must not receive a fallback waiting popup');

  popup._reset();
  popup.onSessionsApplied(
    new Map([['current-1', { id: 'current-1', activity: { run: { state: 'running' } } }]]),
    [{ id: 'current-1', activity: { run: { state: 'completed' } }, unreadAt: '2026-08-07T00:00:00Z', workflowState: 'running' }],
  );
  assert.equal(visible(), false, 'completion in the open session must not pop');

  popup.onSessionsApplied(
    new Map([['other-2', { id: 'other-2', activity: { run: { state: 'running' } } }]]),
    [{ id: 'other-2', activity: { run: { state: 'completed' } }, unreadAt: '2026-08-07T00:00:00Z', workflowState: 'running' }],
  );
  assert.equal(visible(), true, 'completion in a background session must pop');
  const completionCard = host.children[0];
  completionCard._listeners.pointerdown[0]({ target: completionCard });
  assert.equal(sidebarCloseClicks, 1, 'completion notification interaction closes an open mobile sessions sidebar');

  popup._reset();
  desktopMode = true;
  sidebarOverlay.classList.remove('open');
  popup.onSessionsApplied(
    new Map([['other-2', { id: 'other-2', activity: { run: { state: 'running' } } }]]),
    [{ id: 'other-2', activity: { run: { state: 'completed' } }, unreadAt: '2026-08-07T00:00:01Z', workflowState: 'running' }],
  );
  host.children[0]._listeners.pointerdown[0]({ target: host.children[0] });
  assert.equal(sidebarCloseClicks, 2, 'completion notification interaction collapses an open desktop sessions sidebar');
} finally {
  for (const key of STUB_GLOBAL_KEYS) {
    if (savedGlobals[key] === undefined) delete globalThis[key];
    else globalThis[key] = savedGlobals[key];
  }
}

await (async () => {
  const { default: assertMod } = await import('node:assert/strict');
  const fsMod = await import('node:fs');
  const vmMod = await import('node:vm');

  function mkPopupEl(tag) {
    const node = {
      tagName: String(tag || 'DIV').toUpperCase(),
      className: '',
      children: [],
      dataset: {},
      attrs: {},
      style: { setProperty() {}, removeProperty() {} },
      listeners: {},
      hidden: false,
      disabled: false,
      type: '',
      value: '',
      placeholder: '',
      _text: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      classList: {
        add(...cs) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
        remove(...cs) { node.className = node.className.split(/\s+/).filter(Boolean).filter((c) => !cs.includes(c)).join(' '); },
        toggle(c, f) { const has = this.contains(c); const next = f === undefined ? !has : Boolean(f); if (next) this.add(c); else this.remove(c); return next; },
        contains(c) { return node.className.split(/\s+/).filter(Boolean).includes(c); },
      },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      append(...cs) { for (const c of cs) if (c) this.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); },
      replaceChildren(...cs) { this.children = []; this.append(...cs); },
      insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; },
      remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      querySelectorAll(sel) {
        const out = [];
        const cls = sel.startsWith('.') ? sel.slice(1).split(' ')[0] : null;
        const walk = (n) => { for (const c of n.children || []) { if (cls ? c.classList?.contains(cls) : c.tagName === sel.toUpperCase()) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      get firstChild() { return this.children[0] || null; },
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set textContent(v) { this._text = String(v ?? ''); },
      set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } },
      closest() { return null; },
    };
    return node;
  }

  const body = mkPopupEl('body');
  const doc = {
    body,
    createElement: mkPopupEl,
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: () => null,
    addEventListener: () => {},
  };
  const dispatched = [];
  const ctx = {
    window: null,
    document: doc,
    globalThis: null,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    dispatchAction: async (p) => { dispatched.push(p); return { ok: true }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/attention-popup.js', 'utf8'), ctx);

  // Track 1: multi-question + multiSelect + isSecret + isBlocking:false toggles & requires Submit (no immediate submit on option tap)
  ctx.RagentAttentionPopup.onRealtimeEvents('s-bg', [{
    type: 'approval_request',
    approvalId: 'q-multi',
    kind: 'question',
    isBlocking: false,
    questions: [
      { question: 'Env?', options: ['Dev', 'Prod'] },
      { question: 'Scopes?', options: ['Read', 'Write'], multiSelect: true, isSecret: true },
    ],
  }]);
  let card = body.querySelector('.oneui-notification');
  assertMod.ok(card.classList.contains('oneui-notification--detailed'));
  assertMod.ok(card.querySelector('.oneui-notification__badge--nonblocking'));
  const secretField = card.querySelector('.oneui-notification__question-input');
  assertMod.equal(secretField.type, 'password');
  assertMod.equal(secretField.getAttribute('autocomplete'), 'off');

  const opts = card.querySelectorAll('.oneui-notification__choice');
  opts[0].listeners.click[0]();
  assertMod.equal(dispatched.length, 0, 'clicking Q1 option must not submit multi-question popup immediately');
  opts[2].listeners.click[0]();
  opts[3].listeners.click[0]();
  secretField.value = 'sec-val';
  secretField.listeners.input[0]();

  const submitBtn = card.querySelectorAll('.oneui-notification__action').find((b) => b.classList.contains('oneui-notification__action--primary'));
  assertMod.equal(submitBtn.disabled, false);
  await submitBtn.listeners.click[0]();
  assertMod.equal(dispatched.length, 1);
  assertMod.equal(dispatched[0].decision, 'approve_with_multi_choices');
  assertMod.equal(JSON.stringify(dispatched[0].choices), JSON.stringify([0, 0]));
  assertMod.equal(JSON.stringify(dispatched[0].multiChoices), JSON.stringify([[0], [0, 1]]));
  assertMod.equal(JSON.stringify(dispatched[0].customAnswers), JSON.stringify(['', 'sec-val']));

  // Skip button on isBlocking:false submits emptySkip:true
  const body2 = mkPopupEl('body');
  const ctx2 = {
    ...ctx,
    window: null,
    globalThis: null,
    document: { ...doc, body: body2 },
  };
  ctx2.window = ctx2;
  ctx2.globalThis = ctx2;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), ctx2);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/attention-popup.js', 'utf8'), ctx2);
  ctx2.RagentAttentionPopup.onRealtimeEvents('s-bg', [{
    type: 'approval_request',
    approvalId: 'q-skip',
    kind: 'question',
    isBlocking: false,
    questions: [{ question: 'Optional?', options: ['A', 'B'] }],
  }]);
  const card2 = body2.querySelector('.oneui-notification');
  const skipBtn = card2.querySelectorAll('.oneui-notification__action').find((b) => b.classList.contains('oneui-notification__skip-action'));
  await skipBtn.listeners.click[0]();
  assertMod.equal(dispatched[1].emptySkip, true);
  assertMod.equal(dispatched[1].decision, 'approve');

  // Track 3: unsupported openai/userVerification hides Approve and exposes Decline/Cancel only
  const body3 = mkPopupEl('body');
  const ctx3 = { ...ctx, window: null, globalThis: null, document: { ...doc, body: body3 } };
  ctx3.window = ctx3;
  ctx3.globalThis = ctx3;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), ctx3);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/attention-popup.js', 'utf8'), ctx3);
  ctx3.RagentAttentionPopup.onRealtimeEvents('s-bg', [{
    type: 'approval_request',
    approvalId: 'el-uv',
    kind: 'permissions',
    elicitation: { mode: 'openai/userVerification', serverName: 'gh', message: 'Biometric check' },
  }]);
  const card3 = body3.querySelector('.oneui-notification');
  const btnTexts = card3.querySelectorAll('.oneui-notification__action').map((b) => b.textContent);
  assertMod.equal(JSON.stringify(btnTexts), JSON.stringify(['Decline', 'Cancel']));
})();

console.log('test-chat-attention-popup: ok');
