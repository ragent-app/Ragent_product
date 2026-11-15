#!/usr/bin/env node
// Integration coverage for the session-manager recovery gates that cannot be
// exercised by the pure recovery planner alone.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-run-auth-manager-'));
process.env.HOME = root;
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_AUTH_SESSION_SECRET = 'manager-recovery-test-secret';

try {
  const { createCredentialMutationLedger } = await import('../lib/provider-runtime/credential-mutation.mjs');
  const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
  const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
  const {
    appendRunSpoolRecord,
    createRun,
    getRun,
  } = await import('../chat/runs.mjs');
  const { killAll, recoverRunAuthFailure } = await import('../chat/session-manager.mjs');

  const configDir = process.env.RAGENT_CONFIG_DIR;
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  const credentialLedger = createCredentialMutationLedger({ configDir });
  await secretStore.writeSecret('codex-manager-secret', {
    authType: 'api-key',
    apiKey: 'opaque-manager-key',
  });
  await registry.upsertAuthProfile({
    id: 'codex-manager-auth',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'Manager test credential',
    storageType: 'secret-store',
    storageRef: 'codex-manager-secret',
    accountMetadata: { accountKey: 'manager-account' },
  });
  await registry.upsertProviderProfile({
    id: 'codex-manager-provider',
    agentType: 'codex',
    protocol: 'openai-responses',
    displayName: 'Manager test provider',
    baseUrl: 'https://provider.invalid/v1',
    authProfileId: 'codex-manager-auth',
  });
  await credentialLedger.submit({
    accountKey: 'manager-account',
    credentialInstanceId: 'instance-manager',
    expectedVersion: 0,
    secretPayload: { authType: 'api-key', apiKey: 'opaque-manager-key' },
    secretRef: 'codex-manager-secret',
    sourceDeviceId: 'manager-test',
  });

  const sideEffectRun = await createRun({
    status: {
      sessionId: 'session-manager-side-effect',
      requestId: 'turn-manager-side-effect',
      state: 'failed',
      tool: 'codex',
      providerProfile: 'codex-manager-provider',
      runtimeFamily: 'codex-app-server-json',
      authRecovery: {
        authCredentialVersion: 0,
        credentialInstanceId: 'instance-manager',
        authRetryCount: 0,
        resumeAttempt: 0,
      },
    },
    manifest: {
      sessionId: 'session-manager-side-effect',
      requestId: 'turn-manager-side-effect',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      options: { providerProfile: 'codex-manager-provider' },
    },
  });
  await appendRunSpoolRecord(sideEffectRun.id, {
    ts: new Date().toISOString(),
    stream: 'stdout',
    json: { method: 'item/commandExecution/requestApproval' },
  });
  const sideEffectResult = await recoverRunAuthFailure({
    runId: sideEffectRun.id,
    sessionId: sideEffectRun.sessionId,
    turnId: sideEffectRun.requestId,
    failureClass: 'auth-expired',
    failureAttempt: 0,
  });
  assert.equal(sideEffectResult.retry, false);
  assert.equal(sideEffectResult.reason, 'unconfirmed-side-effects');
  assert.equal((await getRun(sideEffectRun.id)).authRecovery.authRetryState, 'reauth_required');

  const duplicateRun = await createRun({
    status: {
      sessionId: 'session-manager-duplicate',
      requestId: 'turn-manager-duplicate',
      state: 'accepted',
      tool: 'codex',
      authRecovery: {
        authRetryState: 'auth_retrying',
        authRetryCount: 1,
        resumeAttempt: 1,
        resumeId: 'thread-manager-duplicate',
      },
    },
    manifest: {
      sessionId: 'session-manager-duplicate',
      requestId: 'turn-manager-duplicate',
      tool: 'codex',
      options: {},
    },
  });
  const duplicateResults = await Promise.all([
    recoverRunAuthFailure({
      runId: duplicateRun.id,
      sessionId: duplicateRun.sessionId,
      turnId: duplicateRun.requestId,
      failureClass: 'auth-expired',
      failureAttempt: 0,
    }),
    recoverRunAuthFailure({
      runId: duplicateRun.id,
      sessionId: duplicateRun.sessionId,
      turnId: duplicateRun.requestId,
      failureClass: 'auth-expired',
      failureAttempt: 0,
    }),
  ]);
  assert.deepEqual(duplicateResults.map((result) => result.status), ['already-retrying', 'already-retrying']);
  assert.equal((await getRun(duplicateRun.id)).authRecovery.authRetryCount, 1);

  const processBoundRun = await createRun({
    status: {
      sessionId: 'session-manager-process-bound',
      requestId: 'turn-manager-process-bound',
      state: 'running',
      tool: 'codex',
      runnerProcessId: 12345,
    },
    manifest: {
      sessionId: 'session-manager-process-bound',
      requestId: 'turn-manager-process-bound',
      tool: 'codex',
      options: {},
    },
  });
  await assert.rejects(
    recoverRunAuthFailure({
      runId: processBoundRun.id,
      sessionId: processBoundRun.sessionId,
      turnId: processBoundRun.requestId,
      failureClass: 'auth-expired',
      failureAttempt: 0,
      requesterProcessId: 54321,
    }),
    (error) => error.code === 'RUN_AUTH_RECOVERY_CONFLICT',
    'a stale sidecar cannot schedule recovery for a replacement process',
  );

  const successfulSpoolRun = await createRun({
    status: {
      sessionId: 'session-manager-success-spool',
      requestId: 'turn-manager-success-spool',
      state: 'running',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      appServerTurnId: 'provider-turn-success',
    },
    manifest: {
      sessionId: 'session-manager-success-spool',
      requestId: 'turn-manager-success-spool',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      options: {},
    },
  });
  await appendRunSpoolRecord(successfulSpoolRun.id, {
    ts: new Date().toISOString(),
    stream: 'stdout',
    json: {
      method: 'turn/completed',
      params: { turn: { id: 'provider-turn-success', status: 'completed' } },
    },
  });
  await assert.rejects(
    recoverRunAuthFailure({
      runId: successfulSpoolRun.id,
      sessionId: successfulSpoolRun.sessionId,
      turnId: successfulSpoolRun.requestId,
      failureClass: 'auth-expired',
      failureAttempt: 0,
    }),
    (error) => error.code === 'RUN_AUTH_RECOVERY_ALREADY_SUCCEEDED',
    'a successful raw terminal must veto recovery before result.json is written',
  );

  const finalizedRun = await createRun({
    status: {
      sessionId: 'session-manager-finalized',
      requestId: 'turn-manager-finalized',
      state: 'failed',
      finalizedAt: new Date().toISOString(),
    },
    manifest: {
      sessionId: 'session-manager-finalized',
      requestId: 'turn-manager-finalized',
      tool: 'codex',
      options: {},
    },
  });
  await assert.rejects(
    recoverRunAuthFailure({
      runId: finalizedRun.id,
      sessionId: finalizedRun.sessionId,
      turnId: finalizedRun.requestId,
      failureClass: 'auth-expired',
      failureAttempt: 0,
    }),
    (error) => error.code === 'RUN_AUTH_RECOVERY_FINALIZED',
  );

  console.log('test-run-auth-recovery-manager: side-effect, duplicate, process-binding, successful-terminal, and finalized-run gates OK');
  killAll();
} finally {
  await rm(root, { recursive: true, force: true });
}
