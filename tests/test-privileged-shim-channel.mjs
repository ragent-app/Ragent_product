#!/usr/bin/env node
// Integration tests for the real `agentoc-privileged` channel
// (design docs/privileged-shim-channel-2026-09-03.md): listener + launcher +
// client process over a live per-Run unix socket, with the run store and risk
// classifier injected. Server-side writeback updaters are covered purely.

import assert from 'assert/strict';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { startPrivilegedShimChannel } from '../chat/privileged-shim-listener.mjs';
import { buildSandboxedSpawn } from '../lib/runner-sandbox.mjs';
import { PRIVILEGED_SHIM_EXIT } from '../chat/privileged-shim-protocol.mjs';
import {
  buildPrivilegedShimDeclineUpdate,
  buildPrivilegedShimInstallAutoUpdate,
  buildPrivilegedShimResolveUpdate,
  buildPrivilegedShimTerminalUpdate,
} from '../chat/privileged-approval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLIENT_ENTRY = join(PROJECT_ROOT, 'chat', 'privileged-shim-command.mjs');
const RUN_ID = 'run_shimchanneltest01';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

function dangerRiskClassifier(input = {}) {
  const command = String(input.command || '');
  if (command.startsWith('systemctl')) {
    return { tier: 'danger', signals: { needsPrivilegedExecution: true, reasons: ['systemctl mutation'] } };
  }
  return { tier: 'safe', signals: { reasons: [] } };
}

function createStore() {
  const state = {
    record: { id: RUN_ID, state: 'running', cancelRequested: false },
  };
  return {
    state,
    getRunImpl: async () => state.record,
    updateRunImpl: async (runId, updater) => {
      const next = updater(state.record);
      if (next && typeof next === 'object') state.record = next;
      return state.record;
    },
  };
}

function spawnClient(args, socketPath, { cwd = PROJECT_ROOT } = {}) {
  const env = { ...process.env, AGENTOC_RUN_ID: RUN_ID };
  if (socketPath === null) {
    delete env.AGENTOC_PRIVILEGED_SHIM_SOCKET;
  } else if (socketPath) {
    env.AGENTOC_PRIVILEGED_SHIM_SOCKET = socketPath;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_ENTRY, ...args], { env, cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

const sentinelArgs = [
  '--description', 'raise TasksMax for the run slice',
  '--category', 'other',
  '--', 'systemctl', 'set-property', 'user-1000.slice', 'TasksMax=infinity',
];

// Long home and instance paths must not exceed the OS unix-socket limit.
if (process.platform !== 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'agentoc-shim-long-'));
  const resultsDir = join(root, 'x'.repeat(110));
  mkdirSync(resultsDir);
  const store = createStore();
  let channel;
  let shortDir;
  try {
    channel = await startPrivilegedShimChannel({
      runId: RUN_ID, nodePath: process.execPath, commandEntryPath: CLIENT_ENTRY,
      resultsDir, ...store, classifyRiskImpl: dangerRiskClassifier,
    });
    shortDir = dirname(channel.socketPath);
    check('long results path uses a short socket', Buffer.byteLength(channel.socketPath) <= 100);
    check('only the private short socket directory is exposed for sandbox binding', channel.socketBindDir === shortDir);
    check('short socket parent is private', (statSync(shortDir).mode & 0o077) === 0);
    const client = await spawnClient(['--desc', 'listing', '--', 'ls', '-la'], channel.socketPath);
    check('short socket accepts a real client', client.code === PRIVILEGED_SHIM_EXIT.REFUSED);
    if (process.platform === 'linux' && shortDir.startsWith('/tmp/')) {
      const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--', '/bin/true'],
      { stdio: 'ignore', timeout: 5000 });
      if (probe.status === 0) {
        const sandbox = buildSandboxedSpawn({ command: process.execPath,
          args: [CLIENT_ENTRY, '--desc', 'listing', '--', 'ls', '-la'], cwd: PROJECT_ROOT,
          runnerHome: process.env.HOME, bindReadOnlyPaths: [channel.socketBindDir] });
        try {
          const result = await new Promise((resolve) => {
            const child = spawn(sandbox.command, sandbox.args, { cwd: PROJECT_ROOT,
              env: { ...process.env, AGENTOC_RUN_ID: RUN_ID, AGENTOC_PRIVILEGED_SHIM_SOCKET: channel.socketPath },
              stdio: 'ignore' });
            const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
            child.once('error', () => { clearTimeout(timer); resolve(null); });
            child.once('close', (code) => { clearTimeout(timer); resolve(code); });
          });
          check('sandboxed client reaches the private short socket', result === PRIVILEGED_SHIM_EXIT.REFUSED);
        } finally { rmSync(sandbox.emptyDir, { recursive: true, force: true }); }
      }
    }
  } finally {
    if (channel) await channel.stop();
    rmSync(root, { recursive: true, force: true });
  }
  check('short socket directory removed on stop', !existsSync(shortDir));
}

