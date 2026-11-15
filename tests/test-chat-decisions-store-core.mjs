#!/usr/bin/env node
// Stage 1 coverage for core/decisions-store.js: direct contract assertions
// (freeze, snapshot copies, subscribe semantics) plus a scenario parity section
// that replays identical action sequences through the legacy decisions-store
// façade and the core port, comparing every emitted snapshot and query result.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadContext(relPath) {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, relPath), 'utf8'), context, { filename: relPath });
  return context;
}

const coreContext = loadContext('static/chat/core/decisions-store.js');
const core = coreContext.RagentDecisionsCore;
assert.ok(core, 'core/decisions-store.js should attach RagentDecisionsCore');

const legacyContext = loadContext('static/chat/decisions-store.js');
const legacy = legacyContext.RagentDecisions;
assert.ok(legacy, 'decisions-store.js should attach RagentDecisions');

// -- direct contract assertions ---------------------------------------------
assert.equal(Object.isFrozen(core), true, 'core API should be frozen');
assert.equal(Object.isFrozen(legacy), true, 'legacy API should be frozen');
assert.equal(typeof core.subscribe(42), 'function', 'non-function subscriber should return noop');
assert.equal(core.getPending(), null, 'fresh store has no pending approval');
assert.equal(core.getBatchState(), null, 'fresh store has no pending batch');
assert.equal(core.getPendingBatch(), null, 'fresh store has no pending batch copy');

// getPending returns a copy — mutating it must not touch store state.
core.noteRequest({ approvalId: 'copy-check', kind: 'command' });
const leaked = core.getPending();
leaked.approvalId = 'mutated';
assert.equal(core.getPending().approvalId, 'copy-check', 'getPending should return a snapshot copy');
core.reset();

// -- scenario parity ---------------------------------------------------------
function normalizeSnap(snap) {
  return JSON.parse(JSON.stringify({
    pending: snap.pending,
    evt: snap.evt,
    resolved: snap.resolved ? [...snap.resolved].sort() : undefined,
  }));
}

function makeHarness(store) {
  const events = [];
  const unsubApproval = store.subscribe((snap) => events.push(['approval', normalizeSnap(snap)]));
  const unsubBatch = store.subscribeBatch((snap) => events.push(['batch', normalizeSnap(snap)]));
  return {
    store,
    events,
    unsubApproval,
    unsubBatch,
    state() {
      const batch = store.getBatchState();
      return JSON.parse(JSON.stringify({
        pending: store.getPending(),
        pendingBatch: store.getPendingBatch(),
        batchState: batch ? { evt: batch.evt, resolved: [...batch.resolved].sort() } : null,
      }));
    },
  };
}

const actions = [
  ['noteRequest', (store) => store.noteRequest({ approvalId: 'a1', kind: 'command', title: 'run ls' })],
  ['duplicate noteRequest replay', (store) => store.noteRequest({ kind: 'command', title: 'run ls', approvalId: 'a1' })],
  ['noteRequest non-object ignored', (store) => store.noteRequest(null)],
  ['id-less replay ignores transport fields', (store) => {
    store.noteRequest({ kind: 'command', reason: 'legacy approval', timestamp: '2026-09-01T00:00:00Z', seq: 1 });
    store.noteRequest({ kind: 'command', reason: 'legacy approval', timestamp: '2026-09-01T00:00:02Z', seq: 2 });
  }],
  ['noteResponse wrong id', (store) => store.noteResponse({ approvalId: 'a9' })],
  ['noteResponse matching id', (store) => store.noteResponse({ approvalId: 'a1' })],
  ['noteResponse empty id clears', (store) => store.noteResponse({})],
  ['batch start', (store) => store.notePrivilegedBatch({ batchId: 'b1', other: [{ opId: 'o1' }], delete: [{ opId: 'd1' }] })],
  ['batch takes over paired provider approval', (store) => {
    store.noteRequest({ approvalId: 'provider-a', runId: 'run-a', kind: 'command' });
    store.notePrivilegedBatch({ batchId: 'b-paired', runId: 'run-a', other: [{ approvalId: 'provider-a', opId: 'op-a' }] });
  }],
  ['event id does not block run correlation', (store) => {
    store.noteRequest({ id: 'local-provider-event', runId: 'run-id-only', kind: 'command' });
    store.notePrivilegedBatch({ batchId: 'b-id-only', runId: 'run-id-only', other: [{ opId: 'op-id-only' }] });
  }],
  ['duplicate batch replay', (store) => store.notePrivilegedBatch({ batchId: 'b1', delete: [{ opId: 'd1' }], other: [{ opId: 'o1' }] })],
  ['batch other resolved', (store) => store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'privileged_other' })],
  ['duplicate batch response', (store) => store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'other' })],
  ['batch stale response ignored', (store) => store.notePrivilegedBatchResponse({ batchId: 'stale', category: 'destructive_delete' })],
  ['batch delete resolved clears', (store) => store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'destructive_delete' })],
  ['batch re-surface keeps resolved categories', (store) => {
    store.notePrivilegedBatch({ batchId: 'b3', other: [{ opId: 'o' }], delete: [{ opId: 'd' }] });
    store.notePrivilegedBatchResponse({ batchId: 'b3', category: 'other' });
    store.notePrivilegedBatch({ batchId: 'b3', other: [{ opId: 'o' }], delete: [{ opId: 'd' }] });
    store.notePrivilegedBatchResponse({ batchId: 'b3', category: 'delete' });
  }],
  ['batch delete-only clears on category', (store) => {
    store.notePrivilegedBatch({ batchId: 'b4', other: [], delete: [{ opId: 'd' }] });
    store.notePrivilegedBatchResponse({ batchId: 'b4', category: 'destructive_delete' });
  }],
  ['reset clears all channels', (store) => store.reset()],
];

