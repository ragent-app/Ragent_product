#!/usr/bin/env node
// test-chat-approval-notify.mjs — unit tests for the in-page approval
// Notification fallback (static/chat/approval-notify.js). Runs the module in a
// vm sandbox with a stubbed Notification + minimal decisions store, and checks
// the gate logic, dedup, background-session transition detection, the
// gesture-backed permission bootstrap, and the Decision Sheet affordance flag.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/approval-notify.js'), 'utf8');

//chat.html must load the new module after the decisions store and before the
// Decision Sheet view that consumes it.
const chatHtml = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
const storeIdx = chatHtml.indexOf('chat/decisions-store.js');
const notifyIdx = chatHtml.indexOf('chat/approval-notify.js');
const sheetIdx = chatHtml.indexOf('chat/decision-sheet.js');
assert.ok(storeIdx > -1 && notifyIdx > -1 && sheetIdx > -1, 'chat.html references all three scripts');
assert.ok(storeIdx < notifyIdx, 'approval-notify.js loads after decisions-store.js');
assert.ok(notifyIdx < sheetIdx, 'approval-notify.js loads before decision-sheet.js');

function makeSandbox({ permission = 'default', visible = true, currentSessionId = 'cur' } = {}) {
  const notifs = [];
  let pushBootstrapped = 0;
  let decisionsSubscriber = null;
  let batchSubscriber = null;
  const Notification = function (title, opts) {
    notifs.push({ title, opts });
    this.onclick = null;
    this.close = () => {};
  };
  Notification.permission = permission;
  Notification.requestPermission = async () => (permission === 'default' ? 'granted' : permission);
  const sandbox = {
    console,
    Object, Set, String, Number, Error, JSON, Array, Map,
    currentSessionId,
    document: { visibilityState: visible ? 'visible' : 'hidden', hidden: !visible },
    Notification,
    ragentT: (k) => k,
    shouldEnableOwnerPushFeatures: () => true,
    getCurrentSession: () => ({ id: currentSessionId, name: 'Current', folder: 'a/b' }),
    applyNavigationState: () => {},
    queueForegroundRefresh: async () => {},
    setupPushNotifications: () => { pushBootstrapped += 1; },
    RagentDecisions: {
      subscribe(fn) { decisionsSubscriber = fn; return () => { decisionsSubscriber = null; }; },
      subscribeBatch(fn) { batchSubscriber = fn; return () => { batchSubscriber = null; }; },
    },
    RagentSessionStateModel: {
      hasSessionNeedsAction: (s) => String(s?.workflowState || '').toLowerCase() === 'waiting_user',
    },
    _notifs: notifs,
    _pushBootstrapped: () => pushBootstrapped,
    _getDecisionsSubscriber: () => decisionsSubscriber,
    _getBatchSubscriber: () => batchSubscriber,
  };
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox) {
  vm.runInContext(source, sandbox);
  return sandbox.RagentApprovalNotify;
}

// ---------------------------------------------------------------------------
// 1. API surface
// ---------------------------------------------------------------------------
const api0 = load(makeSandbox());
assert.ok(api0, 'RagentApprovalNotify attached to the global');
for (const name of ['fire', 'onSessionsApplied', 'requestPermissionFromGesture',
  'enableAffordanceShouldShow', 'dismissEnable', 'resetEnableDismissal',
  'describeWaiting', 'shouldFire', 'dedupKey', '_reset', '_notifiedCount']) {
  assert.equal(typeof api0[name], 'function', `${name} is exposed`);
}
assert.ok(Object.isFrozen(api0), 'API object is frozen');

// ---------------------------------------------------------------------------
// 2. describeWaiting — kind/risk -> label (mirrors server attention-push)
// ---------------------------------------------------------------------------
const dw = api0.describeWaiting;
assert.equal(dw({ kind: 'plan' }).label, 'notify.waiting.plan');
assert.equal(dw({ kind: 'question' }).label, 'notify.waiting.answer');
assert.equal(dw({ question: 'pick one' }).label, 'notify.waiting.answer');
assert.equal(dw({ kind: 'command', risk: 'high' }).label, 'notify.waiting.danger');
assert.equal(dw({ kind: 'command', risk: 'CRITICAL' }).label, 'notify.waiting.danger');
assert.equal(dw({ kind: 'command' }).label, 'notify.waiting.approval');
assert.equal(dw({}).kind, 'approval', 'bare record falls back to generic approval');