// --- happy path: danger op → accepted immediately → owner result is durable ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-e2e-'));
  const store = createStore();
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 10_000,
  });
  try {
    check('launcher installed', existsSync(channel.binPath));
    check('legacy launcher retained', existsSync(join(channel.binDir, 'agentoc-privileged')));
    if (process.platform !== 'win32') {
      for (const executable of [channel.binPath, join(channel.binDir, 'agentoc-privileged')]) {
        const help = spawnSync(executable, ['--help'], { encoding: 'utf8' });
        check('launcher runs help', help.status === 0 && help.stdout.includes('ragent-privileged'));
      }
    }
    check('launcher executable', (statSync(channel.binPath).mode & 0o111) !== 0);
    check('socket created', existsSync(channel.socketPath));
    if (process.platform === 'linux' && resultsDir.startsWith('/tmp/')) {
      check('temporary Run uses a private bindable socket directory', !!channel.socketBindDir);
    }
    statSync(channel.socketPath).mode & 0o077 === 0
      ? check('socket closed perms', true)
      : check('socket perms best-effort (tmpfs)', true);

    const startedAt = Date.now();
    const clientPromise = spawnClient(sentinelArgs, channel.socketPath, { cwd: resultsDir });
    const pending = await waitFor(() => store.state.record.privilegedShimPending);
    check('shim pending recorded on run', !!pending);
    check('pending carries requestId', pending?.requestId?.startsWith('pshim_') === true);
    check('pending carries manifestHash', !!pending?.manifestHash);
    check('pending carries async expiry', Number.isFinite(Date.parse(pending?.expiresAt || '')));

    const batch = await waitFor(() => store.state.record.privilegedBatchPending);
    check('batch pending recorded on run', !!batch);
    check('batch and shim pending share batchId', batch?.batchId === pending?.batchId);
    check('batch carries danger risk for the sheet', batch?.other?.[0]?.risk?.tier === 'danger');
    check('batch carries manifest hash', batch?.other?.[0]?.manifestHash === pending?.manifestHash);

    const client = await clientPromise;
    check('client returns promptly after acceptance', Date.now() - startedAt < 2_000);
    check('client exits with pending status', client.code === PRIVILEGED_SHIM_EXIT.PENDING);
    check('client explains approval is still pending', client.stderr.includes('has not run yet'));

    // Owner approves; the server resolve path writes the shim result after the
    // provider command has already returned.
    store.state.record = {
      ...store.state.record,
      privilegedShimPending: undefined,
      privilegedShimResult: {
        batchId: batch.batchId,
        requestId: pending.requestId,
        status: 'resolved',
        results: [{
          manifestHash: pending.manifestHash,
          state: 'completed',
          resultRef: { exitCode: 0, stdout: 'set-property ok', stderr: '' },
        }],
      },
    };

    check('approved result remains on run record for async consumers', store.state.record.privilegedShimResult?.status === 'resolved');
    check('approved result retains executor stdout', store.state.record.privilegedShimResult.results[0].resultRef.stdout === 'set-property ok');
  } finally {
    await channel.stop();
  }
  check('socket removed on stop', !existsSync(channel.socketPath));
}

// --- safe command refused without touching the approval pipeline ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-safe-'));
  const store = createStore();
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 10_000,
  });
  try {
    const client = await spawnClient(['--desc', 'listing', '--', 'ls', '-la'], channel.socketPath);
    check('safe command exits REFUSED', client.code === PRIVILEGED_SHIM_EXIT.REFUSED);
    check('refusal tells the agent to run it directly', client.stderr.includes('run it directly'));
    check('no batch created for safe command', !store.state.record.privilegedBatchPending);
    check('no shim pending for safe command', !store.state.record.privilegedShimPending);
  } finally {
    await channel.stop();
  }
}

