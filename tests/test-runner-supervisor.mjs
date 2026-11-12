#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import {
  DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
  DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
  DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE,
  buildDetachedRunnerUnitName,
  createDetachedRunnerSpawner,
  detectSystemdManagerScope,
  launchDetachedRunnerViaSupervisor,
  launchDetachedRunnerViaSystemd,
} from '../chat/runner-supervisor.mjs';
import { createRunnerSupervisorServer, spawnSupervisedRunner } from '../chat/runner-supervisor-daemon.mjs';

// Launch-strategy fixtures have no durable Run and never execute a real tool.
// Actual publication/boundary admission is covered in test-run-execution-boundary.
const strategyFixtureBoundary = async () => {};

// This unit suite exercises legacy supervisor fallback explicitly.  Production
// shells may export the new lifecycle broker socket, so isolate it here.
const previousLifecycleSocket = process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
const previousLifecycleRequired = process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;
delete process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
delete process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;

function testSupervisorSocket(directory) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentoc-supervisor-test-${process.pid}-${randomBytes(8).toString('hex')}`
    : join(directory, 'runner.sock');
}

assert.equal(buildDetachedRunnerUnitName('run_abc/123'), 'agentoc-runner-run_abc_123');
assert.equal(detectSystemdManagerScope('0::/system.slice/agentoc.service\n'), 'system');
assert.equal(
  detectSystemdManagerScope('0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentoc-chat.service\n'),
  'user',
);
assert.equal(detectSystemdManagerScope('0::/init.scope\n'), null);

{
  const calls = [];
  const result = await launchDetachedRunnerViaSystemd('run_demo/123', {
    scope: 'system',
    workingDirectory: '/opt/agentoc',
    processExecPath: '/usr/bin/node',
    runnerScriptPath: '/opt/agentoc/chat/runner-sidecar.mjs',
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (command === 'systemd-run') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'systemctl') {
        return { stdout: '43210\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.pid, 43210);
  assert.equal(result.unitName, 'agentoc-runner-run_demo_123');
  assert.equal(result.unitScope, 'system');
  assert.equal(result.launchMode, DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE);
  assert.equal(calls[0].command, 'systemd-run');
  assert.deepEqual(calls[0].args.slice(0, 7), [
    '--quiet',
    '--collect',
    '--no-block',
    '--service-type=exec',
    '--unit',
    'agentoc-runner-run_demo_123',
    '--working-directory',
  ]);
  assert.ok(calls[0].args.includes('AGENTOC_RUNNER_UNIT_NAME=agentoc-runner-run_demo_123'));
  assert.ok(calls[0].args.includes(`AGENTOC_RUNNER_LAUNCH_MODE=${DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE}`));
  assert.equal(calls[1].command, 'systemctl');
  assert.deepEqual(calls[1].args, ['show', '--property=MainPID', '--value', 'agentoc-runner-run_demo_123']);
}

{
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentoc-runner-supervisor-'));
  const socketPath = testSupervisorSocket(temporaryDirectory);
  let launchedRunId = '';
  const supervisor = await createRunnerSupervisorServer({
    socketPath,
    spawnRunner(runId) {
      launchedRunId = runId;
      return { pid: 76543 };
    },
  });
  try {
    const result = await launchDetachedRunnerViaSupervisor('run_supervised123', { socketPath });
    assert.equal(launchedRunId, 'run_supervised123');
    assert.equal(result.pid, 76543);
    assert.equal(result.launchMode, DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE);
    assert.equal(result.supervisorSocket, socketPath);
  } finally {
    await supervisor.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

{
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentoc-runner-supervisor-lock-'));
  const socketPath = testSupervisorSocket(temporaryDirectory);
  const providerHomesRoot = join(temporaryDirectory, 'provider-homes');
  const providerHome = join(providerHomesRoot, 'by-provider', 'a'.repeat(32));
  const oauthLockPath = join(providerHome, '.agentoc-native-oauth.lock');
  let launchOptions = null;
  const supervisor = await createRunnerSupervisorServer({
    socketPath,
    providerHomesRoot,
    spawnRunner(runId, options) {
      launchOptions = { runId, options };
      return { pid: 76545 };
    },
  });
  try {
    const result = await launchDetachedRunnerViaSupervisor('run_supervised_lock123', {
      socketPath,
      prepareProviderImpl: async () => ({
        manifest: {},
        providerId: 'codex-official',
        providerHomesDir: providerHome,
        oauthLock: { path: oauthLockPath, token: 'test-oauth-lock-token' },
      }),
    });
    assert.equal(result.pid, 76545);
    assert.deepEqual(launchOptions, {
      runId: 'run_supervised_lock123',
      options: {
        providerHomesDir: providerHome,
        oauthLockPath,
        oauthLockToken: 'test-oauth-lock-token',
      },
    });
  } finally {
    await supervisor.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

{
  let spawnInvocation = null;
  let unrefCalled = false;
  const result = await spawnSupervisedRunner('run_windows_supervisor_crash', {
    assertExecutionBoundaryImpl: strategyFixtureBoundary,
    platform: 'win32',
    // This assertion simulates Windows detachment on all CI platforms; actual
    // Windows token admission is covered by test-windows-execution-identity.
    assertExecutionIdentityImpl: async () => {},
    spawnImpl: (command, args, options) => {
      spawnInvocation = { command, args, options };
      return {
        pid: 76544,
        unref() {
          unrefCalled = true;
        },
      };
    },
  });
  assert.equal(result.pid, 76544);
  assert.equal(spawnInvocation.options.detached, true, 'Windows supervisor must detach the sidecar');
  assert.equal(spawnInvocation.options.stdio, 'ignore');
  assert.equal(unrefCalled, true, 'detached Windows sidecar must be unrefed');

  await spawnSupervisedRunner('run_windows_supervisor_lock', {
    assertExecutionBoundaryImpl: strategyFixtureBoundary,
    oauthLockPath: '/var/lib/agentoc-run/provider-homes/.agentoc-native-oauth.lock',
    oauthLockToken: 'test-oauth-lock-token',
    spawnImpl: (command, args, options) => {
      spawnInvocation = { command, args, options };
      return { pid: 76546, unref() {} };
    },
  });
  assert.equal(
    spawnInvocation.options.env.AGENTOC_NATIVE_OAUTH_LOCK_PATH,
    '/var/lib/agentoc-run/provider-homes/.agentoc-native-oauth.lock',
    'supervisor must pass the native OAuth lock path to the sidecar',
  );
  assert.equal(
    spawnInvocation.options.env.AGENTOC_NATIVE_OAUTH_LOCK_TOKEN,
    'test-oauth-lock-token',
    'supervisor must pass the native OAuth lock token to the sidecar',
  );
}

{
  const previousSocket = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  const previousRequired = process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = join(tmpdir(), `missing-agentoc-supervisor-${process.pid}.sock`);
  process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '1';
  const spawner = createDetachedRunnerSpawner({ getScopeImpl: () => null, assertExecutionBoundaryImpl: strategyFixtureBoundary });
  await assert.rejects(
    () => spawner('run_required_supervisor'),
    /Required runner supervisor is unavailable/,
  );
  if (previousSocket === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = previousSocket;
  if (previousRequired === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = previousRequired;
}

{
  const previousSocket = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  const previousRequired = process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  const spawner = createDetachedRunnerSpawner({
    assertExecutionBoundaryImpl: strategyFixtureBoundary,
    platform: 'win32',
    getScopeImpl: () => null,
    spawnImpl: () => { throw new Error('plain detached process must not be reached on Win32'); },
  });
  await assert.rejects(
    () => spawner('run_windows_requires_supervisor'),
    /Windows managed runner requires an available runner lifecycle or supervisor broker/,
  );
  if (previousSocket === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = previousSocket;
  if (previousRequired === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = previousRequired;
}

{
  const previousSocket = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  const previousRequired = process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = join(tmpdir(), `missing-agentoc-windows-supervisor-${process.pid}.sock`);
  delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  const spawner = createDetachedRunnerSpawner({
    assertExecutionBoundaryImpl: strategyFixtureBoundary,
    platform: 'win32',
    getScopeImpl: () => null,
    spawnImpl: () => { throw new Error('plain detached process must not be reached on Win32'); },
  });
  await assert.rejects(
    () => spawner('run_windows_supervisor_unavailable'),
    /Required runner supervisor is unavailable/,
  );
  if (previousSocket === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = previousSocket;
  if (previousRequired === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = previousRequired;
}

{
  let spawnInvocation = null;
  let unrefCalled = false;
  const previousSandbox = process.env.IS_SANDBOX;
  const discoveryRuns = [];
  const previousSupervisorSocket = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  const previousSupervisorRequired = process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  process.env.IS_SANDBOX = '';
  delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  const spawner = createDetachedRunnerSpawner({
    assertExecutionBoundaryImpl: strategyFixtureBoundary,
    platform: 'linux',
    scheduleRunDiscoveryImpl: async (runId) => { discoveryRuns.push(runId); throw new Error('advisory discovery failure'); },
    getScopeImpl: () => 'system',
    execFileImpl: async (command) => {
      if (command === 'systemd-run') {
        throw new Error('synthetic systemd-run failure');
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    spawnImpl: (command, args, options) => {
      spawnInvocation = { command, args, options };
      return {
        pid: 65432,
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  const result = await spawner('run_fallback');
  await Promise.resolve();
  assert.deepEqual(discoveryRuns, ['run_fallback']);
  assert.equal(result.pid, 65432);
  assert.equal(result.unitName, null);
  assert.equal(result.unitScope, null);
  assert.equal(result.launchMode, DETACHED_RUNNER_PROCESS_LAUNCH_MODE);
  assert.equal(spawnInvocation.command, process.execPath);
  assert.match(spawnInvocation.args[0], /[\\/]chat[\\/]runner-sidecar\.mjs$/);
  assert.equal(spawnInvocation.args[1], 'run_fallback');
  assert.equal(spawnInvocation.options.detached, true);
  assert.equal(spawnInvocation.options.stdio, 'ignore');
  assert.equal(
    spawnInvocation.options.env.AGENTOC_RUNNER_LAUNCH_MODE,
    DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
  );
  assert.equal(spawnInvocation.options.env.IS_SANDBOX, '1');
  assert.equal(unrefCalled, true);
  process.env.IS_SANDBOX = '0';
  spawnInvocation = null;
  await spawner('run_fallback_disabled');
  assert.equal(spawnInvocation.options.env.IS_SANDBOX, '0');
  process.env.IS_SANDBOX = previousSandbox;
  if (previousSupervisorSocket === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = previousSupervisorSocket;
  if (previousSupervisorRequired === undefined) delete process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED;
  else process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = previousSupervisorRequired;
}

if (previousLifecycleSocket === undefined) delete process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
else process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = previousLifecycleSocket;
if (previousLifecycleRequired === undefined) delete process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;
else process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED = previousLifecycleRequired;
console.log('test-runner-supervisor: ok');
