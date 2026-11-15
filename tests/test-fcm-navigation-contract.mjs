import assert from 'node:assert/strict';
import { createFcmMessageData } from '../chat/fcm.mjs';

const payload = { sessionId: 'same-session', kind: 'attention', awaitingKey: 'q1', title: 'Ragent', body: 'Question' };
const a = createFcmMessageData({ ...payload, instanceId: 'forged', notificationContractVersion: '99', token: 'secret', autoStart: true }, 'inst_a');
assert.equal(a.instanceId, 'inst_a');
assert.equal(a.notificationContractVersion, '1');
assert.equal(a.sessionId, 'same-session');
assert.equal(a.awaitingKey, 'q1');
assert.equal(a.eventId, '');
assert.equal(a.token, undefined);
assert.equal(a.autoStart, undefined);
assert.ok(Object.values(a).every(value => typeof value === 'string'));
assert.notEqual(createFcmMessageData(payload, 'inst_b').instanceId, a.instanceId);
for (const bad of [null, {}, { sessionId: '../s' }, { ...payload, kind: true }, { ...payload, eventId: 'x'.repeat(257) },
  { ...payload, awaitingKey: '中'.repeat(171) }, { ...payload, body: 'x\nsecret' }]) {
  assert.throws(() => createFcmMessageData(bad, 'inst_a'));
}
assert.throws(() => createFcmMessageData(payload, ''));
assert.throws(() => createFcmMessageData(payload, 'a/b'));
console.log('test-fcm-navigation-contract: 18 assertions passed');