const legacyHarness = makeHarness(legacy);
const coreHarness = makeHarness(core);
for (const [name, act] of actions) {
  act(legacyHarness.store);
  act(coreHarness.store);
  assert.deepEqual(coreHarness.events, legacyHarness.events, `${name}: event traces`);
  assert.deepEqual(coreHarness.state(), legacyHarness.state(), `${name}: store state`);
}
assert.deepEqual(coreHarness.state(), { pending: null, pendingBatch: null, batchState: null }, 'post-reset state');

// A response and a replayed request can cross on separate WS/HTTP turns. The
// resolved-id tombstone must suppress the late same-run request, while still
// allowing a legacy provider that recycles the id on a new run.
for (const [name, store] of [['legacy', legacy], ['core', core]]) {
  const replayHarness = makeHarness(store);
  replayHarness.store.noteRequest({ approvalId: 'replay-id', runId: 'run-1', kind: 'command' });
  replayHarness.store.noteResponse({ approvalId: 'replay-id', runId: 'run-1' });
  const beforeReplay = replayHarness.events.length;
  replayHarness.store.noteRequest({ approvalId: 'replay-id', runId: 'run-1', kind: 'command' });
  assert.equal(replayHarness.store.getPending(), null, `${name}: late same-run replay stays resolved`);
  assert.equal(replayHarness.events.length, beforeReplay, `${name}: late same-run replay emits no notification`);
  replayHarness.store.noteRequest({ approvalId: 'replay-id', runId: 'run-2', kind: 'command' });
  assert.equal(replayHarness.store.getPending()?.runId, 'run-2', `${name}: recycled id on a new run remains actionable`);
}

// The HTTP resolve response must close an approved-action sheet even when the
// per-action state events have not arrived yet.
for (const [name, store] of [['legacy', legacy], ['core', core]]) {
  store.reset();
  store.noteApprovedAction({
    batchId: `${name}-action-batch`,
    runId: `${name}-run`,
    actions: [{ actionId: `${name}-action`, state: 'waiting_user' }],
  });
  store.noteApprovedActionResolution({
    type: 'approved_action_batch_response',
    batchId: `${name}-action-batch`,
    runId: `${name}-run`,
    decisions: { [`${name}-action`]: 'approve' },
  });
  assert.equal(store.getPendingAction(), null, `${name}: accepted batch response clears pending action`);
  store.reset();
}

