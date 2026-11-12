#!/usr/bin/env node
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';

import { generatePrivilegedSigningKeyPair, signPrivilegedToken, createPrivilegedKeyId } from '../chat/privileged-token.mjs';
import { computeOpManifestHash } from '../chat/privileged-ops.mjs';
import { requestPrivilegedExecutor } from '../lib/privileged-executor-protocol.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

async function main() {
const tmpDir = await mkdtemp(join(tmpdir(), 'agentoc-p3c-test-'));

// ── helpers ──────────────────────────────────────────────────────────────────

function exportPublicKeyBytes(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).toString('base64url');
}

function exportPrivateKeyBytes(keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const start = Date.now();
  while (true) {
    try {
      const stats = await stat(socketPath);
      if (stats.isSocket()) return;
    } catch {}
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Socket ${socketPath} did not appear within ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

async function stopExecutor(handle) {
  const child = handle?.child || handle;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('close', resolve);
    child.kill('SIGKILL');
  });
}

async function startExecutor({ socketPath, keysFilePath, auditFile, skipLiveness = true, peerCredHelper = null, forcePeerCred = false, serviceUserFile = null, semanticWindowsEnabled = false }) {
  const env = {
    ...process.env,
    AGENTOC_RUNNER_SUPERVISOR_SOCKET: "",
    AGENTOC_RUNNER_SUPERVISOR_REQUIRED: "",
    AGENTOC_PRIVILEGED_EXECUTOR_ALLOW_UNPRIVILEGED_TEST: '1',
    AGENTOC_PRIVILEGED_EXECUTOR_SOCKET: socketPath,
    AGENTOC_PRIVILEGED_SIGNING_KEYS_FILE: keysFilePath,
    AGENTOC_PRIVILEGED_EXECUTOR_AUDIT_FILE: auditFile,
    ...(skipLiveness ? { AGENTOC_PRIVILEGED_EXECUTOR_SKIP_RUNNER_LIVENESS: '1' } : {}),
    ...(peerCredHelper ? { AGENTOC_PRIVILEGED_PEERCRED_HELPER: peerCredHelper } : {}),
    ...(forcePeerCred ? { AGENTOC_PRIVILEGED_EXECUTOR_FORCE_PEERCRED: '1' } : {}),
    ...(serviceUserFile ? { AGENTOC_SERVICE_USER_FILE: serviceUserFile } : {}),
    ...(semanticWindowsEnabled ? { AGENTOC_SEMANTIC_WINDOWS_ADAPTER_ENABLED: '1' } : {}),
    PATH: process.env.PATH,
  };
  const child = spawn(process.execPath, ['scripts/privileged-executor.mjs', 'serve'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let exitHandler = null;
  try {
    const exited = new Promise((resolve, reject) => {
      exitHandler = (code, signal) => {
        reject(new Error(`executor exited before socket was ready (${signal || code})`));
      };
      child.once('exit', exitHandler);
    });
    await Promise.race([waitForSocket(socketPath, 10_000), exited]);
  } catch (err) {
    await stopExecutor(child);
    throw new Error(`Executor did not start: ${err.message}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`);
  } finally {
    if (exitHandler) child.off('exit', exitHandler);
  }
  return { child, getOutput: () => ({ stdout, stderr }) };
}

let executor = null;
try {
// ── key pair for tests ───────────────────────────────────────────────────────

const keyPair = generatePrivilegedSigningKeyPair();
const kid = createPrivilegedKeyId();
const keysFile = join(tmpDir, 'privileged-signing-keys.json');
const keysPayload = {
  current: {
    kid,
    publicKey: exportPublicKeyBytes(keyPair.publicKey),
    privateKey: exportPrivateKeyBytes(keyPair.privateKey),
    created: new Date().toISOString(),
  },
  previous: null,
};
await writeFile(keysFile, JSON.stringify(keysPayload, null, 2) + '\n', { mode: 0o600 });

const socketPath = join(tmpDir, 'sock');
const auditFile = join(tmpDir, 'audit.jsonl');

// ── start executor ───────────────────────────────────────────────────────────

const startedExecutor = await startExecutor({
  socketPath,
  keysFilePath: keysFile,
  auditFile,
});
executor = startedExecutor.child;
check('executor started', executor.exitCode === null && executor.signalCode === null);

// Windows semantic requests never fall back to the Linux or shell routes.
{
  const resp = await requestPrivilegedExecutor({
    action: 'semantic-exec',
    capability: { adapter: 'windows-winget-install/v1', nonce: 'windows-disabled-test' },
  }, { socketPath, timeoutMs: 5_000 });
  check('Windows semantic adapter is disabled by default', resp.ok === false && resp.code === 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

{
  const windowsDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-windows-platform-'));
  const windowsSocket = join(windowsDir, 'exec.sock');
  const windowsAudit = join(windowsDir, 'audit.jsonl');
  const windowsExecutor = await startExecutor({
    socketPath: windowsSocket,
    keysFilePath: keysFile,
    auditFile: windowsAudit,
    semanticWindowsEnabled: true,
  });
  try {
    const resp = await requestPrivilegedExecutor({
      action: 'semantic-exec',
      capability: { adapter: 'windows-winget-install/v1', nonce: 'windows-platform-test' },
    }, { socketPath: windowsSocket, timeoutMs: 5_000 });
    check('Windows semantic adapter remains hard-disabled until runtime boundary exists', resp.ok === false && resp.code === 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
  } finally {
    await stopExecutor(windowsExecutor);
    await rm(windowsDir, { recursive: true, force: true });
  }
}

// ── test 1: successful exec (echo) ───────────────────────────────────────────

// Phase 4: passkey-mode tokens only run allowlisted programs as root (see
// PASSKEY_EXECUTABLE_ALLOWLIST) — `echo` is deliberately NOT allowed. `df`
// is a read-only allowlisted utility, so the happy-path assertion exercises the
// executor end-to-end without side effects.
const op1 = {
  opId: 'pop_test_echo',
  command: 'df /tmp',
  category: 'privileged_other',
  cwd: '/tmp',
  manifestHash: computeOpManifestHash({ command: 'df /tmp', category: 'privileged_other', cwd: '/tmp' }),
};

const token1 = signPrivilegedToken({
  kid,
  opId: op1.opId,
  category: op1.category,
  command: op1.command,
  cwd: op1.cwd,
  manifestHash: op1.manifestHash,
  sessionId: 'sess_test',
  runId: 'run_test',
  turnId: 'turn_test',
  cgroup: 'agentoc-runner-run_test',
  authMode: 'passkey',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}, keyPair.privateKey, { kid });

{
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: token1, auditLabel: 'P3c test: echo' },
    { socketPath, timeoutMs: 10_000 },
  );
  check('exec: ok true', resp.ok === true);
  check('exec: opId', resp.result.opId === op1.opId);
  check('exec: exitCode 0', resp.result.exitCode === 0);
  check('exec: stdout non-empty (df output)', (resp.result.stdout || '').trim().length > 0);
  check('exec: has auditId', resp.result.auditId && resp.result.auditId.startsWith('paud_'));
  check('exec: durationMs > 0', resp.result.durationMs > 0);
}

// ── test 2: rejected — invalid signature (tampered token) ────────────────────

{
  const tamperedToken = { ...token1, command: 'echo tampered-by-attacker' };
  // signature still covers the OLD command — mismatch
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: tamperedToken },
    { socketPath, timeoutMs: 5_000 },
  );
  check('tampered: ok false', resp.ok === false);
  check('tampered: code INVALID', resp.code === 'PRIVILEGED_TOKEN_INVALID');
}

// ── test 2b: rejected — signed token with stale manifest hash ────────────────

{
  const mismatchToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_manifest_mismatch',
    category: 'privileged_other',
    command: 'echo changed-command',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'echo old-command', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'passkey',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: mismatchToken },
    { socketPath, timeoutMs: 5_000 },
  );
  check('manifest-mismatch: ok false', resp.ok === false);
  check('manifest-mismatch: code COMMAND_MISMATCH', resp.code === 'PRIVILEGED_COMMAND_MISMATCH');
}