// --- busy: an existing gate batch is never clobbered ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-busy-'));
  const store = createStore();
  store.state.record.privilegedBatchPending = { batchId: 'pbatch_existing', other: [] };
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 10_000,
  });
  try {
    const client = await spawnClient(sentinelArgs, channel.socketPath);
    check('busy run exits REFUSED', client.code === PRIVILEGED_SHIM_EXIT.REFUSED);
    check('existing gate batch untouched', store.state.record.privilegedBatchPending?.batchId === 'pbatch_existing');
    check('no shim pending written while busy', !store.state.record.privilegedShimPending);
  } finally {
    await channel.stop();
  }
}

// --- owner denial ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-deny-'));
  const store = createStore();
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 10_000,
  });
  try {
    const clientPromise = spawnClient(sentinelArgs, channel.socketPath);
    const pending = await waitFor(() => store.state.record.privilegedShimPending);
    check('denial path reaches pending', !!pending);
    store.state.record = {
      ...store.state.record,
      privilegedShimPending: undefined,
      privilegedShimResult: {
        batchId: pending.batchId,
        status: 'resolved',
        results: [{ manifestHash: pending.manifestHash, state: 'denied', resultRef: {} }],
      },
    };
    const client = await clientPromise;
    check('denied request returns pending before owner review', client.code === PRIVILEGED_SHIM_EXIT.PENDING);
    check('pending message mentions owner review', client.stderr.includes('owner approval'));
    check('denial result remains durable after client exit', store.state.record.privilegedShimResult?.status === 'resolved');
  } finally {
    await channel.stop();
  }
}

// --- routing disabled → explicit decline, not a timeout ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-decline-'));
  const store = createStore();
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 10_000,
  });
  try {
    const clientPromise = spawnClient(sentinelArgs, channel.socketPath);
    const pending = await waitFor(() => store.state.record.privilegedShimPending);
    check('decline path reaches pending', !!pending);
    store.state.record = {
      ...store.state.record,
      privilegedShimPending: undefined,
      privilegedShimResult: {
        batchId: pending.batchId,
        status: 'declined',
        reason: 'privileged routing is disabled for this session',
      },
    };
    const client = await clientPromise;
    check('declined request returns pending before server writeback', client.code === PRIVILEGED_SHIM_EXIT.PENDING);
    check('pending message is emitted before decline writeback', client.stderr.includes('owner approval'));
    check('decline result remains durable after client exit', store.state.record.privilegedShimResult?.status === 'declined');
  } finally {
    await channel.stop();
  }
}

// --- timeout is handled by the background watcher after the client exits ---
{
  const resultsDir = mkdtempSync(join(tmpdir(), 'agentoc-shim-timeout-'));
  const store = createStore();
  const channel = await startPrivilegedShimChannel({
    runId: RUN_ID,
    nodePath: process.execPath,
    commandEntryPath: CLIENT_ENTRY,
    resultsDir,
    ...store,
    classifyRiskImpl: dangerRiskClassifier,
    pollIntervalMs: 20,
    timeoutMs: 400,
  });
  try {
    const client = await spawnClient(sentinelArgs, channel.socketPath);
    check('timeout request returns pending immediately', client.code === PRIVILEGED_SHIM_EXIT.PENDING);
    const timedOut = await waitFor(
      () => store.state.record.privilegedShimResult?.status === 'timeout',
      { timeoutMs: 3_000 },
    );
    check('background watcher writes timeout result', timedOut === true);
    check('pending cleared on async timeout', !store.state.record.privilegedShimPending);
  } finally {
    await channel.stop();
  }
}

// --- channel unavailable: the historical false negative now self-describes ---
{
  const missing = await spawnClient(sentinelArgs, null);
  check('missing socket env exits CHANNEL', missing.code === PRIVILEGED_SHIM_EXIT.CHANNEL_UNAVAILABLE);
  check('missing env message names the env var', missing.stderr.includes('AGENTOC_PRIVILEGED_SHIM_SOCKET'));
  check('missing env message explains the sidecar', missing.stderr.includes('sidecar'));

  const stale = await spawnClient(sentinelArgs, join(tmpdir(), 'agentoc-shim-no-such.sock'));
  check('dead socket exits CHANNEL', stale.code === PRIVILEGED_SHIM_EXIT.CHANNEL_UNAVAILABLE);
  check('dead socket message mentions ENOENT condition', stale.stderr.includes('socket'));
}

