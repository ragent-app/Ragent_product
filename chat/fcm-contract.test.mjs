import assert from 'node:assert/strict';
import test from 'node:test';
import { createFcmMessageData } from './fcm.mjs';

test('FCM lifecycle payload preserves approval and run identity', () => {
  const data = createFcmMessageData({
    sessionId: 'session-1',
    kind: 'approval',
    awaitingKey: 'approval-1',
    eventId: 'approval-1',
    runId: 'run-1',
  }, 'instance-1');

  assert.equal(data.eventId, 'approval-1');
  assert.equal(data.runId, 'run-1');
  assert.equal(data.sessionId, 'session-1');
  assert.equal(data.instanceId, 'instance-1');
});

test('FCM rejects invalid run identity before sending', () => {
  assert.throws(() => createFcmMessageData({
    sessionId: 'session-1',
    runId: 'x'.repeat(257),
  }, 'instance-1'), /Invalid FCM runId/);
});
