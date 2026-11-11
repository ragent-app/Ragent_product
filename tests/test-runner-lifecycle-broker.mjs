#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLifecycleSystemdArgs,
  createRunnerLifecycleServer,
  launchLifecycleRunner,
  readLifecycleSystemdUnitState,
  readWorkspaceAccessScope,
  resolveRunnerResourceProfile,
  resolveRunnerOwnership,
  resolveRunnerInheritedGroups,
} from '../scripts/runner-lifecycle-broker.mjs';
import {
  DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
  createDetachedRunnerSpawner,
  launchDetachedRunnerViaLifecycleBroker,
} from '../chat/run-launcher.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-runner-lifecycle-'));
const socketPath = join(root, 'lifecycle.sock');
const launches = [];
const server = await createRunnerLifecycleServer({
  socketPath,
  serviceUser: 'svc',
  serviceGroup: 'svc',
  controlUser: 'example',
  chownImpl: async () => {},
  launchRunner: async (runId, options) => {
    launches.push({ runId, options });
    return {
      pid: 43210,
      unitName: `agentoc-runner-${runId}`,
      unitScope: 'system',
      launchMode: DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
    };
  },
});

try {
  // An optional broker can fall back after an outage, but a definite safety
  // refusal must never be bypassed by launching through a different path.
  const refusalSocket = join(root, 'refusal.sock');
  let refusalCode = '';
  const refusalServer = await createRunnerLifecycleServer({
    socketPath: refusalSocket, serviceUser: 'svc', serviceGroup: 'svc', controlUser: 'example',
    chownImpl: async () => {}, launchRunner: async () => { throw Object.assign(new Error('refused'), { code: refusalCode }); },
  });
  const oldLifecycleSocket = process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
  const oldLifecycleRequired = process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;
  try {
    process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = refusalSocket;
    delete process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;
    const spawner = createDetachedRunnerSpawner({
      assertExecutionBoundaryImpl: async () => {}, getScopeImpl: () => null,
      spawnImpl: () => { throw new Error('unsafe fallback reached'); },
    });
    for (const code of ['RUNNER_IDENTITY_INVALID', 'RUNNER_UNIT_STATUS_UNAVAILABLE', 'RUNNER_UNIT_DRAINING']) {
      refusalCode = code;
      await assert.rejects(() => spawner('run_refused123'), error => error.code === code);
    }
  } finally {
    if (oldLifecycleSocket === undefined) delete process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
    else process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = oldLifecycleSocket;
    if (oldLifecycleRequired === undefined) delete process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED;
    else process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED = oldLifecycleRequired;
    await refusalServer.close();
  }
  const args = buildLifecycleSystemdArgs('run_abc12345', {
    projectRoot: '/opt/agentoc/app',
    runnerEntry: '/opt/agentoc/app/chat/runner-sidecar.mjs',
    processExecPath: '/opt/agentoc/runtime/node',
    serviceUser: 'example',
    serviceGroup: 'example',
    inheritedGroups: ['example', 'sudo', 'docker', 'agentoc-privileged'],
    environment: {
      AGENTOC_CONFIG_DIR: '/var/lib/agentoc/config',
      AGENTOC_INSTANCE_ROOT: '/var/lib/agentoc',
      AGENTOC_MEMORY_DIR: '/var/lib/agentoc/memory',
      AGENTOC_WORK_ROOT_DIR: '/var/lib/agentoc/workspace',
      AGENTOC_PUBLIC_BASE_URL: 'https://example.com',
      AGENTOC_RUNNER_LIFECYCLE_SOCKET: '/var/lib/agentoc/config/runner-lifecycle.sock',
      MY_SERVICE_TOKEN: 's3cret',
      PATH: '/bin',
      LANG: 'C.UTF-8',
      AGENTOC_PROJECT_ROOT: '/opt/agentoc/app',
      HOME: '/home/example',
      AGENTOC_RUN_SPOOL_DIR: '/var/lib/agentoc/config/chat-runs',
      AGENTOC_NATIVE_OAUTH_LOCK_PATH: '/var/lib/agentoc/provider-homes/by-provider/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.agentoc-native-oauth.lock',
      AGENTOC_NATIVE_OAUTH_LOCK_TOKEN: 'test-oauth-lock-token',
      DISPLAY: ':1',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      XDG_RUNTIME_DIR: '/run/user/1000',
    },
  });
  assert.ok(args.includes('--slice'));
  assert.ok(args.includes('agentoc-runners.slice'));
  assert.ok(args.includes('--property'));
  assert.ok(args.includes('KillMode=control-group'));
  assert.ok(args.includes(`MemoryHigh=${4 * 1024 * 1024 * 1024}`));
  assert.ok(args.includes(`MemoryMax=${6 * 1024 * 1024 * 1024}`));
  assert.ok(args.includes('TasksMax=256'));
  assert.ok(args.includes('CPUWeight=100'));
  assert.ok(args.includes('User=example'));
  assert.ok(args.includes('SupplementaryGroups=example'));
  assert.ok(args.some((value) => value.startsWith('InaccessiblePaths=/etc/agentoc ')));
  // The config directory itself is masked, never its /var/lib/agentoc parent:
  // masking the parent made the shared work root workspace unreachable inside
  // the transient unit namespace.
  const inaccessible = args.find((value) => value.startsWith('InaccessiblePaths='));
  assert.ok(inaccessible.includes('/var/lib/agentoc/config'), 'the config directory itself is masked');
  assert.equal(inaccessible.includes('/var/lib/agentoc /var/log'), false, 'the /var/lib/agentoc parent must stay reachable');
  assert.equal(args.some((value) => value.startsWith('SupplementaryGroups=') && value.includes('sudo')), false, 'sudo must never reach the transient unit');
  assert.equal(args.some((value) => value.startsWith('SupplementaryGroups=') && value.includes('docker')), false, 'docker must never reach the transient unit');
  assert.equal(args.some((value) => value.startsWith('SupplementaryGroups=') && value.includes('agentoc-privileged')), false, 'privileged executor group must never reach the transient unit');
  assert.ok(args.includes('NoNewPrivileges=false'), 'provider Runs must not inherit NoNewPrivileges');
  assert.equal(args.includes('NoNewPrivileges=true'), false, 'provider Runs must not set NoNewPrivileges=true');
  assert.equal(args.at(-1), 'run_abc12345');
  assert.deepEqual(
    resolveRunnerResourceProfile({ options: { resourceProfile: 'emulator' } }),
    { name: 'emulator', memoryHigh: 12 * 1024 * 1024 * 1024, memoryMax: 16 * 1024 * 1024 * 1024, tasksMax: 768, cpuWeight: 200 },
    'explicit emulator profile must receive its isolated resource budget',
  );
  assert.equal(
    resolveRunnerResourceProfile({ executionScope: { cwd: { realPath: '/work/android/app' } } }).name,
    'android',
    'Android execution roots receive the Gradle-capable profile',
  );
  // P2-A: the transient unit carries the hardened kernel/device surface.
  for (const expected of [
    'LockPersonality=true',
    'RestrictRealtime=true',
    'RestrictSUIDSGID=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'PrivateDevices=false',
    'DevicePolicy=auto',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    'SystemCallArchitectures=native',
  ]) {
    assert.ok(args.includes(expected), `transient unit must harden ${expected}`);
  }
  assert.equal(args.some((value) => value.startsWith('DeviceAllow=')), false, 'auto device policy must not retain a narrow DeviceAllow rule');
  assert.ok(
    args.includes('BindReadOnlyPaths=-/tmp/.X11-unix -/run/user/1000/gdm/Xauthority -/run/user/1000'),
    'GUI runs must bind the X11 socket, Xauthority, and runtime directory read-only',
  );

  const setenvValues = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '--setenv') setenvValues.push(args[index + 1]);
  }
  assert.ok(setenvValues.includes('PATH=/bin'), 'PATH is allowlisted into the runner');
  assert.ok(setenvValues.includes('HOME=/home/example'), 'HOME stays the runner home');
  assert.ok(setenvValues.includes('DISPLAY=:1'), 'DISPLAY is explicitly passed to the runner');
  assert.ok(setenvValues.includes('XAUTHORITY=/run/user/1000/gdm/Xauthority'), 'XAUTHORITY is explicitly passed to the runner');
  assert.ok(setenvValues.includes('XDG_RUNTIME_DIR=/run/user/1000'), 'XDG_RUNTIME_DIR is explicitly passed to the runner');
  assert.ok(
    setenvValues.includes('AGENTOC_RUN_SPOOL_DIR=/var/lib/agentoc/config/chat-runs'),
    'the controlled spool channel must be passed to the runner',
  );
  assert.ok(
    setenvValues.includes('AGENTOC_NATIVE_OAUTH_LOCK_PATH=/var/lib/agentoc/provider-homes/by-provider/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.agentoc-native-oauth.lock'),
    'the native OAuth lock path must be passed to the runner',
  );
  assert.ok(
    setenvValues.includes('AGENTOC_NATIVE_OAUTH_LOCK_TOKEN=test-oauth-lock-token'),
    'the native OAuth lock handoff token must be passed to the runner',
  );
  assert.ok(
    setenvValues.every((value) => !value.startsWith('AGENTOC_CONFIG_DIR=')),
    'AGENTOC_CONFIG_DIR must never be passed to a Run',
  );
  assert.ok(
    setenvValues.every((value) => !value.startsWith('AGENTOC_INSTANCE_ROOT=')),
    'AGENTOC_INSTANCE_ROOT must never be passed to a Run',
  );
  assert.ok(
    setenvValues.every((value) => !value.startsWith('AGENTOC_MEMORY_DIR=')),
    'AGENTOC_MEMORY_DIR must never be passed to a Run',
  );
  assert.ok(
    setenvValues.every((value) => !value.startsWith('AGENTOC_WORK_ROOT_DIR=')),
    'production AGENTOC_WORK_ROOT_DIR must never be passed to a Run',
  );
  assert.ok(
    setenvValues.every((value) => !value.startsWith('AGENTOC_RUNNER_LIFECYCLE_SOCKET=')),
    'runner lifecycle socket must never be passed to a Run',
  );
  assert.ok(
    setenvValues.every((value) => !value.includes('MY_SERVICE_TOKEN=')),
    'secret-pattern variables must never be passed to a Run',
  );

  const launched = await launchDetachedRunnerViaLifecycleBroker('run_abc12345', {
    socketPath,
  });
  assert.equal(launched.launchMode, DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE);
  assert.equal(launched.unitName, 'agentoc-runner-run_abc12345');
  assert.equal(launches[0].runId, 'run_abc12345');
  assert.equal(launches[0].options.serviceUser, 'svc');
  assert.equal(launches[0].options.serviceGroup, 'svc');
  assert.equal(launches[0].options.controlUser, 'example');
  assert.equal(launches[0].options.launchAttempt, 0);

  // The control-plane client forwards only the three validated GUI values to
  // the root broker; the broker adds the systemd bind paths later.
  const guiEnvKeys = ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'];
  const previousGuiEnv = Object.fromEntries(guiEnvKeys.map((key) => [key, process.env[key]]));
  process.env.DISPLAY = ':1';
  process.env.XAUTHORITY = '/run/user/1000/gdm/Xauthority';
  process.env.XDG_RUNTIME_DIR = '/run/user/1000';
  try {
    await launchDetachedRunnerViaLifecycleBroker('run_gui12345', { socketPath });
  } finally {
    for (const key of guiEnvKeys) {
      if (previousGuiEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousGuiEnv[key];
    }
  }
  assert.deepEqual(launches[1], {
    runId: 'run_gui12345',
    options: {
      serviceUser: 'svc',
      serviceGroup: 'svc',
      controlUser: 'example',
      launchAttempt: 0,
      guiEnvironment: {
        DISPLAY: ':1',
        XAUTHORITY: '/run/user/1000/gdm/Xauthority',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
    },
  });

  const ownershipCalls = [];
  assert.deepEqual(
    await resolveRunnerOwnership('agentoc-runner', 'agentoc-runners', {
      getentImpl: async (command, args) => {
        ownershipCalls.push({ command, args });
        return { stdout: args[0] === 'passwd' ? 'agentoc-runner:x:1234:1234::/var/lib/agentoc-run:/usr/sbin/nologin\n' : 'agentoc-runners:x:2345:\n' };
      },
    }),
    { uid: 1234, gid: 2345 },
  );
  assert.deepEqual(ownershipCalls.map(({ args }) => args[0]), ['passwd', 'group']);

  await assert.rejects(() => readLifecycleSystemdUnitState('agentoc-runner-example', {
    execFileImpl: async () => { throw new Error('systemd unavailable'); },
  }), error => error.code === 'RUNNER_UNIT_STATUS_UNAVAILABLE');
  await assert.rejects(() => launchLifecycleRunner('run_unknownstate', {
    serviceUser: 'svc', serviceGroup: 'svc',
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    readUnitStateImpl: async () => ({ loadState: 'unknown', activeState: 'unknown' }),
    execFileImpl: async () => { throw new Error('runner must not launch'); },
  }), error => error.code === 'RUNNER_UNIT_STATUS_UNAVAILABLE');

  for (const [uid, gid] of [[0, 1234], [null, 1234], [1234, 0], [1234, null]]) {
    await assert.rejects(() => launchLifecycleRunner('run_badidentity', {
      serviceUser: 'svc', serviceGroup: 'svc',
      readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
      resolveRunnerOwnershipImpl: async () => ({ uid, gid }),
      execFileImpl: async () => { throw new Error('runner must not launch'); },
    }), error => error.code === 'RUNNER_IDENTITY_INVALID');
  }

  await assert.rejects(
    () => launchDetachedRunnerViaLifecycleBroker('not-a-run', { socketPath }),
    /Runner lifecycle broker rejected launch request|Invalid runner launch request/,
  );

  // ── P0-B: per-Run workspace access group wiring ───────────────────────────
  // buildLifecycleSystemdArgs attaches the temporary group as a supplementary
  // group, schedules a root ExecStopPost revoke, and gives the recursive ACL
  // cleanup headroom.
  const workspaceArgs = buildLifecycleSystemdArgs('run_abc12345', {
    projectRoot: '/opt/agentoc/app',
    runnerEntry: '/opt/agentoc/app/chat/runner-sidecar.mjs',
    processExecPath: '/opt/agentoc/runtime/node',
    serviceUser: 'agentoc-runner',
    serviceGroup: 'agentoc-runners',
    workspaceAccessGroup: 'aor-0123456789abcdef',
    runCwd: '/home/example',
    isCodexRun: true,
    environment: { PATH: '/bin', HOME: '/home/runner', LANG: 'C.UTF-8' },
  });
  assert.ok(workspaceArgs.includes('SupplementaryGroups=aor-0123456789abcdef'));
  assert.ok(
    workspaceArgs.includes('TemporaryFileSystem=/home/example/.codex:ro'),
    'Codex runs must hide the owner project config from the runner',
  );
  assert.ok(workspaceArgs.includes('TimeoutStopSec=300'));
  assert.ok(
    workspaceArgs.some(
      (value) => value.startsWith('ExecStopPost=+')
        && value.includes('runner-workspace-access.mjs')
        && value.includes('revoke --run-id run_abc12345'),
    ),
    'ExecStopPost schedules the root revoke for the exact run',
  );
  assert.ok(
    workspaceArgs.some((value) => value.startsWith('ExecStopPost=+') && value.includes('"/opt/agentoc/runtime/node"')),
    'the node runtime path is quoted for systemd argv parsing',
  );

  const externalOAuthWorkspaceArgs = buildLifecycleSystemdArgs('run_abc12345', {
    projectRoot: '/opt/agentoc/app',
    runnerEntry: '/opt/agentoc/app/chat/runner-sidecar.mjs',
    processExecPath: '/opt/agentoc/runtime/node',
    serviceUser: 'agentoc-runner',
    serviceGroup: 'agentoc-runners',
    runCwd: '/home/example',
    isCodexRun: true,
    environment: {
      PATH: '/bin',
      HOME: '/home/runner',
      LANG: 'C.UTF-8',
      AGENTOC_CODEX_HOME_DIR: '/home/example/.codex',
    },
  });
  assert.equal(
    externalOAuthWorkspaceArgs.includes('TemporaryFileSystem=/home/example/.codex:ro'),
    false,
    'external CODEX_HOME must not be masked read-only when it is the project cwd .codex path',
  );

  // readWorkspaceAccessScope: prefer the immutable executionScope, fall back to
  // the legacy folder field, and stay null when there is no runnable cwd.
  assert.deepEqual(
    readWorkspaceAccessScope({ executionScope: { cwd: { realPath: '/srv/work/app' }, workspaceRoot: { realPath: '/srv/work' } } }),
    { cwd: '/srv/work/app', workspaceRoot: '/srv/work' },
  );
  assert.deepEqual(
    readWorkspaceAccessScope({ executionScope: { cwd: { realPath: '/srv/work/app' } } }),
    { cwd: '/srv/work/app', workspaceRoot: '/srv/work/app' },
  );
  assert.deepEqual(readWorkspaceAccessScope({ folder: '/legacy/app' }), { cwd: '/legacy/app', workspaceRoot: '/legacy/app' });
  assert.equal(readWorkspaceAccessScope({}), null);
  assert.equal(readWorkspaceAccessScope({ executionScope: {} }), null);

  // launchLifecycleRunner: grants workspace access from the manifest and wires
  // the returned group into the transient unit.
  const execCalls = [];
  const execImpl = async (command, args) => {
    execCalls.push({ command, args });
    return { stdout: '12345' };
  };
  const grantCalls = [];
  const grantImpl = async (options) => {
    grantCalls.push(options);
    return { group: 'aor-0123456789abcdef', runId: options.runId };
  };
  const launchedWithAccess = await launchLifecycleRunner('run_abc12345', {
    serviceUser: 'svc',
    serviceGroup: 'svc',
    serviceHome: '/home/svc',
    controlUser: 'owner',
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
    environment: { AGENTOC_RUNNER_INHERITED_GROUPS: 'owner sudo docker agentoc-privileged' },
    readManifestImpl: async () => ({
      executionScope: { cwd: { realPath: '/srv/work/app' }, workspaceRoot: { realPath: '/srv/work' } },
    }),
    grantWorkspaceAccessImpl: grantImpl,
    execFileImpl: execImpl,
  });
  assert.equal(launchedWithAccess.pid, 12345);
  assert.equal(launchedWithAccess.workspaceAccessGroup, 'aor-0123456789abcdef');
  assert.deepEqual(grantCalls, [{ runId: 'run_abc12345', cwd: '/srv/work/app', workspaceRoot: '/srv/work' }]);
  const systemdRunCall = execCalls.find((call) => call.command === '/usr/bin/systemd-run');
  assert.ok(systemdRunCall, 'systemd-run is invoked');
  assert.ok(systemdRunCall.args.includes('SupplementaryGroups=owner aor-0123456789abcdef'));

  // A grant failure is best-effort: the runner is allowed to work outside the
  // recommended workspace, so the temporary ACL assist is not a hard gate.
  execCalls.length = 0;
  const launchedWithoutGrant = await launchLifecycleRunner('run_abc12345', {
    serviceUser: 'svc',
    serviceGroup: 'svc',
    serviceHome: '/home/svc',
    controlUser: 'owner',
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
    environment: { AGENTOC_RUNNER_INHERITED_GROUPS: 'owner sudo docker agentoc-privileged' },
    readManifestImpl: async () => ({
      executionScope: { cwd: { realPath: '/srv/work/app' } },
    }),
    grantWorkspaceAccessImpl: async () => {
      throw new Error('setfacl missing');
    },
    execFileImpl: execImpl,
  });
  assert.equal(launchedWithoutGrant.workspaceAccessGroup, null);
  const withoutGrantRun = execCalls.find((call) => call.command === '/usr/bin/systemd-run');
  assert.ok(withoutGrantRun, 'ordinary Run still launches without temporary ACL assist');
  assert.ok(!withoutGrantRun.args.includes('SupplementaryGroups='));
  assert.ok(!withoutGrantRun.args.some((value) => value.startsWith('ExecStopPost=+')));

  // AgY runs prepare an isolated HOME before systemd-run. Keep this branch in
  // the broker test so a missing ownership helper cannot regress into a
  // runtime-only ReferenceError.
  const agyProviderHomesRoot = join(root, 'agy-provider-homes');
  const agyPrepareCalls = [];
  const agyLaunch = await launchLifecycleRunner('run_agy12345', {
    serviceUser: 'svc',
    serviceGroup: 'svc',
    serviceHome: '/home/svc',
    controlUser: 'owner',
    environment: {
      AGENTOC_PROVIDER_HOMES_DIR: agyProviderHomesRoot,
      AGENTOC_RUN_SPOOL_DIR: join(root, 'run-results'),
      AGENTOC_RUNNER_INHERITED_GROUPS: 'owner',
    },
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
    readManifestImpl: async () => ({ tool: 'agy', executionScope: { accessMode: 'read' }, options: { runtimeFamily: 'agy-json' } }),
    prepareNativeRunProviderHomeImpl: async (runId, manifest, options) => {
      agyPrepareCalls.push({ runId, manifest, options });
      return {
        ok: true,
        providerId: 'agy-test-account',
        homeDir: join(agyProviderHomesRoot, 'by-provider', 'agy-test', 'by-run', 'agy-run'),
        agyHomeDir: join(agyProviderHomesRoot, 'by-provider', 'agy-test', 'by-run', 'agy-run', 'agy'),
      };
    },
    execFileImpl: async (command, args) => {
      assert.ok(['/usr/bin/systemd-run', 'systemctl'].includes(command));
      return { stdout: '54321' };
    },
  });
  assert.equal(agyLaunch.pid, 54321);
  assert.deepEqual(agyPrepareCalls.map(({ runId, options }) => ({
    runId,
    providerHomesRoot: options.providerHomesRoot,
    runnerReadable: options.runnerReadable,
    forceRunScopedHome: options.forceRunScopedHome,
  })), [{
    runId: 'run_agy12345',
    providerHomesRoot: agyProviderHomesRoot,
    runnerReadable: true,
    forceRunScopedHome: true,
  }]);

  // If systemd-run itself fails, the already-granted group + ACLs are rolled
  // back (ExecStopPost will never run because the unit never started).
  const revokeCalls = [];
  const failingExec = async (command) => {
    if (command === '/usr/bin/systemd-run') throw new Error('systemd-run failed');
    return { stdout: '12345' };
  };
  await assert.rejects(
    () => launchLifecycleRunner('run_abc12345', {
      serviceUser: 'svc',
      serviceGroup: 'svc',
      serviceHome: '/home/svc',
      resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
      readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
      readManifestImpl: async () => ({ executionScope: { cwd: { realPath: '/srv/work/app' } } }),
      grantWorkspaceAccessImpl: grantImpl,
      revokeWorkspaceAccessImpl: async (options) => {
        revokeCalls.push(options);
        return { revoked: true };
      },
      execFileImpl: failingExec,
    }),
    /systemd-run failed/,
  );
  assert.deepEqual(revokeCalls, [{ runId: 'run_abc12345' }]);

  // Recovery attempts use an independent unit and temporary-access identity.
  // A failed retry must therefore never delete the predecessor's dynamic group
  // while its ExecStopPost is still draining.
  const retryGrantCalls = [];
  const retryRevokeCalls = [];
  await assert.rejects(
    () => launchLifecycleRunner('run_retry12345', {
      serviceUser: 'svc',
      serviceGroup: 'svc',
      serviceHome: '/home/svc',
      resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
      launchAttempt: 2,
      readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
      readManifestImpl: async () => ({ executionScope: { cwd: { realPath: '/srv/work/app' } } }),
      grantWorkspaceAccessImpl: async (options) => {
        retryGrantCalls.push(options);
        return { group: 'aor-fedcba9876543210', runId: options.runId };
      },
      revokeWorkspaceAccessImpl: async (options) => {
        retryRevokeCalls.push(options);
        return { revoked: true };
      },
      execFileImpl: failingExec,
    }),
    /systemd-run failed/,
  );
  assert.equal(retryGrantCalls[0].runId, 'run_retry12345_a2');
  assert.deepEqual(retryRevokeCalls, [{ runId: 'run_retry12345_a2' }]);

  const reused = await launchLifecycleRunner('run_reuse12345', {
    serviceUser: 'svc',
    serviceGroup: 'svc',
    serviceHome: '/home/svc',
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    launchAttempt: 1,
    readUnitStateImpl: async () => ({ loadState: 'loaded', activeState: 'active', pid: 45678, user: 'svc' }),
    grantWorkspaceAccessImpl: async () => {
      throw new Error('active unit must be returned before creating another access grant');
    },
    execFileImpl: async () => {
      throw new Error('active unit must not call systemd-run');
    },
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, 45678);
  assert.equal(reused.unitName, 'agentoc-runner-run_reuse12345-a1');
  assert.equal(reused.launchAttempt, 1);
  for (const user of ['root', '']) {
    await assert.rejects(() => launchLifecycleRunner('run_reusebad', {
      serviceUser: 'svc', serviceGroup: 'svc',
      resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
      readUnitStateImpl: async () => ({ loadState: 'loaded', activeState: 'active', pid: 45678, user }),
    }), error => error.code === 'RUNNER_IDENTITY_INVALID');
  }

  let concurrentPreflightCount = 0;
  let concurrentSystemdRunCount = 0;
  const concurrentOptions = {
    serviceUser: 'svc',
    serviceGroup: 'svc',
    serviceHome: '/home/svc',
    launchAttempt: 3,
    resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
    resolveInheritedGroupsImpl: async () => [],
    readManifestImpl: async () => ({}),
    readUnitStateImpl: async () => {
      concurrentPreflightCount += 1;
      return { loadState: 'not-found', activeState: 'inactive', pid: null };
    },
    execFileImpl: async (command) => {
      if (command === '/usr/bin/systemd-run') {
        concurrentSystemdRunCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { stdout: '' };
      }
      if (command === 'systemctl') return { stdout: '24680\n' };
      throw new Error(`unexpected command: ${command}`);
    },
  };
  const concurrent = await Promise.all([
    launchLifecycleRunner('run_singleflight123', concurrentOptions),
    launchLifecycleRunner('run_singleflight123', concurrentOptions),
  ]);
  assert.equal(concurrentPreflightCount, 1, 'same-generation requests share one preflight');
  assert.equal(concurrentSystemdRunCount, 1, 'same-generation requests share one systemd-run launch');
  assert.deepEqual(concurrent.map((result) => result.pid), [24680, 24680]);

  console.log('test-runner-lifecycle-broker: PASS');
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
