#!/usr/bin/env node
// Unit tests for the real `agentoc-privileged` shim protocol + policy
// (design docs/privileged-shim-channel-2026-09-03.md). Pure modules only —
// live socket flows are covered in test-privileged-shim-channel.mjs.

import assert from 'assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import {
  DEFAULT_PRIVILEGED_SHIM_TIMEOUT_MS,
  PRIVILEGED_SHIM_EXIT,
  PRIVILEGED_SHIM_RESULT_STATUS,
  PRIVILEGED_SHIM_SOCKET_ENV,
  createPrivilegedShimRequestId,
  joinShimCommandTokens,
  parsePrivilegedShimRequest,
  resolveShimAccepted,
  resolveShimExit,
  shimOpRequiresPrivilegedExecution,
  shimResultFromRunPayload,
} from '../chat/privileged-shim-protocol.mjs';
import {
  applyPrivilegedShimSpawnEnv,
  buildPrivilegedShimLauncherScript,
} from '../chat/privileged-shim-listener.mjs';
import { parsePrivilegedShimArgv } from '../chat/privileged-shim-command.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// --- request parsing ---
{
  const base = {
    v: 1,
    type: 'request',
    requestId: 'pshim_abc123',
    command: 'systemctl set-property user-1000.slice TasksMax=infinity',
    description: 'raise TasksMax',
    declaredCategory: 'other',
    cwd: '/home/example/agentoc-dev',
  };
  check('valid request parses', parsePrivilegedShimRequest(base).ok === true);
  check('request id normalized', parsePrivilegedShimRequest(base).request?.requestId === 'pshim_abc123');
  check('empty category allowed', parsePrivilegedShimRequest({ ...base, declaredCategory: '' }).ok === true);
  check('bad category rejected', parsePrivilegedShimRequest({ ...base, declaredCategory: 'reboot' }).ok === false);
  check('missing command rejected', parsePrivilegedShimRequest({ ...base, command: '   ' }).ok === false);
  check('bad version rejected', parsePrivilegedShimRequest({ ...base, v: 2 }).ok === false);
  check('bad frame type rejected', parsePrivilegedShimRequest({ ...base, type: 'hello' }).ok === false);
  check('short request id rejected', parsePrivilegedShimRequest({ ...base, requestId: 'xy' }).ok === false);
  check('request id charset enforced', parsePrivilegedShimRequest({ ...base, requestId: 'bad id spaces' }).ok === false);
  check('control chars in command rejected', parsePrivilegedShimRequest({ ...base, command: 'ls\nrm -rf /' }).ok === false);
  check('non-object rejected', parsePrivilegedShimRequest('hello').ok === false);
}

// --- privileged-execution policy ---
check('danger tier requires privileged exec', shimOpRequiresPrivilegedExecution({ tier: 'danger', signals: {} }) === true);
check('needsPrivilegedExecution signal honored', shimOpRequiresPrivilegedExecution({ tier: 'caution', signals: { needsPrivilegedExecution: true } }) === true);
check('safe command refused', shimOpRequiresPrivilegedExecution({ tier: 'safe', signals: {} }) === false);
check('missing risk refused', shimOpRequiresPrivilegedExecution(null) === false);

