#!/usr/bin/env node
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const instanceRoot = await mkdtemp(join(tmpdir(), 'ragent-restart-interlock-'));
process.env.RAGENT_CONFIG_DIR = join(instanceRoot, 'config');
delete process.env.RAGENT_RUN_SPOOL_DIR;

const {
  RESTART_DRAIN_FILE,
  assertRunStartsAllowed,
  beginRestartDrain,
  beginUpgradeDrain,
  clearRestartDrainAfterStartup,
  endRestartDrain,
  assessRunUpgradeSafety,
  isIndependentControlGroup,
  isSystemdRunnerLaunchMode,
  listBlockingActiveRuns,
  listUpgradeBlockingActiveRuns,
  readRestartDrain,
} = await import('../lib/restart-interlock.mjs');

assert.equal(isSystemdRunnerLaunchMode('systemd-transient-service'), true);
assert.equal(isSystemdRunnerLaunchMode('legacy-systemd-transient-service'), false);
assert.equal(isSystemdRunnerLaunchMode('runner-lifecycle'), true);
assert.equal(isSystemdRunnerLaunchMode('runner-supervisor'), false);
assert.equal(isIndependentControlGroup(
  '/ragent.slice/ragent-runners.slice/ragent-runner-run_123.service',
  '/system.slice/ragent.service',
), true);
assert.equal(isIndependentControlGroup('/system.slice/ragent.service', '/system.slice/ragent.service'), false);
assert.equal(isIndependentControlGroup('/system.slice/ragent.service/main', '/system.slice/ragent.service'), false);
assert.equal(isIndependentControlGroup('', '/system.slice/ragent.service'), false);

const runsDir = join(process.env.RAGENT_CONFIG_DIR, 'chat-runs');

async function writeRun(id, run) {
  const directory = join(runsDir, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'status.json'), `${JSON.stringify({ id, ...run }, null, 2)}\n`);
}

let liveRunner = null;
try {
  liveRunner = spawn(process.execPath, [
    '-e',
    'setTimeout(() => {}, 60000)',
    'runner-sidecar.mjs',
    'run_alive123',
  ], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    liveRunner.once('spawn', resolve);
    liveRunner.once('error', reject);
  });
  await writeRun('run_alive123', {
    sessionId: 'session_alive',
    provider: 'codex',
    runtimeFamily: 'claude-stream-json-bidi',
    state: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runnerProcessId: liveRunner.pid,
    runnerLaunchMode: 'runner-supervisor',
  });
  await writeRun('run_stale123', {
    sessionId: 'session_stale',
    provider: 'codex',
    state: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runnerProcessId: 99999999,
    runnerLaunchMode: 'detached-process',
  });

  const blockingRuns = await listBlockingActiveRuns();
  assert.deepEqual(blockingRuns.map((run) => run.id), ['run_alive123']);
  assert.equal(blockingRuns[0].runtimeFamily, 'claude-stream-json-bidi');

  const fakeSystemctl = async (command, args) => {
    assert.equal(command, 'systemctl');
    if (args.includes('is-active')) return { stdout: '' };
    const unitName = args.at(-1);
    return {
      stdout: unitName === 'ragent-runner-run_safe123.service'
        ? '/ragent.slice/ragent-runners.slice/ragent-runner-run_safe123.service\n'
        : '/system.slice/ragent.service\n',
    };
  };
  const safeAssessment = await assessRunUpgradeSafety({
    runnerLaunchMode: 'runner-lifecycle',
    runnerUnitName: 'ragent-runner-run_safe123.service',
    runnerUnitScope: 'system',
  }, { execFileImpl: fakeSystemctl });
  assert.equal(safeAssessment.safe, true);
  assert.equal(safeAssessment.reason, 'independent_systemd_runner');

  const unsafeAssessment = await assessRunUpgradeSafety({
    runnerLaunchMode: 'detached-process',
    runnerProcessId: liveRunner.pid,
  }, { execFileImpl: fakeSystemctl });
  assert.equal(unsafeAssessment.safe, false);
  assert.equal(unsafeAssessment.reason, 'runner_not_systemd_managed');
  const upgradeBlocking = await listUpgradeBlockingActiveRuns();
  assert.deepEqual(upgradeBlocking.map((run) => run.id), ['run_alive123']);

  const blocked = await beginRestartDrain();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockingRuns.length, 1);
  assert.equal(await readRestartDrain(), null);
  await assertRunStartsAllowed();

  await writeRun('run_alive123', {
    sessionId: 'session_alive',
    provider: 'codex',
    state: 'completed',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runnerProcessId: process.pid,
    runnerLaunchMode: 'runner-supervisor',
  });

  const allowed = await beginRestartDrain();
  assert.equal(allowed.ok, true);
  assert.ok(await readRestartDrain());
  await assert.rejects(
    () => assertRunStartsAllowed(),
    (error) => error?.code === 'RESTART_DRAINING',
  );
  await endRestartDrain();
  assert.equal(await readRestartDrain(), null);
  await assertRunStartsAllowed();

  const forced = await beginRestartDrain({ force: true });
  assert.equal(forced.ok, true);
  await endRestartDrain();

  await writeRun('run_upgrade_legacy', {
    sessionId: 'session_upgrade_legacy',
    provider: 'codex',
    state: 'starting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runnerProcessId: liveRunner.pid,
    runnerLaunchMode: 'detached-process',
  });
  const upgradeAllowed = await beginUpgradeDrain({
    execFileImpl: fakeSystemctl,
    chatUnitName: 'ragent.service',
  });
  assert.equal(upgradeAllowed.ok, false, 'the legacy runner must still block an upgrade');
  assert.equal(upgradeAllowed.blockingRuns[0].reason, 'runner_not_systemd_managed');
  assert.equal(await readRestartDrain(), null);
  await writeRun('run_upgrade_legacy', {
    sessionId: 'session_upgrade_legacy',
    provider: 'codex',
    state: 'completed',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runnerLaunchMode: 'detached-process',
  });

  const residual = await beginRestartDrain({ ttlMs: 600_000 });
  assert.equal(residual.ok, true);
  await assert.rejects(
    () => assertRunStartsAllowed(),
    (error) => error?.code === 'RESTART_DRAINING',
    'an active drain should block new runs before startup cleanup',
  );
  await clearRestartDrainAfterStartup();
  assert.equal(await readRestartDrain(), null);
  await assertRunStartsAllowed();

  console.log('test-restart-interlock: ok');
} finally {
  liveRunner?.kill('SIGTERM');
  await endRestartDrain().catch(() => {});
  await rm(RESTART_DRAIN_FILE, { force: true }).catch(() => {});
  await rm(instanceRoot, { recursive: true, force: true });
}
