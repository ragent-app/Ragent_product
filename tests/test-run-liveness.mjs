import assert from 'node:assert/strict';
import {
  DEFAULT_RUN_HEARTBEAT_STALE_MS,
  getRunHeartbeatAgeMs,
  resolveRunHeartbeatStaleMs,
  shouldMarkRunStalled,
} from '../chat/run-liveness.mjs';

const nowMs = Date.parse('2026-09-04T00:00:00.000Z');
const staleHeartbeat = new Date(nowMs - DEFAULT_RUN_HEARTBEAT_STALE_MS - 1).toISOString();
const freshHeartbeat = new Date(nowMs - 1000).toISOString();

assert.equal(resolveRunHeartbeatStaleMs({}), DEFAULT_RUN_HEARTBEAT_STALE_MS);
assert.equal(resolveRunHeartbeatStaleMs({ RAGENT_RUN_HEARTBEAT_STALE_MS: '120000' }), 120000);
assert.equal(getRunHeartbeatAgeMs({ runnerHeartbeatAt: staleHeartbeat }, nowMs), DEFAULT_RUN_HEARTBEAT_STALE_MS + 1);
assert.equal(shouldMarkRunStalled({ state: 'running', runnerHeartbeatAt: staleHeartbeat }, { nowMs }), true);
assert.equal(shouldMarkRunStalled({ state: 'running', runnerHeartbeatAt: freshHeartbeat }, { nowMs }), false);
assert.equal(shouldMarkRunStalled({
  state: 'running',
  runnerHeartbeatAt: staleHeartbeat,
  cancelRequested: true,
}, { nowMs }), false);
assert.equal(shouldMarkRunStalled({
  state: 'waiting_user',
  runnerHeartbeatAt: staleHeartbeat,
}, { nowMs }), false);
assert.equal(shouldMarkRunStalled({
  state: 'running',
  runnerStartedAt: staleHeartbeat,
}, { nowMs }), true);

console.log('test-run-liveness: passed');