// ── test 3: rejected — token already consumed (replay) ───────────────────────

{
  // Re-send token1 (already consumed in test 1)
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: token1 },
    { socketPath, timeoutMs: 5_000 },
  );
  check('replay: ok false', resp.ok === false);
  check('replay: code CONSUMED', resp.code === 'PRIVILEGED_TOKEN_CONSUMED');
}

// ── test 3b: consumed-set rebuild from audit (restart replay protection) ─────

{
  // Simulate an executor restart: pre-seed an audit file whose command_started
  // records an opId the new process has never seen, then submit that opId's
  // token. The rebuilt consumed set must reject it (blocks replay across
  // restarts — proposal §2.3 lifecycle).
  const restartDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-restart-'));
  const restartSocket = join(restartDir, 'exec.sock');
  const restartAudit = join(restartDir, 'audit.jsonl');
  const restartOpId = 'pop_test_restart_replay';
  const replayToken = signPrivilegedToken({
    kid,
    opId: restartOpId,
    category: 'privileged_other',
    command: 'echo replay',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'echo replay', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'passkey',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  // Seed the audit exactly as appendAudit would have for a prior execution.
  await writeFile(restartAudit, JSON.stringify({
    at: new Date().toISOString(),
    event: 'command_started',
    opId: restartOpId,
  }) + '\n', { mode: 0o600 });
  const restartExecutor = await startExecutor({
    socketPath: restartSocket,
    keysFilePath: keysFile,
    auditFile: restartAudit,
  });
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: replayToken },
      { socketPath: restartSocket, timeoutMs: 10_000 },
    );
    check('restart replay: ok false', resp.ok === false);
    check('restart replay: code CONSUMED', resp.code === 'PRIVILEGED_TOKEN_CONSUMED');
  } finally {
    await stopExecutor(restartExecutor);
    await rm(restartDir, { recursive: true, force: true });
  }
}

