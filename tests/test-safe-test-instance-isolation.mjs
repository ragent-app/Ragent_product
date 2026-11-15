#!/usr/bin/env node
// DS-02: safe test instance launcher + supervisor pollution detector tests.
//
// Proves, with temporary instances only (never touching production PIDs):
//   1. launcher isolation contract: independent config/work/memory dirs, unique
//      instance id + marker, free non-production port, TTL kill, cleanup of
//      only its own resources;
//   2. cgroup contract: launcher children inherit the CALLER's cgroup and never
//      join the production units (ragent.service / ragent-runner-supervisor
//      membership is never created by the launcher) — the instance marker makes
//      them distinguishable in proc/cgroup listings;
//   3. detector: flags chat-server duplicates, journalctl -f, stress drivers,
//      diag scripts, sleep, marker-less sidecars and leaked test instances
//      inside a (simulated) supervisor cgroup — alarm-only, never kills;
//   4. real chat-server boot through the launcher with marker + cgroup checks.

import assert from 'assert/strict';
import { spawn } from 'child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const launcher = join(repoRoot, 'scripts', 'launch-test-instance.mjs');
const detector = join(repoRoot, 'scripts', 'check-supervisor-process-pollution.mjs');

const STUB_KEEPALIVE = "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({env:process.env,cgroup:fs.readFileSync('/proc/self/cgroup','utf8').trim()},null,2));setInterval(()=>{},1000);";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function spawnDetached(command, args, options = {}) {
  return spawn(command, args, { stdio: 'ignore', ...options });
}

function readProcEnv(pid) {
  return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
}

function readProcCgroup(pid) {
  return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLauncherStatus(stdout) {
  // The JSON status is pretty-printed and may be interleaved with the child's
  // inherited stdout; take the substring between the first '{' and last '}'.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`No JSON status in launcher output: ${stdout.slice(0, 400)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function waitForFile(filePath, timeoutMs = 20000) {
  return waitFor(() => existsSync(filePath) ? filePath : null, `file ${filePath}`, timeoutMs);
}

function killQuietly(pid, signal = 'SIGKILL') {
  try {
    process.kill(pid, signal);
  } catch {}
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(`       ${error?.stack || error}`);
    });
}