// ---------------------------------------------------------------------------
// 3. shouldFire — pure gate
// ---------------------------------------------------------------------------
const sf = api0.shouldFire;
assert.equal(sf({ isSupported: true, perm: 'granted', isCurrent: true, visible: true }), false,
  'viewing the approval (current + visible) is suppressed — the sheet is on screen');
assert.equal(sf({ isSupported: true, perm: 'granted', isCurrent: false, visible: true }), true,
  'background session while tab visible fires');
assert.equal(sf({ isSupported: true, perm: 'granted', isCurrent: true, visible: false }), true,
  'current session while tab hidden fires');
assert.equal(sf({ isSupported: true, perm: 'default', isCurrent: false, visible: true }), false,
  'no notification without granted permission');
assert.equal(sf({ isSupported: true, perm: 'denied', isCurrent: false, visible: false }), false,
  'denied permission never fires');
assert.equal(sf({ isSupported: false, perm: 'granted', isCurrent: false, visible: true }), false,
  'unsupported browser never fires');

// ---------------------------------------------------------------------------
// 4. fire — dedup + visible/current suppression
// ---------------------------------------------------------------------------
const sb = makeSandbox({ permission: 'granted', visible: true, currentSessionId: 'cur' });
const api = load(sb);
api._reset();
const bg = { id: 'bg1', name: 'Background', workflowStateChangedAt: 't1' };
assert.equal(api.fire(bg, { label: 'x', stamp: 't1' }), true, 'background approval fires');
assert.equal(sb._notifs.length, 1, 'one notification created');
assert.equal(sb._notifs[0].opts.tag, 'ragent-approval:bg1', 'tag is per-session');
assert.equal(api.fire(bg, { label: 'x', stamp: 't1' }), false, 'same stamp is deduped');
assert.equal(sb._notifs.length, 1, 'dedup did not create a second notification');
assert.equal(api.fire({ id: 'cur', name: 'Current' }, { stamp: 'a1' }), false,
  'current session while visible is suppressed');
// A different stamp on the same session is a new waiting period -> fires.
assert.equal(api.fire(bg, { label: 'x', stamp: 't2' }), true, 'new stamp fires again');

// Current session fires when the tab goes hidden.
const sbH = makeSandbox({ permission: 'granted', visible: false, currentSessionId: 'cur' });
const apiH = load(sbH);
apiH._reset();
assert.equal(apiH.fire({ id: 'cur', name: 'Current' }, { stamp: 'a1' }), true,
  'current session fires when tab hidden');

// ---------------------------------------------------------------------------
// 5. onSessionsApplied — background transition detection
// ---------------------------------------------------------------------------
const sbL = makeSandbox({ permission: 'granted', visible: true, currentSessionId: 'cur' });
const apiL = load(sbL);
apiL._reset();
const prev = new Map([['bg1', { id: 'bg1', workflowState: 'running' }]]);
const next = [
  { id: 'bg1', workflowState: 'waiting_user', workflowStateChangedAt: 't9' },
  { id: 'cur', workflowState: 'waiting_user' }, // current -> must be skipped
];
apiL.onSessionsApplied(prev, next);
assert.equal(sbL._notifs.length, 1, 'a background session turning needs-action fires');
assert.equal(sbL._notifs[0].opts.tag, 'ragent-approval:bg1', 'fired for the background session');
// Re-apply with bg1 already waiting -> not a new transition.
apiL.onSessionsApplied(new Map([['bg1', next[0]]]), next);
assert.equal(sbL._notifs.length, 1, 'an already-waiting session does not re-fire');
// permission default -> hook is a no-op.
const sbDef = makeSandbox({ permission: 'default' });
const apiDef = load(sbDef);
apiDef.onSessionsApplied(new Map(), [{ id: 'bg2', workflowState: 'waiting_user' }]);
assert.equal(sbDef._notifs.length, 0, 'no notification without granted permission');