// ── test 4: rejected — expired token ─────────────────────────────────────────

// Competing uses of one signed token must reserve it before either request
// reaches asynchronous audit I/O.
{
  const opId = 'pop_test_concurrent_replay';
  const command = 'df /tmp';
  const token = signPrivilegedToken({ kid, opId, category: 'privileged_other', command, cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command, category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test', runId: 'run_test', turnId: 'turn_test', cgroup: 'agentoc-runner-run_test',
    authMode: 'passkey', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const responses = await Promise.all(Array.from({ length: 8 }, () => requestPrivilegedExecutor(
    { action: 'exec', token }, { socketPath, timeoutMs: 10_000 },
  )));
  check('concurrent replay: exactly one execution', responses.filter((entry) => entry.ok).length === 1);
  check('concurrent replay: all others refused', responses.filter((entry) => entry.code === 'PRIVILEGED_TOKEN_CONSUMED').length === 7);
}

// A truncated ledger cannot be treated as an empty replay history.
{
  const brokenDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-broken-audit-'));
  try {
    const brokenAudit = join(brokenDir, 'audit.jsonl');
    await writeFile(brokenAudit, '{"event":"command_started"', { mode: 0o600 });
    await assert.rejects(startExecutor({ socketPath: join(brokenDir, 'exec.sock'), keysFilePath: keysFile, auditFile: brokenAudit }),
      /incomplete record/);
    await writeFile(brokenAudit, 'not json\n');
    await assert.rejects(startExecutor({ socketPath: join(brokenDir, 'exec.sock'), keysFilePath: keysFile, auditFile: brokenAudit }),
      /invalid record/);
    await unlink(brokenAudit);
    await symlink(keysFile, brokenAudit);
    await assert.rejects(startExecutor({ socketPath: join(brokenDir, 'exec.sock'), keysFilePath: keysFile, auditFile: brokenAudit }),
      /Cannot read privileged audit/);
    check('broken audit prevents startup', true);
  } finally { await rm(brokenDir, { recursive: true, force: true }); }
}

// A write failure after startup must prevent the requested operation.
{
  const failedDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-audit-failure-'));
  const failedSocket = join(failedDir, 'exec.sock');
  const failedAudit = join(failedDir, 'audit.jsonl');
  const marker = join(failedDir, 'must-not-exist');
  const failedExecutor = await startExecutor({ socketPath: failedSocket, keysFilePath: keysFile, auditFile: failedAudit });
  try {
    await mkdir(failedAudit);
    const command = `touch ${marker}`;
    const token = signPrivilegedToken({ kid, opId: 'pop_test_audit_failure', category: 'privileged_other', command, cwd: '/tmp',
      manifestHash: computeOpManifestHash({ command, category: 'privileged_other', cwd: '/tmp' }),
      sessionId: 'sess_test', runId: 'run_test', turnId: 'turn_test', cgroup: 'agentoc-runner-run_test',
      authMode: 'passkey', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, keyPair.privateKey, { kid });
    const response = await requestPrivilegedExecutor({ action: 'exec', token }, { socketPath: failedSocket, timeoutMs: 10_000 });
    check('audit failure refuses execution', !response.ok && response.code === 'PRIVILEGED_AUDIT_REQUIRED');
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally { await stopExecutor(failedExecutor); await rm(failedDir, { recursive: true, force: true }); }
}

{
  const expiredToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_expired',
    category: 'privileged_other',
    command: 'echo x',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'echo x', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'passkey',
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(), // expired 60s ago
  }, keyPair.privateKey, { kid });

  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: expiredToken },
    { socketPath, timeoutMs: 5_000 },
  );
  check('expired: ok false', resp.ok === false);
  check('expired: code EXPIRED', resp.code === 'PRIVILEGED_TOKEN_EXPIRED');
}