// --- exit mapping ---
{
  const ok = resolveShimExit({ status: 'completed', exitCode: 3, stdout: 'out', stderr: 'err' });
  check('completed passes command exit code through', ok.code === 3);
  check('completed has no error message', ok.message === '');
  check('denied maps to 74', resolveShimExit({ status: 'denied' }).code === PRIVILEGED_SHIM_EXIT.DENIED);
  check('refused maps to 70', resolveShimExit({ status: 'refused' }).code === PRIVILEGED_SHIM_EXIT.REFUSED);
  check('declined maps to 70', resolveShimExit({ status: 'declined' }).code === PRIVILEGED_SHIM_EXIT.REFUSED);
  check('timeout maps to 75', resolveShimExit({ status: 'timeout' }).code === PRIVILEGED_SHIM_EXIT.TIMEOUT);
  check('failed maps to 76', resolveShimExit({ status: 'failed' }).code === PRIVILEGED_SHIM_EXIT.EXEC_FAILED);
  check('unknown status fails closed', resolveShimExit({ status: 'wat' }).code === PRIVILEGED_SHIM_EXIT.EXEC_FAILED);
  check('completed without exit code fails closed', resolveShimExit({ status: 'completed' }).code === PRIVILEGED_SHIM_EXIT.EXEC_FAILED);
  check('completed with invalid exit code fails closed', resolveShimExit({ status: 'completed', exitCode: 256 }).code === PRIVILEGED_SHIM_EXIT.EXEC_FAILED);
  check('completed with error fails closed', resolveShimExit({ status: 'completed', exitCode: 0, error: 'unknown result' }).code === PRIVILEGED_SHIM_EXIT.EXEC_FAILED);
  check('accepted maps to pending exit', resolveShimAccepted({ batchId: 'pbatch_1' }).code === PRIVILEGED_SHIM_EXIT.PENDING);
  check('accepted explains command did not run', resolveShimAccepted({ batchId: 'pbatch_1' }).message.includes('has not run yet'));
}

// --- argv grammar (CLI side of the sentinel contract) ---
{
  const parsed = parsePrivilegedShimArgv([
    '--description', 'raise TasksMax',
    '--category', 'other',
    '--', 'systemctl', 'set-property', 'user-1000.slice', 'TasksMax=infinity',
  ]);
  check('argv parses ok', parsed.ok === true);
  check('argv description captured', parsed.description === 'raise TasksMax');
  check('argv category captured', parsed.declaredCategory === 'other');
  check('argv command rejoined', parsed.command === 'systemctl set-property user-1000.slice TasksMax=infinity');

  const quoted = parsePrivilegedShimArgv(['--desc', 'd', '--', 'systemctl', 'set-property', 'a b']);
  check('tokens with spaces re-quoted', quoted.command === "systemctl set-property 'a b'");

  check('missing separator refused', parsePrivilegedShimArgv(['systemctl', 'status']).ok === false);
  check('empty command refused', parsePrivilegedShimArgv(['--']).ok === false);
  check('unknown option refused', parsePrivilegedShimArgv(['--dangerous', '--', 'true']).ok === false);
  check('bare word refused', parsePrivilegedShimArgv(['systemctl', '--', 'status']).ok === false);
  check('flag without value refused', parsePrivilegedShimArgv(['--description', '--', 'true']).ok === false);
}

// --- token join quoting ---
check('join keeps safe tokens bare', joinShimCommandTokens(['apt-get', 'install', '-y', 'nginx']) === 'apt-get install -y nginx');
check('join quotes shell metacharacters', joinShimCommandTokens(['echo', 'a;b']) === "echo 'a;b'");
check('join escapes inner quotes', joinShimCommandTokens(["it's"]) === `'it'\\''s'`);
check('join empty list', joinShimCommandTokens([]) === '');
check('join empty token', joinShimCommandTokens(['']) === "''");

