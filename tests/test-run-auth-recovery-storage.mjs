#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-run-auth-storage-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_AUTH_SESSION_SECRET = 'storage-test-secret';

try {
  const {
    clearRunResult,
    createRun,
    getRun,
    getRunManifest,
    getRunResult,
    readRunAuthRecoveryToken,
    runAuthRecoveryCapabilityPath,
    runManifestPath,
    runStatusPath,
    updateRun,
    writeRunResult,
  } = await import('../chat/runs.mjs');

  const run = await createRun({
    status: {
      sessionId: 'session_storage_1',
      requestId: 'turn_storage_1',
      state: 'failed',
      failureReason: '401 unauthorized',
      codexThreadId: 'thread_storage_1',
      completedAt: '2026-08-27T00:00:01.000Z',
      runnerProcessId: 12345,
      runnerUnitName: 'ragent-runner-old.service',
      runnerLaunchQueuedAt: '2026-08-27T00:00:00.100Z',
      runnerLifecycleSubmittedAt: '2026-08-27T00:00:00.200Z',
      runnerLifecycleAcceptedAt: '2026-08-27T00:00:00.300Z',
    },
    manifest: {
      sessionId: 'session_storage_1',
      requestId: 'turn_storage_1',
      tool: 'codex',
      prompt: 'resume me',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  const manifest = await getRunManifest(run.id);
  const channel = manifest.options.runAuthRecoveryChannel;
  assert.equal(channel?.token, undefined, 'Run manifest must not contain the bearer capability');
  assert.ok(channel?.tokenHash);
  assert.equal(channel?.tokenFile, 'auth-recovery.cap');
  assert.equal(channel.runId, run.id);
  assert.equal(channel.sessionId, run.sessionId);
  assert.equal(channel.turnId, run.requestId);
  assert.equal(manifest.id, run.id);
  const capabilityToken = await readRunAuthRecoveryToken(run.id);
  assert.ok(capabilityToken);
  const tokenStats = await stat(runAuthRecoveryCapabilityPath(run.id));
  assert.equal(tokenStats.isFile(), true);
  if (process.platform !== 'win32') assert.equal(tokenStats.mode & 0o777, 0o600);
  // Windows stat mode bits do not attest ACLs; ACL validation is a separate gate.

  await writeRunResult(run.id, { exitCode: 1, error: 'old result' });
  assert.equal((await getRunResult(run.id)).error, 'old result');

  const reopened = await updateRun(run.id, (current) => ({
    ...current,
    state: 'accepted',
    authRecovery: {
      authCredentialVersion: 8,
      authRetryCount: 1,
      authRetryState: 'auth_retrying',
      resumeAttempt: 1,
      resumeId: 'thread_storage_1',
    },
    __clearTerminalData: true,
    __clearRunnerBinding: true,
  }));
  assert.equal(reopened.state, 'accepted');
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.finalizedAt, null);
  assert.equal(reopened.result, null);
  assert.equal(reopened.failureReason, null);
  assert.equal(reopened.runnerProcessId, null);
  assert.equal(reopened.runnerUnitName, null);
  assert.equal(reopened.runnerLaunchQueuedAt, null);
  assert.equal(reopened.runnerLifecycleSubmittedAt, null);
  assert.equal(reopened.runnerLifecycleAcceptedAt, null);
  assert.equal(reopened.authRecovery.authRetryState, 'auth_retrying');
  assert.equal(reopened.authRecovery.resumeId, 'thread_storage_1');

  await clearRunResult(run.id);
  assert.equal(await getRunResult(run.id), null, 'recovery must clear the stale result before relaunch');
  assert.equal((await getRun(run.id)).state, 'accepted');

  const finalized = await createRun({
    status: {
      sessionId: 'session_storage_2',
      requestId: 'turn_storage_2',
      state: 'failed',
      finalizedAt: '2026-08-27T00:00:02.000Z',
      completedAt: '2026-08-27T00:00:02.000Z',
    },
    manifest: { sessionId: 'session_storage_2', requestId: 'turn_storage_2', tool: 'codex' },
  });
  const finalizedUpdate = await updateRun(finalized.id, (current) => ({
    ...current,
    state: 'accepted',
    authRecovery: { authRetryState: 'auth_retrying', authRetryCount: 1, resumeAttempt: 1 },
    __clearTerminalData: true,
  }));
  assert.equal(finalizedUpdate.state, 'failed', 'finalized Run must not be reopened');
  assert.equal(finalizedUpdate.finalizedAt, '2026-08-27T00:00:02.000Z');
  assert.equal(finalizedUpdate.completedAt, '2026-08-27T00:00:02.000Z');
  assert.equal(finalizedUpdate.authRecovery.authRetryState, 'auth_retrying');

  const successful = await createRun({
    status: {
      sessionId: 'session_storage_success',
      requestId: 'turn_storage_success',
      state: 'completed',
      completedAt: '2026-08-27T00:00:03.000Z',
      result: { exitCode: 0, cancelled: false, providerTerminalSeen: true },
      failureReason: 'stale launch failure',
      replyPublication: {
        responseIds: ['turn_storage_success'],
        state: 'failed',
        failedAt: '2026-08-27T00:00:04.000Z',
        lastError: 'stale launch failure',
      },
    },
    manifest: { sessionId: 'session_storage_success', requestId: 'turn_storage_success', tool: 'codex' },
  });
  const protectedSuccess = await updateRun(successful.id, (current) => ({
    ...current,
    state: 'failed',
    failureReason: 'late duplicate launch failure',
  }));
  assert.equal(protectedSuccess.state, 'completed', 'a late launch failure cannot replace provider success');
  assert.equal(protectedSuccess.failureReason, null);
  assert.equal(protectedSuccess.replyPublication.state, 'ready');
  assert.equal(protectedSuccess.replyPublication.failedAt, null);
  assert.equal(protectedSuccess.replyPublication.lastError, null);

  const deliberateFailure = await updateRun(successful.id, (current) => ({
    ...current,
    state: 'failed',
    failureReason: 'validated structured terminal failure',
    __overrideSuccessfulTerminal: true,
  }));
  assert.equal(deliberateFailure.state, 'failed', 'validated terminal projection may override a provisional success');
  assert.equal(deliberateFailure.failureReason, 'validated structured terminal failure');

  const statusText = await readFile(runStatusPath(run.id), 'utf8');
  const manifestText = await readFile(runManifestPath(run.id), 'utf8');
  assert.match(statusText, /auth_retrying/);
  assert.match(manifestText, /runAuthRecoveryChannel/);
  assert.doesNotMatch(manifestText, new RegExp(capabilityToken));

  console.log('test-run-auth-recovery-storage: reopen CAS, terminal precedence, result cleanup, and finalized guard OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
