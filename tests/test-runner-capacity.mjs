#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  checkRunnerCapacity,
  evaluateRunnerCapacity,
  readLinuxRunnerFleetSnapshot,
  resolveRunnerCapacityLimits,
} from '../chat/runner-capacity.mjs';

const GiB = 1024 * 1024 * 1024;

assert.deepEqual(
  resolveRunnerCapacityLimits({
    RAGENT_RUN_CAPACITY_MAX_CONCURRENT: '3',
    RAGENT_RUN_CAPACITY_MAX_MEMORY_BYTES: String(9 * GiB),
    RAGENT_RUN_CAPACITY_MAX_TASKS: '400',
  }),
  { maxConcurrentRuns: 3, maxMemoryBytes: 9 * GiB, maxTasks: 400 },
);

const saturated = evaluateRunnerCapacity(
  { activeRuns: 3, memoryCurrentBytes: 10 * GiB, pidsCurrent: 401 },
  { maxConcurrentRuns: 3, maxMemoryBytes: 9 * GiB, maxTasks: 400 },
);
assert.equal(saturated.accepted, false);
assert.deepEqual(saturated.reasons, ['concurrency', 'memory', 'tasks']);

const snapshot = await readLinuxRunnerFleetSnapshot({
  roots: ['/cgroup/test'],
  readFileImpl: async (path) => path.endsWith('memory.current') ? '123\n' : '45\n',
  readdirImpl: async () => [
    'ragent-runner-run_first.service',
    'ragent-runner-run_second.service',
    'unrelated.service',
  ],
});
assert.deepEqual(snapshot, {
  root: '/cgroup/test',
  activeRuns: 2,
  activeRunnerUnits: ['ragent-runner-run_first.service', 'ragent-runner-run_second.service'],
  memoryCurrentBytes: 123,
  pidsCurrent: 45,
});

const check = await checkRunnerCapacity({
  platform: 'win32',
  environment: { RAGENT_RUN_CAPACITY_MAX_CONCURRENT: '2' },
  readSnapshot: async () => ({ activeRuns: 2, memoryCurrentBytes: 0, pidsCurrent: 0 }),
});
assert.equal(check.accepted, false);
assert.deepEqual(check.reasons, ['concurrency']);

console.log('test-runner-capacity: ok');
