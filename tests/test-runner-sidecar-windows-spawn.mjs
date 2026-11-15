#!/usr/bin/env node
import assert from 'node:assert/strict';

import { spawnFreshCodexRecoverySidecar } from '../lib/runner-sidecar-recovery.mjs';

const calls = [];
let unrefCalled = false;
const replacement = {
  pid: 76547,
  unref() {
    unrefCalled = true;
  },
};

const result = await spawnFreshCodexRecoverySidecar({
  runId: 'run_fresh_recovery_123',
  cwd: '/tmp/ragent-runner-sidecar-test',
  runnerScriptPath: '/tmp/ragent-runner-sidecar-test/chat/runner-sidecar.mjs',
  env: {
    PATH: '/usr/bin',
    RAGENT_TEST_MARKER: 'fresh-recovery',
  },
  spawnManagedImpl: async (spec, options) => {
    calls.push({ spec, options });
    return replacement;
  },
});

assert.equal(result, replacement);
assert.equal(unrefCalled, true);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].spec, {
  ...(process.platform === 'win32' ? { kind: 'exe' } : {}),
  file: process.execPath,
  args: [
    '/tmp/ragent-runner-sidecar-test/chat/runner-sidecar.mjs',
    'run_fresh_recovery_123',
  ],
  cwd: '/tmp/ragent-runner-sidecar-test',
  env: {
    PATH: '/usr/bin',
    RAGENT_TEST_MARKER: 'fresh-recovery',
    RAGENT_CODEX_FORCE_FRESH_RECOVERY: '1',
  },
  shell: false,
});
assert.deepEqual(calls[0].options, {
  stdio: 'ignore',
  detached: true,
  preserveOnControllerExit: true,
});

await assert.rejects(
  () => spawnFreshCodexRecoverySidecar({
    runId: '',
    spawnManagedImpl: async () => replacement,
  }),
  /requires a run id/,
);

console.log('test-runner-sidecar-windows-spawn: recovery sidecar uses the managed lifecycle facade');