// ── test 5: install-auto — structural whitelist check ────────────────────────

{
  const inScopeInstallToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_install',
    category: 'software_install',
    command: 'apt-get install -s nginx',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'apt-get install -s nginx', category: 'software_install', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'install-auto',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });

  // install-auto with a valid named-package install command should pass
  // executor-side structural verification. The -s flag keeps the command in
  // apt simulation mode when apt-get exists, so this test never installs nginx.
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: inScopeInstallToken, auditLabel: 'P3c test: apt install' },
    { socketPath, timeoutMs: 10_000 },
  );
  // install command will likely fail (no apt in test env) but token verification should pass
  check('install-auto: has response', resp !== null);
  check('install-auto: has id', typeof resp.id === 'string');
  // The executor verified the token, attempted spawn, and returned whatever exitCode apt produced
}

// ── test 6: install-auto rejected — out-of-scope command ─────────────────────

{
  const outOfScopeInstallToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_bad_install',
    category: 'software_install',
    command: 'pip install requests',  // language package manager — out of scope
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'pip install requests', category: 'software_install', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'install-auto',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });

  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: outOfScopeInstallToken },
    { socketPath, timeoutMs: 5_000 },
  );
  check('bad-install: ok false', resp.ok === false);
  check('bad-install: code SCOPE_DENIED', resp.code === 'PRIVILEGED_INSTALL_SCOPE_DENIED');
}

// ── test 7: rejected — cgroup mismatch ───────────────────────────────────────

{
  const badCgroupToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_cgroup',
    category: 'privileged_other',
    command: 'echo cgroup-test',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'echo cgroup-test', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-WRONG_RUN_ID',  // mismatch with runId
    authMode: 'passkey',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });

  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: badCgroupToken },
    { socketPath, timeoutMs: 5_000 },
  );
  check('cgroup: ok false', resp.ok === false);
  check('cgroup: code CGROUP_MISMATCH', resp.code === 'PRIVILEGED_CGROUP_MISMATCH');
}

// ── test 8: audit file written ───────────────────────────────────────────────

