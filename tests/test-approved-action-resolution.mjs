import assert from 'node:assert/strict';
import { mkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

import {
  APPROVED_ACTION_STATE,
  buildApprovedActionBatch,
  computeApprovedActionSelectionHash,
} from '../chat/approved-actions.mjs';
import { createApprovedActionStore, recoverApprovedActionBatches } from '../chat/approved-action-store.mjs';
import { executeApprovedAction } from '../chat/approved-action-executor.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-approved-action-resolution-'));
try {
const batch = buildApprovedActionBatch([
  { command: 'sudo systemctl restart nginx', description: 'Restart nginx', category: 'privileged_other' },
  { command: 'rm -f /tmp/ragent-approved-action-fixture', description: 'Remove fixture', category: 'destructive_delete' },
], {
  requestKey: 'resolution-fixture',
  sessionId: 'session-fixture',
  runId: 'run-fixture',
  turnId: 'turn-fixture',
  cwd: root,
  projectRoot: root,
  home: '/home/example',
});

const events = [];
const store = createApprovedActionStore({
  readEvents: async () => events.slice(),
  appendEvent: async (event) => {
    const stored = { ...event, seq: events.length + 1 };
    events.push(stored);
    return stored;
  },
});

const proposed = await store.propose(batch.actions.map((action) => ({
  actionId: action.actionId,
  command: action.sawLeadingSudo ? `sudo ${action.canonicalCommand}` : action.canonicalCommand,
  cwd: action.cwd,
  category: action.declaredCategory,
  description: action.originalRequest.description,
}),), {
  requestKey: batch.requestKey,
  sessionId: batch.sessionId,
  runId: batch.runId,
  turnId: batch.turnId,
  cwd: root,
  projectRoot: root,
  home: '/home/example',
});
assert.equal(proposed.duplicate, false);
assert.equal(proposed.batch.actions.every((action) => action.state === APPROVED_ACTION_STATE.WAITING_USER), true);

const recovered = await store.get(proposed.batch.batchId);
const host = recovered.actions.find((action) => action.executionClass === 'host');
const session = recovered.actions.find((action) => action.executionClass === 'session');
assert.ok(host, 'fixture must include a host action');
assert.ok(session, 'fixture must include a session action');

await assert.rejects(
  store.resolveBatch(recovered.batchId, { [host.actionId]: 'approve' }),
  (error) => error.code === 'APPROVED_ACTION_DECISION_INCOMPLETE',
);

const selectionHash = computeApprovedActionSelectionHash([host]);
const resolved = await store.resolveBatch(recovered.batchId, {
  [host.actionId]: 'approve',
  [session.actionId]: 'deny',
}, {
  source: 'owner',
  selectionManifestHash: selectionHash,
  authorization: { source: 'owner', credentialId: 'cred-fixture', selectionManifestHash: selectionHash },
});
assert.equal(resolved.duplicate, false);
assert.equal(resolved.actions.find((action) => action.actionId === host.actionId).state, APPROVED_ACTION_STATE.AUTHORIZED);
assert.equal(resolved.actions.find((action) => action.actionId === session.actionId).state, APPROVED_ACTION_STATE.DENIED);
assert.ok(events.some((event) => event.type === 'approved_action_batch_response'));

const duplicate = await store.resolveBatch(recovered.batchId, {
  [host.actionId]: 'approve',
  [session.actionId]: 'deny',
});
assert.equal(duplicate.duplicate, true);

const executing = await store.transition(host.actionId, APPROVED_ACTION_STATE.EXECUTING, {
  authorization: resolved.actions.find((action) => action.actionId === host.actionId).authorization,
});
assert.equal(executing.state, APPROVED_ACTION_STATE.EXECUTING);
const completed = await store.transition(host.actionId, APPROVED_ACTION_STATE.COMPLETED, {
  resultRef: { exitCode: 0 },
});
assert.equal(completed.state, APPROVED_ACTION_STATE.COMPLETED);

const sessionResult = await executeApprovedAction({
  actionId: 'aa_session_fixture',
  executionClass: 'session',
  argv: [process.execPath, '-e', 'process.stdout.write("approved-action-ok")'],
  cwd: root,
}, { sessionId: 'session-fixture', runId: 'run-fixture', turnId: 'turn-fixture' });
assert.equal(sessionResult.ok, true);
assert.equal(sessionResult.resultRef.stdout, 'approved-action-ok');

const tampered = recoverApprovedActionBatches([{
  type: 'approved_action_batch_request',
  channel: 'approved_action',
  batchId: 'tampered',
  sessionId: 's',
  runId: 'r',
  turnId: 't',
  actions: [{ ...host, batchId: 'tampered', manifestHash: 'not-the-record' }],
}]);
assert.equal(tampered.length, 1);
assert.equal(tampered[0].actions[0].manifestHash, 'not-the-record');

const tamperedEvents = events.map((event) => event.type === 'approved_action_batch_request'
  ? { ...event, actions: event.actions.map((action) => action.actionId === host.actionId
    ? { ...action, manifestHash: 'tampered' } : action) }
  : event);
const tamperedStore = createApprovedActionStore({
  readEvents: async () => tamperedEvents,
  appendEvent: async (event) => event,
});
await assert.rejects(
  tamperedStore.transition(host.actionId, APPROVED_ACTION_STATE.DENIED),
  (error) => error.code === 'APPROVED_ACTION_MANIFEST_MISMATCH',
);

console.log('test-approved-action-resolution: ok');
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('ragent-approved-action-resolution-'));
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.equal((await realpath(root)).toLowerCase(), resolve(root).toLowerCase());
  await rm(root, { recursive: true, force: true });
}