// ---------------------------------------------------------------------------
// 6. requestPermissionFromGesture — gesture-backed bootstrap
// ---------------------------------------------------------------------------
const sbG = makeSandbox({ permission: 'default' });
const apiG = load(sbG);
const res = await apiG.requestPermissionFromGesture();
assert.equal(res, 'granted', 'request resolves to granted');
assert.equal(sbG._pushBootstrapped(), 1, 'grant bootstraps the web-push subscription');
// Already granted -> still idempotently bootstraps, returns granted.
const sbG2 = makeSandbox({ permission: 'granted' });
const apiG2 = load(sbG2);
assert.equal(await apiG2.requestPermissionFromGesture(), 'granted');
assert.equal(sbG2._pushBootstrapped(), 1, 'granted path also bootstraps');
// Denied -> cannot ask.
const sbD = makeSandbox({ permission: 'denied' });
assert.equal(await load(sbD).requestPermissionFromGesture(), 'denied');

// ---------------------------------------------------------------------------
// 7. enableAffordanceShouldShow — only when permission is "default"
// ---------------------------------------------------------------------------
assert.equal(load(makeSandbox({ permission: 'default' })).enableAffordanceShouldShow(), true);
assert.equal(load(makeSandbox({ permission: 'granted' })).enableAffordanceShouldShow(), false);
assert.equal(load(makeSandbox({ permission: 'denied' })).enableAffordanceShouldShow(), false);
// dismiss hides it until reset.
const sbE = makeSandbox({ permission: 'default' });
const apiE = load(sbE);
apiE.dismissEnable();
assert.equal(apiE.enableAffordanceShouldShow(), false, 'dismissed hides the affordance');
apiE.resetEnableDismissal();
assert.equal(apiE.enableAffordanceShouldShow(), true, 'reset re-shows the affordance');

// ---------------------------------------------------------------------------
// 8. decisions-store hook — current-session approval fires only when hidden
// ---------------------------------------------------------------------------
const sbC = makeSandbox({ permission: 'granted', visible: false, currentSessionId: 'cur' });
const apiC = load(sbC);
apiC._reset();
const sub = sbC._getDecisionsSubscriber();
assert.ok(typeof sub === 'function', 'module subscribed to the decisions store');
sub({ pending: true, evt: { approvalId: 'a1', kind: 'command' } });
assert.equal(sbC._notifs.length, 1, 'current-session approval fires while hidden');
// Tab becomes visible -> the next approval is suppressed (sheet is on screen).
sbC.document.visibilityState = 'visible';
sbC.document.hidden = false;
sub({ pending: true, evt: { approvalId: 'a2', kind: 'command' } });
assert.equal(sbC._notifs.length, 1, 'current-session approval is suppressed while visible');
sub({ pending: true, evt: { approvalId: 'progress-approval', kind: 'plan', planIntent: 'progress' } });
assert.equal(sbC._notifs.length, 1, 'progress plans never fire an in-page approval notification');
// A resolved snapshot never fires.
sub({ pending: false, evt: null });
assert.equal(sbC._notifs.length, 1, 'resolved snapshot does not fire');

// ---------------------------------------------------------------------------
// 8b. privileged batch hook — danger batch fires while hidden (Phase 5)
// ---------------------------------------------------------------------------
const sbB = makeSandbox({ permission: 'granted', visible: false, currentSessionId: 'cur' });
const apiB = load(sbB);
apiB._reset();
const batchSub = sbB._getBatchSubscriber();
assert.ok(typeof batchSub === 'function', 'module subscribed to the decisions batch channel');
batchSub({ pending: true, evt: { batchId: 'b1', risk: 'danger', other: [{ opId: 'o1' }], delete: [] } });
assert.equal(sbB._notifs.length, 1, 'pending danger batch fires a notification while hidden');
assert.equal(sbB._notifs[0].opts.tag, 'ragent-approval:cur', 'batch notification tags the session');
// Resolved batch snapshot never fires.
const notifCountBefore = sbB._notifs.length;
batchSub({ pending: false, evt: null });
assert.equal(sbB._notifs.length, notifCountBefore, 'resolved batch snapshot does not fire');

console.log('✓ test-chat-approval-notify — all assertions passed');