{
  const { readFile } = await import('fs/promises');
  const auditContent = await readFile(auditFile, 'utf8').catch(() => '');
  const auditLines = auditContent.split('\n').filter(Boolean);
  check('audit has entries', auditLines.length > 0, `got ${auditLines.length}`);

  // Should have command_started + command_completed for the echo test
  const startedEntries = auditLines.filter((l) => l.includes('command_started'));
  const completedEntries = auditLines.filter((l) => l.includes('command_completed'));
  check('audit has command_started entries', startedEntries.length >= 1);
  check('audit has command_completed entries', completedEntries.length >= 1);

  // Should have request_failed for rejected tokens
  const failedEntries = auditLines.filter((l) => l.includes('request_failed'));
  check('audit has request_failed entries', failedEntries.length >= 1);

  // Permissions: 0o640, owner = test process uid (unprivileged test mode).
  const auditStat = await stat(auditFile);
  check('audit: mode 0640', (auditStat.mode & 0o777) === 0o640);
  check('audit: owner is test uid', auditStat.uid === process.geteuid());

  // Append-only: a second successful exec appends without truncating — the
  // original entries must still be present afterwards.
  const auditLinesBefore = auditLines.length;
  const appendToken = signPrivilegedToken({
    kid,
    opId: 'pop_test_append',
    category: 'privileged_other',
    command: 'df /tmp',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'df /tmp', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'passkey',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const appendResp = await requestPrivilegedExecutor(
    { action: 'exec', token: appendToken },
    { socketPath, timeoutMs: 10_000 },
  );
  check('append-only: second exec ok', appendResp.ok === true);
  const auditAfter = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean);
  check('append-only: lines grew', auditAfter.length > auditLinesBefore);
  check('append-only: original line kept', auditAfter.slice(0, auditLinesBefore).every((l, i) => l === auditLines[i]));
}

// ── test 9: rejected — unknown action ────────────────────────────────────────

{
  const resp = await requestPrivilegedExecutor(
    { action: 'status', token: token1 },
    { socketPath, timeoutMs: 5_000 },
  );
  check('unknown action: ok false', resp.ok === false);
  check('unknown action: code', resp.code === 'PRIVILEGED_UNKNOWN_ACTION');
}

// ── test 10: D4 liveness — pure decision + rejection branch ──────────────────

{
  const { evaluateRunnerLiveness } = await import('../scripts/privileged-executor.mjs');
  const ok = evaluateRunnerLiveness('active');
  check('liveness: active ok', ok.ok === true && ok.code === 'PRIVILEGED_TOKEN_OK');
  for (const raw of ['inactive', 'failed', 'unknown', 'activating', '  ', '']) {
    const r = evaluateRunnerLiveness(raw);
    check(`liveness: ${JSON.stringify(raw)} rejected`, r.ok === false && r.code === 'PRIVILEGED_CGROUP_INACTIVE');
  }
}

{
  // Real rejection branch: executor WITHOUT the skip env, submitting a valid
  // token whose runner unit (agentoc-runner-run_liveness) does not exist on
  // this host — systemctl is-active fails closed.
  const livenessDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-liveness-'));
  const livenessSocket = join(livenessDir, 'exec.sock');
  const livenessAudit = join(livenessDir, 'audit.jsonl');
  const livenessExecutor = await startExecutor({
    socketPath: livenessSocket,
    keysFilePath: keysFile,
    auditFile: livenessAudit,
    skipLiveness: false,
  });
  try {
    const livenessToken = signPrivilegedToken({
      kid,
      opId: 'pop_test_liveness',
      category: 'privileged_other',
      command: 'echo liveness',
      cwd: '/tmp',
      manifestHash: computeOpManifestHash({ command: 'echo liveness', category: 'privileged_other', cwd: '/tmp' }),
      sessionId: 'sess_test',
      runId: 'run_liveness',
      turnId: 'turn_test',
      cgroup: 'agentoc-runner-run_liveness',
      authMode: 'passkey',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, keyPair.privateKey, { kid });
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: livenessToken },
      { socketPath: livenessSocket, timeoutMs: 10_000 },
    );
    check('liveness: inactive unit rejected', resp.ok === false);
    check('liveness: code CGROUP_INACTIVE', resp.code === 'PRIVILEGED_CGROUP_INACTIVE');
    // The rejected request must NOT execute — audit has no command_started for it.
    const { readFile } = await import('fs/promises');
    const auditContent = await readFile(livenessAudit, 'utf8').catch(() => '');
    const started = auditContent.split('\n').filter((l) => l.includes('command_started'));
    check('liveness: no command_started on rejection', started.length === 0);
  } finally {
    await stopExecutor(livenessExecutor);
    await rm(livenessDir, { recursive: true, force: true });
  }
}

