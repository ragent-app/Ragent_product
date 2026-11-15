import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSupervisedRunner } from '../chat/runner-supervisor-daemon.mjs';
import { ensureCodexAppServerBroker } from '../chat/codex-app-server-broker.mjs';
import { spawnOpenHandsServiceProcess } from '../chat/openhands-service-sidecar.mjs';
import { spawnManagedProviderProcess } from '../lib/windows-managed-spawn.mjs';

test('supervisor rechecks authority after proxy discovery and before sidecar spawn', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  let checks = 0;
  let spawned = false;
  const deadline = start + 1000;
  Date.now = () => now;
  try {
    await assert.rejects(spawnSupervisedRunner('run_deadline_supervisor_123', {
      platform: 'win32',
      assertExecutionIdentityImpl: async () => {},
      assertExecutionBoundaryImpl: async () => {
        checks += 1;
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Control grant expired'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
        }
      },
      resolveRunnerProxyEnvironmentImpl: async () => { now = deadline; return {}; },
      spawnImpl: () => { spawned = true; return { pid: 123, unref() {} }; },
    }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    assert.equal(checks, 2);
    assert.equal(spawned, false);
  } finally { Date.now = originalNow; }
});

test('broker creation rechecks authority after the broker lock wait', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  let spawned = false;
  const deadline = start + 1000;
  Date.now = () => now;
  try {
    await assert.rejects(ensureCodexAppServerBroker({
      socketPath: `\\\\.\\pipe\\ragent-deadline-broker-${process.pid}`,
      upstreamFile: process.execPath,
      acquireLockImpl: async () => {
        now = deadline;
        return { release: async () => {} };
      },
      assertLaunchBoundary: async () => {
        if (Date.now() >= deadline) throw Object.assign(new Error('Control grant expired'),
          { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      },
      spawnImpl: () => { spawned = true; throw Object.assign(new Error('unexpected spawn'), { code: 'UNEXPECTED_SPAWN' }); },
    }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    assert.equal(spawned, false);
  } finally { Date.now = originalNow; }
});

test('OpenHands command resolution can expire before service process spawn', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  let spawned = false;
  const deadline = start + 1000;
  Date.now = () => now;
  try {
    await assert.rejects(spawnOpenHandsServiceProcess({
      command: 'agent-canvas',
      resolveCommandPathImpl: async () => { now = deadline; return process.execPath; },
      assertLaunchBoundary: async () => {
        if (Date.now() >= deadline) throw Object.assign(new Error('Control grant expired'),
          { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      },
      spawnManagedImpl: async () => { spawned = true; return { pid: 123 }; },
    }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    assert.equal(spawned, false);
  } finally { Date.now = originalNow; }
});

test('async authority check after Windows Job host setup prevents Harness creation', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  let created = false;
  let closed = false;
  const deadline = start + 1000;
  Date.now = () => now;
  try {
    await assert.rejects(spawnManagedProviderProcess({ file: process.execPath, args: [] }, {
      assertAuthorization: async () => {
        await Promise.resolve();
        if (Date.now() >= deadline) throw Object.assign(new Error('Control grant expired'),
          { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      },
    }, {
      platform: 'win32',
      createWindowsJobObject: async () => {
        now = deadline;
        return {
          createProcess: async () => { created = true; throw new Error('must not create'); },
          terminate: async () => {},
          close: async () => { closed = true; },
        };
      },
    }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    assert.equal(created, false);
    assert.equal(closed, true);
  } finally { Date.now = originalNow; }
});