async function testLauncherHelp() {
  const result = await runProcess(process.execPath, [launcher, '--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('launch-test-instance'));
}

async function testIsolationContract() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-contract-'));
  const envOut = join(baseDir, 'child-env.json');
  const launcherProc = spawnDetached(process.execPath, [
    launcher, '--base-dir', baseDir, '--ttl', '90', '--json', '--',
    process.execPath, '-e', STUB_KEEPALIVE, envOut,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let launcherStdout = '';
  let launcherStderr = '';
  launcherProc.stdout.on('data', (chunk) => { launcherStdout += chunk.toString('utf8'); });
  launcherProc.stderr.on('data', (chunk) => { launcherStderr += chunk.toString('utf8'); });
  const exitPromise = new Promise((resolve) => launcherProc.on('exit', (code, signal) => resolve({ code, signal })));

  const instanceDirForCleanup = () => {
    try {
      const entries = readdirSync(baseDir).filter((entry) => entry.startsWith('test-'));
      if (entries.length === 0) return null;
      return join(baseDir, entries[0]);
    } catch {
      return null;
    }
  };
  const killInstanceChild = () => {
    const dir = instanceDirForCleanup();
    if (!dir) return;
    try {
      const marker = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
      if (Number.isInteger(marker.pid) && marker.pid > 0) killQuietly(marker.pid);
    } catch {}
  };

  try {
    await waitForFile(envOut);
    const childInfo = JSON.parse(readFileSync(envOut, 'utf8'));
    const env = childInfo.env;

    assert.ok(env.RAGENT_TEST_INSTANCE_ID.startsWith('test-'), 'unique instance id marker');
    const instanceDir = join(baseDir, env.RAGENT_TEST_INSTANCE_ID);
    assert.ok(env.RAGENT_CONFIG_DIR && env.RAGENT_CONFIG_DIR.startsWith(instanceDir), 'temp config dir under instance dir');
    assert.ok(env.RAGENT_WORK_ROOT_DIR && env.RAGENT_WORK_ROOT_DIR.startsWith(instanceDir), 'work root under instance dir');
    assert.ok(env.RAGENT_MEMORY_DIR && env.RAGENT_MEMORY_DIR.startsWith(instanceDir), 'memory dir under instance dir');
    for (const dir of [env.RAGENT_CONFIG_DIR, env.RAGENT_WORK_ROOT_DIR, env.RAGENT_MEMORY_DIR]) {
      assert.ok(existsSync(dir), `dir exists: ${dir}`);
    }
    const port = Number.parseInt(env.CHAT_PORT, 10);
    assert.ok(Number.isInteger(port) && port > 0 && port !== 7690 && port !== 7699, `non-production port: ${port}`);
    assert.equal(env.RAGENT_RUNNER_SUPERVISOR_SOCKET, '', 'supervisor socket neutralised');
    assert.equal(env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER, '1', 'no systemd detached runners');
    assert.equal(env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES, '1', 'temp overrides allowed');
    assert.ok(env.RAGENT_PUBLIC_BASE_URL.includes(String(port)), 'public base url pinned to temp port');

    const marker = JSON.parse(readFileSync(join(instanceDir, 'instance.json'), 'utf8'));
    assert.equal(marker.id, env.RAGENT_TEST_INSTANCE_ID);
    assert.ok(Number.isInteger(marker.pid) && marker.pid > 0, 'marker pid recorded');

    // cgroup contract: child inherits the CALLER's cgroup; it never joins the
    // production chat-server unit, and the marker distinguishes it.
    const childPid = marker.pid;
    const callerCgroup = readProcCgroup(process.pid);
    const childCgroup = readProcCgroup(childPid);
    assert.equal(childCgroup, callerCgroup, 'child cgroup == caller cgroup (no re-parenting)');
    assert.ok(!childCgroup.includes('ragent.service'), 'child not in production chat-server unit cgroup');
    const childEnv = readProcEnv(childPid);
    assert.ok(childEnv.some((entry) => entry === `RAGENT_TEST_INSTANCE_ID=${env.RAGENT_TEST_INSTANCE_ID}`), 'marker visible in /proc environ');
    assert.ok(childEnv.some((entry) => entry === `CHAT_PORT=${port}`), 'temp port visible in /proc environ');

    // Distinguishability: a detector run over a cgroup listing that contains
    // this launcher child flags it as a leaked test instance, not as a
    // supervised runner.
    const fakeCgroupDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-fakecg-'));
    writeFileSync(join(fakeCgroupDir, 'cgroup.procs'), `${childPid}\n`, 'utf8');
    const det = await runProcess(process.execPath, [detector, '--cgroup-dir', fakeCgroupDir, '--json']);
    assert.equal(det.code, 1, 'detector exits 1 for leaked test instance');
    const detJson = JSON.parse(det.stdout);
    assert.ok(detJson.pollution.some((pid) => pid === childPid), 'launcher child flagged as pollution');
    const entry = detJson.processes.find((process) => process.pid === childPid);
    assert.equal(entry.kind, 'test-instance-in-prod-cgroup', 'classified by marker');
    rmSync(fakeCgroupDir, { recursive: true, force: true });

    // Clean shutdown via SIGTERM to the launcher: child killed, own resources removed.
    killQuietly(launcherProc.pid, 'SIGTERM');
    const exit = await exitPromise;
    assert.equal(exit.code, 143, `launcher exits 143 after SIGTERM (got ${exit.code})`);
    const status = parseLauncherStatus(launcherStdout);
    assert.equal(status.instanceId, env.RAGENT_TEST_INSTANCE_ID);
    assert.equal(status.port, port);
    assert.equal(status.cleaned, true);
    assert.ok(!existsSync(instanceDir), 'instance dir cleaned');
    assert.ok(!isAlive(childPid), 'child process gone after shutdown');
  } finally {
    killQuietly(launcherProc.pid, 'SIGKILL');
    killInstanceChild();
    rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testTtlKillsAndCleans() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-ttl-'));
  const envOut = join(baseDir, 'child-env.json');
  const started = Date.now();
  const result = await runProcess(process.execPath, [
    launcher, '--base-dir', baseDir, '--ttl', '2', '--json', '--',
    process.execPath, '-e', STUB_KEEPALIVE, envOut,
  ], { timeout: 30000 });
  const status = parseLauncherStatus(result.stdout);
  assert.equal(result.code, 124, `TTL expiry exits 124 (got ${result.code})`);
  assert.equal(status.ttlExpired, true);
  assert.ok(!existsSync(join(baseDir, status.instanceId)), 'instance dir removed after TTL');
  assert.ok(Date.now() - started < 20000, 'TTL fired promptly');
  rmSync(baseDir, { recursive: true, force: true });
}

async function testCleanupOnlyOwnResources() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-sentinel-'));
  const sentinel = join(baseDir, 'keep-me.txt');
  writeFileSync(sentinel, 'sentinel', 'utf8');
  const envOut = join(baseDir, 'child-env.json');
  const result = await runProcess(process.execPath, [
    launcher, '--base-dir', baseDir, '--ttl', '1', '--json', '--',
    process.execPath, '-e', STUB_KEEPALIVE, envOut,
  ], { timeout: 30000 });
  const status = parseLauncherStatus(result.stdout);
  assert.equal(result.code, 124);
  assert.ok(existsSync(sentinel), 'sentinel outside instance dir untouched');
  assert.ok(!existsSync(join(baseDir, status.instanceId)), 'instance dir removed');
  assert.ok(existsSync(baseDir), 'pre-existing base dir not removed');
  rmSync(baseDir, { recursive: true, force: true });
}

async function testDetectorFlagsPollution() {
  const cgroupDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-cg-'));
  const spawned = [];
  const keepAlive = "setInterval(()=>{},1000);";
  try {
    const fakeDaemon = spawnDetached(process.execPath, ['-e', keepAlive, 'runner-supervisor-daemon.mjs']);
    const fakeSidecar = spawnDetached(process.execPath, ['-e', keepAlive, 'runner-sidecar.mjs', 'run_testmarker123456']);
    const fakeSidecarNoMarker = spawnDetached(process.execPath, ['-e', keepAlive, 'runner-sidecar.mjs']);
    const fakeChat = spawnDetached(process.execPath, ['-e', keepAlive, 'chat-server.mjs']);
    const fakeJournal = spawnDetached(process.execPath, ['-e', keepAlive, 'journalctl', '-f']);
    const fakeStress = spawnDetached(process.execPath, ['-e', keepAlive, 'stress', '--cpu', '2']);
    const fakeDiag = spawnDetached(process.execPath, ['-e', keepAlive, 'diag-host-v47b.mjs']);
    const fakeSleep = spawnDetached('/bin/sleep', ['60']);
    const fakeTestInstance = spawnDetached(process.execPath, ['-e', keepAlive], {
      env: { ...process.env, RAGENT_TEST_INSTANCE_ID: 'test-leak-123' },
    });
    const fakeGeneric = spawnDetached(process.execPath, ['-e', keepAlive]);
    spawned.push(fakeDaemon, fakeSidecar, fakeSidecarNoMarker, fakeChat, fakeJournal,
      fakeStress, fakeDiag, fakeSleep, fakeTestInstance, fakeGeneric);
    await sleep(200);

    const pid = (child) => child.pid;
    writeFileSync(join(cgroupDir, 'cgroup.procs'), `${spawned.map(pid).join('\n')}\n`, 'utf8');

    const result = await runProcess(process.execPath, [detector, '--cgroup-dir', cgroupDir, '--json']);
    assert.equal(result.code, 1, `detector exits 1 with pollution (got ${result.code})`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.actionTaken, 'none (alarm-only)');
    const byKind = {};
    for (const process of report.processes) {
      byKind[process.kind] = byKind[process.kind] || [];
      byKind[process.kind].push(process.pid);
    }
    assert.ok(byKind['supervisor-daemon']?.includes(fakeDaemon.pid), 'daemon allowed');
    assert.ok(byKind['supervised-runner']?.includes(fakeSidecar.pid), 'sidecar with run manifest allowed');
    assert.ok(byKind['sidecar-without-run-manifest-marker']?.includes(fakeSidecarNoMarker.pid), 'marker-less sidecar flagged');
    assert.ok(byKind['duplicate-chat-server']?.includes(fakeChat.pid), 'duplicate chat-server flagged');
    assert.ok(byKind['journalctl-tail']?.includes(fakeJournal.pid), 'journalctl -f flagged');
    assert.ok(byKind['stress-driver']?.includes(fakeStress.pid), 'stress driver flagged');
    assert.ok(byKind['diagnostic-script']?.includes(fakeDiag.pid), 'diag script flagged');
    assert.ok(byKind['sleep-process']?.includes(fakeSleep.pid), 'sleep flagged');
    assert.ok(byKind['test-instance-in-prod-cgroup']?.includes(fakeTestInstance.pid), 'leaked test instance flagged by marker');
    assert.ok(byKind['unknown-process']?.includes(fakeGeneric.pid), 'unknown process flagged');
    assert.ok(report.pollutionCount >= 8, `pollution count >= 8 (got ${report.pollutionCount})`);

    // Alarm-only: nothing killed.
    for (const child of spawned) {
      assert.ok(isAlive(child.pid), `detector did not kill pid ${child.pid}`);
    }

    // Clean cgroup (only allowed processes) exits 0.
    writeFileSync(join(cgroupDir, 'cgroup.procs'), `${fakeDaemon.pid}\n${fakeSidecar.pid}\n`, 'utf8');
    const cleanResult = await runProcess(process.execPath, [detector, '--cgroup-dir', cgroupDir, '--json']);
    assert.equal(cleanResult.code, 0, `clean cgroup exits 0 (got ${cleanResult.code})`);
    assert.equal(JSON.parse(cleanResult.stdout).pollutionCount, 0);

    // Inspection error exits 2.
    const missingDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-missing-'));
    const errorResult = await runProcess(process.execPath, [detector, '--cgroup-dir', missingDir, '--json']);
    assert.equal(errorResult.code, 2, `missing cgroup.procs exits 2 (got ${errorResult.code})`);
    rmSync(missingDir, { recursive: true, force: true });
  } finally {
    for (const child of spawned) killQuietly(child.pid);
    rmSync(cgroupDir, { recursive: true, force: true });
  }
}

async function testRealChatServerThroughLauncher() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-server-'));
  const launcherProc = spawnDetached(process.execPath, [
    launcher, '--base-dir', baseDir, '--ttl', '120', '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let launcherStdout = '';
  launcherProc.stdout.on('data', (chunk) => { launcherStdout += chunk.toString('utf8'); });
  const exitPromise = new Promise((resolve) => launcherProc.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    // Wait for the marker file (written after spawn) then for HTTP to answer.
    const markerFile = await waitFor(() => {
      try {
        const entries = readdirSync(baseDir).filter((entry) => entry.startsWith('test-'));
        if (entries.length === 0) return null;
        const markerPath = join(baseDir, entries[0], 'instance.json');
        return existsSync(markerPath) ? markerPath : null;
      } catch {
        return null;
      }
    }, 'instance.json', 15000);
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    assert.ok(Number.isInteger(marker.pid) && marker.pid > 0, 'server pid recorded');
    assert.ok(Number.isInteger(marker.port) && marker.port !== 7690, 'temp port');
    const serverPid = marker.pid;

    await waitFor(async () => {
      try {
        const status = await httpGet(marker.port, '/login');
        return status >= 100 && status < 600;
      } catch {
        return null;
      }
    }, 'chat-server HTTP answer', 60000);

    const serverEnv = readProcEnv(serverPid);
    assert.ok(serverEnv.some((entry) => entry === `RAGENT_TEST_INSTANCE_ID=${marker.id}`), 'real server carries instance marker');
    assert.ok(serverEnv.some((entry) => entry === `CHAT_PORT=${marker.port}`), 'real server on temp port');
    const callerCgroup = readProcCgroup(process.pid);
    const serverCgroup = readProcCgroup(serverPid);
    assert.equal(serverCgroup, callerCgroup, 'real server inherits caller cgroup');
    assert.ok(!serverCgroup.includes('ragent.service'), 'real test server not in production chat-server cgroup');

    // The marker makes the real test server distinguishable from the
    // production chat-server (which carries no marker).
    const fakeCgroupDir = mkdtempSync(join(tmpdir(), 'ragent-ds02-fakecg2-'));
    writeFileSync(join(fakeCgroupDir, 'cgroup.procs'), `${serverPid}\n`, 'utf8');
    const det = await runProcess(process.execPath, [detector, '--cgroup-dir', fakeCgroupDir, '--json']);
    assert.equal(det.code, 1);
    const detEntry = JSON.parse(det.stdout).processes.find((process) => process.pid === serverPid);
    assert.equal(detEntry.kind, 'test-instance-in-prod-cgroup', 'test server distinguishable from production chat-server');
    rmSync(fakeCgroupDir, { recursive: true, force: true });

    killQuietly(launcherProc.pid, 'SIGTERM');
    const exit = await exitPromise;
    // chat-server shuts down gracefully on SIGTERM (exit 0); a stub without
    // graceful handling dies by signal (143). Either way the launcher must
    // finish and clean up.
    assert.ok(exit.code === 0 || exit.code === 143, `launcher exits 0 or 143 after SIGTERM (got ${exit.code})`);
    const status = parseLauncherStatus(launcherStdout);
    assert.equal(status.cleaned, true);
    assert.ok(!existsSync(join(baseDir, status.instanceId)), 'real server instance dir cleaned');
    assert.ok(!isAlive(serverPid), 'real server gone after shutdown');
  } finally {
    killQuietly(launcherProc.pid, 'SIGKILL');
    try {
      const entries = readdirSync(baseDir).filter((entry) => entry.startsWith('test-'));
      if (entries.length > 0) {
        const marker = JSON.parse(readFileSync(join(baseDir, entries[0], 'instance.json'), 'utf8'));
        if (Number.isInteger(marker.pid) && marker.pid > 0) killQuietly(marker.pid);
      }
    } catch {}
    rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testLiveProductionScanIsAlarmOnly() {
  // On this host the supervisor unit exists and (per the audit snapshot) may
  // contain pollution such as chat-server.mjs duplicates. The detector must
  // report it and exit 1 without killing anything. The known live PIDs from the
  // audit snapshot are checked conditionally (they may have been reaped since).
  const knownPollutedPids = [338999, 1098527, 1098984];
  const result = await runProcess(process.execPath, [detector, '--json'], { timeout: 30000 });
  assert.ok(result.code === 0 || result.code === 1, `live scan exits 0/1 (got ${result.code})`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.actionTaken, 'none (alarm-only)');
  for (const pid of knownPollutedPids) {
    if (isAlive(pid)) {
      const entry = report.processes.find((process) => process.pid === pid);
      assert.ok(entry, `known pollution pid ${pid} present in report`);
      assert.equal(entry.role, 'pollution', `known pollution pid ${pid} flagged`);
      assert.equal(entry.kind, 'duplicate-chat-server', `known pollution pid ${pid} classified as duplicate-chat-server`);
      assert.ok(isAlive(pid), `detector did not kill pid ${pid}`);
    }
  }
}

async function main() {
  await check('launcher --help exits 0', testLauncherHelp);
  await check('launcher isolation contract (dirs/port/marker/cgroup/cleanup)', testIsolationContract);
  await check('TTL expiry kills instance and cleans up (exit 124)', testTtlKillsAndCleans);
  await check('cleanup removes only own resources', testCleanupOnlyOwnResources);
  await check('detector flags pollution classes, never kills', testDetectorFlagsPollution);
  await check('real chat-server boots through launcher with marker + cgroup separation', testRealChatServerThroughLauncher);
  await check('live production scan is alarm-only', testLiveProductionScanIsAlarmOnly);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