// ── test 11+12: SO_PEERCRED caller identity — reject + pass branches ─────────

async function writePeerCredHelper(dir, uid) {
  const helperPath = join(dir, 'fake-peercred');
  await writeFile(helperPath, `#!/bin/sh\necho '{"pid":123,"uid":${uid}}'\n`);
  await chmod(helperPath, 0o755);
  return helperPath;
}

function signValidTestToken(opId) {
  return signPrivilegedToken({
    kid,
    opId,
    category: 'privileged_other',
    command: 'echo peercred',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'echo peercred', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_peercred',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_peercred',
    authMode: 'passkey',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
}

{
  // Reject branch: fake helper reports a uid that is not the AgentoC service
  // user — the executor must fail closed before touching the token.
  const peerDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-peercred-'));
  const serviceUserFile = join(peerDir, 'service-user');
  const fixtureServiceUser = process.getuid?.() === 0 ? 'nobody' : userInfo().username;
  await writeFile(serviceUserFile, `${fixtureServiceUser}\n`);
  const serviceUid = Number.parseInt(execFileSync('getent', ['passwd', fixtureServiceUser], { encoding: 'utf8' }).split(':')[2], 10);
  const helperPath = await writePeerCredHelper(peerDir, serviceUid === 99999 ? 99998 : 99999);
  const peerSocket = join(peerDir, 'exec.sock');
  const peerAudit = join(peerDir, 'audit.jsonl');
  const peerExecutor = await startExecutor({
    socketPath: peerSocket,
    keysFilePath: keysFile,
    auditFile: peerAudit,
    peerCredHelper: helperPath,
    forcePeerCred: true,
    serviceUserFile,
  });
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: signValidTestToken('pop_test_peercred_deny') },
      { socketPath: peerSocket, timeoutMs: 10_000 },
    );
    check('peercred: mismatched uid rejected', resp.ok === false);
    check('peercred: code CALLER_DENIED', resp.code === 'PRIVILEGED_CALLER_DENIED');
  } finally {
    await stopExecutor(peerExecutor);
    await rm(peerDir, { recursive: true, force: true });
  }
}

{
  // Pass branch: fake helper reports the real service-user uid — the request
  // must pass peer verification and reach token validation (which rejects the
  // tampered token), proving the peer layer did NOT deny it. The service-user
  // file is injected so the test is hermetic (the host's /etc/agentoc/service-user
  // may name a different account).
  const peerDir = await mkdtemp(join(tmpdir(), 'agentoc-exec-peercred-ok-'));
  const serviceUserFile = join(peerDir, 'service-user');
  const fixtureServiceUser = process.getuid?.() === 0 ? 'nobody' : userInfo().username;
  await writeFile(serviceUserFile, `${fixtureServiceUser}\n`);
  const agentocUid = Number.parseInt(execFileSync('getent', ['passwd', fixtureServiceUser], { encoding: 'utf8' }).split(':')[2], 10);
  const helperPath = await writePeerCredHelper(peerDir, agentocUid);
  const peerSocket = join(peerDir, 'exec.sock');
  const peerAudit = join(peerDir, 'audit.jsonl');
  const peerExecutor = await startExecutor({
    socketPath: peerSocket,
    keysFilePath: keysFile,
    auditFile: peerAudit,
    peerCredHelper: helperPath,
    forcePeerCred: true,
    serviceUserFile,
  });
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: 'tampered-token-not-signed-by-executor-keys' },
      { socketPath: peerSocket, timeoutMs: 10_000 },
    );
    check('peercred: matching uid passes peer layer', resp.ok === false);
    check('peercred: error is token-level, not CALLER_DENIED', resp.code !== 'PRIVILEGED_CALLER_DENIED' && typeof resp.code === 'string');
  } finally {
    await stopExecutor(peerExecutor);
    await rm(peerDir, { recursive: true, force: true });
  }
}