// A stale approval card can be clicked after the server has already closed
// its batch. The UI-side terminal acknowledgement must clear the whole
// channel and tombstone the id so a late replay cannot resurrect the card.
for (const [name, store] of [['legacy', legacy], ['core', core]]) {
  store.reset();
  store.beginSessionContext(`${name}-dismiss-session`, 21);
  const batchId = `${name}-dismiss-batch`;
  const actionBatchId = `${name}-dismiss-action`;
  store.notePrivilegedBatch({
    batchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
    other: [{ opId: `${name}-op` }],
    delete: [{ opId: `${name}-delete-op` }],
  });
  assert.equal(store.getPendingBatch()?.batchId, batchId, `${name}: stale batch fixture is pending`);
  assert.equal(store.dismissPrivilegedBatch({
    batchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
  }), true, `${name}: stale batch dismissal is accepted`);
  assert.equal(store.getPendingBatch(), null, `${name}: stale batch dismissal clears the whole batch`);
  store.notePrivilegedBatch({
    batchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
    other: [{ opId: `${name}-op` }],
    delete: [{ opId: `${name}-delete-op` }],
  });
  assert.equal(store.getPendingBatch(), null, `${name}: dismissed batch replay stays tombstoned`);

  store.noteApprovedAction({
    batchId: actionBatchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
    actions: [{ actionId: `${name}-action`, state: 'waiting_user' }],
  });
  assert.equal(store.getPendingAction()?.batchId, actionBatchId, `${name}: stale action fixture is pending`);
  assert.equal(store.dismissApprovedAction({
    batchId: actionBatchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
  }), true, `${name}: stale approved-action dismissal is accepted`);
  assert.equal(store.getPendingAction(), null, `${name}: stale approved-action dismissal clears the batch`);
  store.noteApprovedAction({
    batchId: actionBatchId,
    runId: `${name}-dismiss-run`,
    sessionId: `${name}-dismiss-session`,
    actions: [{ actionId: `${name}-action`, state: 'waiting_user' }],
  });
  assert.equal(store.getPendingAction(), null, `${name}: dismissed action replay stays tombstoned`);
  store.reset();
}

// Session/generation context is part of the approval identity. A delayed event
// from the previous session must be ignored, while an accepted HTTP decision
// closes immediately and suppresses the later same-run replay.
for (const [name, store] of [['legacy', legacy], ['core', core]]) {
  store.reset();
  store.beginSessionContext('session-a', 11);
  store.noteRequest({ approvalId: `${name}-ctx`, sessionId: 'session-a', runId: `${name}-run-a` });
  assert.equal(store.getPending()?.approvalId, `${name}-ctx`, `${name}: current session event accepted`);
  store.beginSessionContext('session-b', 12);
  assert.equal(store.getPending(), null, `${name}: session switch clears prior pending state`);
  store.noteRequest({ approvalId: `${name}-ctx`, sessionId: 'session-a', runId: `${name}-run-a` });
  assert.equal(store.getPending(), null, `${name}: stale previous-session request ignored`);
  store.noteRequest({ approvalId: `${name}-ack`, sessionId: 'session-b', runId: `${name}-run-b` });
  assert.equal(store.acknowledgeResponse(
    { approvalId: `${name}-ack`, runId: `${name}-run-b` },
    { sessionId: 'session-b', runId: `${name}-run-b` },
  ), true, `${name}: accepted HTTP decision acknowledged`);
  assert.equal(store.getPending(), null, `${name}: accepted HTTP decision clears pending state`);
  store.noteRequest({ approvalId: `${name}-ack`, sessionId: 'session-b', runId: `${name}-run-b` });
  assert.equal(store.getPending(), null, `${name}: same-run replay stays tombstoned`);
  store.noteRequest({ approvalId: `${name}-ack`, sessionId: 'session-b', runId: `${name}-run-c` });
  assert.equal(store.getPending()?.runId, `${name}-run-c`, `${name}: recycled approval id on new run is actionable`);
  store.beginSessionContext('', 13);
  store.noteRequest({ approvalId: `${name}-home-stale`, sessionId: 'session-b', runId: `${name}-run-c` });
  assert.equal(store.getPending(), null, `${name}: home context rejects stale session events`);
  store.reset();
}

// Unsubscribe stops delivery on both sides.
const legacyLen = legacyHarness.events.length;
const coreLen = coreHarness.events.length;
legacyHarness.unsubApproval();
legacyHarness.unsubBatch();
coreHarness.unsubApproval();
coreHarness.unsubBatch();
legacyHarness.store.noteRequest({ approvalId: 'post-unsub' });
coreHarness.store.noteRequest({ approvalId: 'post-unsub' });
assert.equal(coreHarness.events.length, coreLen, 'core: no events after unsubscribe');
assert.equal(legacyHarness.events.length, legacyLen, 'legacy: no events after unsubscribe');

console.log('test-chat-decisions-store-core: ok');
