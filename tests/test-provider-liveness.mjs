#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildProviderLivenessSnapshot,
  normalizeProviderLiveness,
  resolveProviderHeartbeatIntervalMs,
  resolveProviderOutputIdleDiagnosticMs,
} from '../chat/provider-liveness.mjs';

assert.equal(resolveProviderHeartbeatIntervalMs({}), 15000);
assert.equal(resolveProviderHeartbeatIntervalMs({ RAGENT_PROVIDER_HEARTBEAT_INTERVAL_MS: '2500' }), 2500);
assert.equal(resolveProviderOutputIdleDiagnosticMs({}), 90000);
assert.equal(resolveProviderOutputIdleDiagnosticMs({ RAGENT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS: '60000' }), 60000);

assert.equal(buildProviderLivenessSnapshot({ runtimeFamily: 'codex-json' }), null);

const recent = buildProviderLivenessSnapshot({
  runtimeFamily: 'agy-stream-json',
  nowMs: 1_000_000,
  lastOutputAtMs: 999_000,
  heartbeatCount: 3,
});
assert.equal(recent.state, 'alive');
assert.equal(recent.phase, 'provider_output_recent');
assert.equal(recent.outputIdleMs, 1000);
assert.equal(recent.heartbeatCount, 3);

const waiting = buildProviderLivenessSnapshot({
  runtimeFamily: 'agy-stream-json',
  nowMs: 1_000_000,
  lastOutputAtMs: 900_000,
  outputIdleDiagnosticMs: 90_000,
});
assert.equal(waiting.phase, 'awaiting_provider_output');
assert.equal(normalizeProviderLiveness(waiting).heartbeatAt, waiting.heartbeatAt);
assert.equal(normalizeProviderLiveness({
  ...recent,
  outputIdleMs: 0,
}).outputIdleMs, 0);
assert.equal(normalizeProviderLiveness({
  ...recent,
  lastOutputAt: 'not-a-timestamp',
}), null);
assert.equal(normalizeProviderLiveness({ phase: 'awaiting_provider_output' }), null);

console.log('test-provider-liveness: ok');