// ── test 13: owner-click shares the passkey executable gate ──────────────────

{
  // Regression for the 88604cb2 review finding: dropping the passkey PROOF
  // (owner-click policy) must not also drop the executable allowlist. A
  // signed owner-click token for a shell must be denied without executing;
  // the same mode still executes allowlisted programs.
  const mkOwnerClickToken = (opId, command) => signPrivilegedToken({
    kid,
    opId,
    category: 'privileged_other',
    command,
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command, category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'owner-click',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });

  // (a) allowlisted program under owner-click executes end-to-end
  const victimDir = await mkdtemp(join(tmpdir(), 'agentoc-owner-click-exec-'));
  const rmCommand = `rm -rf ${victimDir}`;
  const execToken = mkOwnerClickToken('pop_owner_click_exec', rmCommand);
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: execToken, auditLabel: 'P3c test: owner-click rm' },
      { socketPath, timeoutMs: 10_000 },
    );
    check('owner-click exec: ok true', resp.ok === true);
    check('owner-click exec: exitCode 0', resp.result.exitCode === 0);
    const gone = await stat(victimDir).then(() => false, () => true);
    check('owner-click exec: target actually removed', gone);
  } finally {
    await rm(victimDir, { recursive: true, force: true });
  }

  // (b) shell under owner-click is denied and never spawns
  const shellDir = await mkdtemp(join(tmpdir(), 'agentoc-owner-click-shell-'));
  const shellCommand = `sudo bash -c 'rm -rf ${shellDir}'`;
  const shellToken = mkOwnerClickToken('pop_owner_click_shell', shellCommand);
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: shellToken, auditLabel: 'P3c test: owner-click shell deny' },
      { socketPath, timeoutMs: 10_000 },
    );
    check('owner-click shell: ok false', resp.ok === false);
    check('owner-click shell: code OWNER_CLICK_SCOPE_DENIED', resp.code === 'PRIVILEGED_OWNER_CLICK_SCOPE_DENIED');
    const stillThere = await stat(shellDir).then(() => true, () => false);
    check('owner-click shell: target untouched', stillThere);
  } finally {
    await rm(shellDir, { recursive: true, force: true });
  }

  // A first-token allowlist is insufficient while the executor uses /bin/sh -c:
  // a composite command can keep `rm` as its prefix and append an unapproved
  // second operation. The scope gate must reject it before spawn.
  const compositeDir = await mkdtemp(join(tmpdir(), 'agentoc-owner-click-composite-'));
  const markerPath = join(compositeDir, 'marker');
  const compositeToken = mkOwnerClickToken(
    'pop_owner_click_composite',
    `rm -rf ${compositeDir}; touch ${markerPath}`,
  );
  try {
    const resp = await requestPrivilegedExecutor(
      { action: 'exec', token: compositeToken, auditLabel: 'P3c test: owner-click composite deny' },
      { socketPath, timeoutMs: 10_000 },
    );
    check('owner-click composite: ok false', resp.ok === false);
    check('owner-click composite: code OWNER_CLICK_SCOPE_DENIED', resp.code === 'PRIVILEGED_OWNER_CLICK_SCOPE_DENIED');
    const stillThere = await stat(compositeDir).then(() => true, () => false);
    check('owner-click composite: target untouched', stillThere);
    const markerThere = await stat(markerPath).then(() => true, () => false);
    check('owner-click composite: second command untouched', markerThere === false);
  } finally {
    await rm(compositeDir, { recursive: true, force: true });
  }

  // install-auto must not inherit configuration through an environment
  // wrapper that the risk parser intentionally unwraps for classification.
  const installWrapperToken = signPrivilegedToken({
    kid,
    opId: 'pop_install_env_wrapper',
    category: 'software_install',
    command: 'env APT_CONFIG=/tmp/evil.conf sudo apt-get install nginx',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({
      command: 'env APT_CONFIG=/tmp/evil.conf sudo apt-get install nginx',
      category: 'software_install',
      cwd: '/tmp',
    }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'install-auto',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const installWrapperResp = await requestPrivilegedExecutor(
    { action: 'exec', token: installWrapperToken, auditLabel: 'P3c test: install env wrapper deny' },
    { socketPath, timeoutMs: 10_000 },
  );
  check('install env wrapper: ok false', installWrapperResp.ok === false);
  check('install env wrapper: code INSTALL_SCOPE_DENIED', installWrapperResp.code === 'PRIVILEGED_INSTALL_SCOPE_DENIED');

  const installOptionToken = signPrivilegedToken({
    kid,
    opId: 'pop_install_option_hook',
    category: 'software_install',
    command: 'apt-get install --option=DPkg::Pre-Invoke::=/tmp/evil nginx',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({
      command: 'apt-get install --option=DPkg::Pre-Invoke::=/tmp/evil nginx',
      category: 'software_install',
      cwd: '/tmp',
    }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'install-auto',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const installOptionResp = await requestPrivilegedExecutor(
    { action: 'exec', token: installOptionToken, auditLabel: 'P3c test: install option hook deny' },
    { socketPath, timeoutMs: 10_000 },
  );
  check('install option hook: ok false', installOptionResp.ok === false);
  check('install option hook: code INSTALL_SCOPE_DENIED', installOptionResp.code === 'PRIVILEGED_INSTALL_SCOPE_DENIED');

  const tarToken = mkOwnerClickToken(
    'pop_owner_click_tar_hook',
    'tar --checkpoint=1 --checkpoint-action=exec=/tmp/evil -cf /tmp/a /tmp/input',
  );
  const tarResp = await requestPrivilegedExecutor(
    { action: 'exec', token: tarToken, auditLabel: 'P3c test: tar exec hook deny' },
    { socketPath, timeoutMs: 10_000 },
  );
  check('owner-click tar exec hook: ok false', tarResp.ok === false);
  check('owner-click tar exec hook: code OWNER_CLICK_SCOPE_DENIED', tarResp.code === 'PRIVILEGED_OWNER_CLICK_SCOPE_DENIED');

  // (c) unknown authMode on a validly signed token fails closed before scope
  const unknownModeToken = signPrivilegedToken({
    kid,
    opId: 'pop_unknown_mode',
    category: 'privileged_other',
    command: 'df /tmp',
    cwd: '/tmp',
    manifestHash: computeOpManifestHash({ command: 'df /tmp', category: 'privileged_other', cwd: '/tmp' }),
    sessionId: 'sess_test',
    runId: 'run_test',
    turnId: 'turn_test',
    cgroup: 'agentoc-runner-run_test',
    authMode: 'sudo',  // not a known mode — must fail closed, never execute
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, keyPair.privateKey, { kid });
  const unknownResp = await requestPrivilegedExecutor(
    { action: 'exec', token: unknownModeToken, auditLabel: 'P3c test: unknown authMode' },
    { socketPath, timeoutMs: 10_000 },
  );
  check('unknown authMode: ok false', unknownResp.ok === false);
  check('unknown authMode: code AUTH_MODE_INVALID', unknownResp.code === 'PRIVILEGED_AUTH_MODE_INVALID');
}

console.log(`privileged-executor: ${passed} checks passed`);
} finally {
  await stopExecutor(executor);
  await rm(tmpDir, { recursive: true, force: true });
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