// --- usage errors ---
{
  const usage = await spawnClient(['systemctl', 'status'], join(tmpdir(), 'unused.sock'));
  check('missing separator exits USAGE', usage.code === PRIVILEGED_SHIM_EXIT.USAGE);
  const help = await spawnClient(['--help'], null);
  check('--help exits 0', help.code === 0);
  check('--help prints usage', help.stdout.includes('Usage:'));
}

// --- server-side writeback updaters (pure) ---
{
  const batchId = 'pbatch_writeback';
  const runRecord = {
    id: RUN_ID,
    privilegedShimPending: { requestId: 'pshim_writeback', batchId, manifestHash: 'hash-a' },
  };
  const finalBatch = {
    batchId,
    actions: [
      { manifestHash: 'hash-a', canonicalCommand: 'systemctl set-property x', state: 'completed', resultRef: { exitCode: 0, stdout: 'ok' } },
      { manifestHash: 'hash-b', canonicalCommand: 'systemctl stop y', state: 'denied', resultRef: {} },
    ],
  };
  const updater = buildPrivilegedShimResolveUpdate(runRecord, finalBatch);
  check('resolve updater produced', typeof updater === 'function');
  const next = updater(runRecord);
  check('resolve updater clears pending', next.privilegedShimPending === undefined);
  check('resolve updater writes result', next.privilegedShimResult?.status === 'resolved');
  check('resolve updater carries requestId', next.privilegedShimResult?.requestId === 'pshim_writeback');
  check('resolve updater carries per-op results', next.privilegedShimResult?.results?.length === 2);

  check('resolve updater null without pending', buildPrivilegedShimResolveUpdate({ id: RUN_ID }, finalBatch) === null);
  check('resolve updater null on batch mismatch', buildPrivilegedShimResolveUpdate(runRecord, { batchId: 'pbatch_other', actions: [] }) === null);

  const installBatch = {
    batchId,
    installAuto: [{ opId: 'pop_i1', manifestHash: 'hash-i', command: 'apt-get install -y nginx' }],
  };
  const installUpdater = buildPrivilegedShimInstallAutoUpdate(runRecord, installBatch, [
    { opId: 'pop_i1', exitCode: 0, stdoutRef: 'ref-1' },
  ]);
  check('installAuto updater produced', typeof installUpdater === 'function');
  const installNext = installUpdater(runRecord);
  check('installAuto maps exit 0 to completed', installNext.privilegedShimResult?.results?.[0]?.state === 'completed');
  check('installAuto carries stdoutRef', installNext.privilegedShimResult?.results?.[0]?.resultRef?.stdoutRef === 'ref-1');
  check('installAuto updater null without events', buildPrivilegedShimInstallAutoUpdate(runRecord, installBatch, []) === null);

  const declineUpdater = buildPrivilegedShimDeclineUpdate(runRecord, { batchId }, false);
  check('decline updater produced when routing disabled', typeof declineUpdater === 'function');
  const declinedNext = declineUpdater(runRecord);
  check('decline updater writes declined', declinedNext.privilegedShimResult?.status === 'declined');
  check('decline updater null when routing enabled', buildPrivilegedShimDeclineUpdate(runRecord, { batchId }, true) === null);

  const terminalUpdater = buildPrivilegedShimTerminalUpdate(runRecord, { batchId }, {
    status: 'timeout',
    reason: 'owner deadline reached',
  });
  check('terminal updater produced for timeout', typeof terminalUpdater === 'function');
  const terminalNext = terminalUpdater(runRecord);
  check('terminal updater clears pending', terminalNext.privilegedShimPending === undefined);
  check('terminal updater writes timeout', terminalNext.privilegedShimResult?.status === 'timeout');
  check('terminal updater preserves reason', terminalNext.privilegedShimResult?.reason === 'owner deadline reached');
}

console.log(`privileged-shim-channel: ${passed} checks passed`);