// --- run payload → client frame mapping ---
{
  const resolved = shimResultFromRunPayload({
    batchId: 'pbatch_1',
    status: 'resolved',
    results: [{
      manifestHash: 'hash-1',
      state: 'completed',
      resultRef: { exitCode: 0, stdout: 'set-property ok', stderr: '' },
    }],
  }, { manifestHash: 'hash-1', opId: 'pop_1' });
  check('resolved payload maps completed', resolved.status === PRIVILEGED_SHIM_RESULT_STATUS.COMPLETED);
  check('resolved payload carries stdout', resolved.stdout === 'set-property ok');
  const missingExit = shimResultFromRunPayload({ status: 'resolved', results: [
    { manifestHash: 'hash-1', state: 'completed', resultRef: {} },
  ] }, { manifestHash: 'hash-1' });
  check('completed payload without exit code does not report success', missingExit.status === PRIVILEGED_SHIM_RESULT_STATUS.FAILED);

  const denied = shimResultFromRunPayload({
    status: 'resolved',
    results: [{ manifestHash: 'hash-1', state: 'denied', resultRef: {} }],
  }, { manifestHash: 'hash-1' });
  check('denied action state maps', denied.status === PRIVILEGED_SHIM_RESULT_STATUS.DENIED);

  const declined = shimResultFromRunPayload({ status: 'declined', reason: 'routing disabled' });
  check('declined payload maps', declined.status === PRIVILEGED_SHIM_RESULT_STATUS.DECLINED);
  check('declined reason surfaced', declined.error === 'routing disabled');

  const timedOut = shimResultFromRunPayload({ status: 'timeout', reason: 'deadline reached' });
  check('timeout run payload maps', timedOut.status === PRIVILEGED_SHIM_RESULT_STATUS.TIMEOUT);
  check('timeout reason surfaced', timedOut.error === 'deadline reached');

  const cancelled = shimResultFromRunPayload({ status: 'cancelled', reason: 'run ended' });
  check('cancelled run payload maps', cancelled.status === PRIVILEGED_SHIM_RESULT_STATUS.CANCELLED);
  check('cancelled reason surfaced', cancelled.error === 'run ended');

  const installAuto = shimResultFromRunPayload({
    status: 'resolved',
    results: [{ manifestHash: '', opId: 'pop_1', state: 'failed', resultRef: { exitCode: 100, error: 'apt failed' } }],
  }, { manifestHash: 'hash-1', opId: 'pop_1' });
  check('installAuto fallback picks only result', installAuto.status === PRIVILEGED_SHIM_RESULT_STATUS.FAILED);
  check('installAuto error surfaced', installAuto.error === 'apt failed');

  const wrongResult = shimResultFromRunPayload({ status: 'resolved', results: [
    { manifestHash: 'hash-other', opId: 'pop_other', state: 'completed', resultRef: { exitCode: 0 } },
  ] }, { manifestHash: 'hash-1', opId: 'pop_1' });
  check('unrelated successful result is not accepted', wrongResult.status === PRIVILEGED_SHIM_RESULT_STATUS.FAILED);
  const wrongLegacy = shimResultFromRunPayload({ status: 'resolved', results: [
    { manifestHash: '', opId: 'pop_other', state: 'completed', resultRef: { exitCode: 0 } },
  ] }, { manifestHash: 'hash-1', opId: 'pop_1' });
  check('legacy result must match op id', wrongLegacy.status === PRIVILEGED_SHIM_RESULT_STATUS.FAILED);

  const empty = shimResultFromRunPayload({ status: 'resolved', results: [] });
  check('resolved without results fails explicitly', empty.status === PRIVILEGED_SHIM_RESULT_STATUS.FAILED);
}

// --- launcher + spawn env ---
{
  const dir = mkdtempSync(join(tmpdir(), 'agentoc-shim-test-'));
  const script = buildPrivilegedShimLauncherScript(process.execPath, join(dir, 'privileged-shim-command.mjs'));
  check('launcher has shebang', script.startsWith('#!/bin/sh\n'));
  check('launcher execs node with entry', script.includes(`exec "${process.execPath}"`));
  check('launcher forwards argv', script.includes('"$@"'));
  check('launcher rejects quoted node path', (() => {
    try {
      buildPrivilegedShimLauncherScript('/opt/node "x"/node', '/tmp/x.mjs');
      return false;
    } catch {
      return true;
    }
  })());

  const env = { PATH: '/usr/bin:/bin' };
  applyPrivilegedShimSpawnEnv(env, { binDir: join(dir, 'shim-bin'), socketPath: join(dir, 'shim.sock') });
  check('spawn env prepends shim bin dir', env.PATH.startsWith(`${join(dir, 'shim-bin')}${delimiter}`));
  check('spawn env keeps existing PATH', env.PATH.endsWith(`${delimiter}/usr/bin:/bin`));
  check('spawn env exports socket', env[PRIVILEGED_SHIM_SOCKET_ENV] === join(dir, 'shim.sock'));
}

// --- misc ---
check('request id generator prefixed', createPrivilegedShimRequestId().startsWith('pshim_'));
check('default timeout is generous (owner on phone)', DEFAULT_PRIVILEGED_SHIM_TIMEOUT_MS >= 15 * 60 * 1000);

console.log(`privileged-shim-protocol: ${passed} checks passed`);
