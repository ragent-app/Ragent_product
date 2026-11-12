import assert from 'node:assert/strict';
import { MAC_CLEANUP_NOTIFICATION, macCancellationCleanupStatus, readMacCleanupNotification } from '../chat/macos-codex-cancellation.mjs';
import { projectApiRun } from '../chat/run-api-contract.mjs';

const identity = { threadId: 'thread-1', runId: 'run-1' };
const event = (status, runId = 'run-1', threadId = 'thread-1') => ({
  method: MAC_CLEANUP_NOTIFICATION, params: { threadId, runId, status },
});
assert.equal(readMacCleanupNotification(event('attempted'), identity), 'attempted');
assert.equal(readMacCleanupNotification(event('unconfirmed', null), identity), 'unconfirmed');
assert.equal(readMacCleanupNotification(event('attempted', 'other-run'), identity), null);
assert.equal(readMacCleanupNotification(event('attempted', null), identity), null);
assert.equal(readMacCleanupNotification(event('unconfirmed', 'other-run'), identity), null);
assert.equal(readMacCleanupNotification(event('attempted', 'run-1', 'other-thread'), identity), null);
assert.equal(readMacCleanupNotification(event('verified'), identity), null);

const base = { platform: 'darwin', brokered: true, cancelled: true, interruptSent: true };
assert.equal(macCancellationCleanupStatus({ ...base, observed: 'attempted' }), 'attempted');
assert.equal(macCancellationCleanupStatus({ ...base, observed: 'unconfirmed' }), 'unconfirmed');
assert.equal(macCancellationCleanupStatus(base), 'unconfirmed');
assert.equal(macCancellationCleanupStatus({ ...base, platform: 'linux' }), null);
assert.equal(macCancellationCleanupStatus({ ...base, cancelled: false }), null);
assert.equal(macCancellationCleanupStatus({ ...base, interruptSent: false }), null);

const time = '2026-11-12T02:00:00.000Z';
const run = { id: 'run-1', sessionId: 'session-1', state: 'cancelled', createdAt: time, updatedAt: time,
  cancelRequested: true, cancellationCleanupStatus: 'unconfirmed' };
const projected = projectApiRun(run);
assert.equal(projected.cancellationCleanupStatus, 'unconfirmed');
assert.notEqual(projected.revision, projectApiRun({ ...run, cancellationCleanupStatus: 'attempted' }).revision);
assert.equal(projectApiRun({ ...run, cancellationCleanupStatus: 'arbitrary' }).cancellationCleanupStatus, undefined);
assert.equal(projectApiRun({ ...run, cancelRequested: false }).cancellationCleanupStatus, undefined);
console.log('macOS cancellation result checks passed');
