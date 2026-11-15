#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-session-control-storage-'));
process.env.HOME = root;
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_AUTH_SESSION_SECRET = 'session-control-storage-secret';

try {
  const {
    createRun,
    getRunManifest,
    readRunSessionControlRenewalToken,
    readRunSessionControlToken,
    renewRunSessionControlCapability,
    runSessionControlCapabilityPath,
    runSessionControlRenewalCapabilityPath,
    runManifestPath,
  } = await import('../chat/runs.mjs');
  const {
    createRunSessionControlCapability,
    createRunSessionControlRenewalCapability,
  } = await import('../chat/session-control-capability.mjs');

  const now = Date.now();
  const runId = 'run_session_control_storage';
  const sessionId = 'session_session_control_storage';
  const turnId = 'turn_session_control_storage';
  const capability = createRunSessionControlCapability({
    runId,
    sessionId,
    turnId,
    now,
  });
  const renewal = createRunSessionControlRenewalCapability({
    runId,
    sessionId,
    turnId,
    now,
    runCreatedAt: now,
  });
  const run = await createRun({
    status: {
      id: runId,
      sessionId,
      requestId: turnId,
      state: 'running',
      createdAt: new Date(now).toISOString(),
    },
    manifest: {
      id: runId,
      sessionId,
      requestId: turnId,
      options: {
        sessionControlChannel: {
          ...capability,
          renewalVersion: renewal.version,
          renewalEndpoint: renewal.endpoint,
          renewalToken: renewal.token,
          renewalTokenHash: renewal.tokenHash,
          renewalExpiresAt: renewal.expiresAt,
        },
      },
    },
  });
  assert.equal(run.id, runId);
  const persisted = await getRunManifest(runId);
  const channel = persisted.options.sessionControlChannel;
  assert.equal(channel.token, undefined);
  assert.equal(channel.renewalToken, undefined);
  assert.equal(channel.tokenHash, capability.tokenHash);
  assert.equal(channel.renewalTokenHash, renewal.tokenHash);
  assert.equal((await readFile(runManifestPath(runId), 'utf8')).includes(capability.token), false);
  assert.equal((await readFile(runManifestPath(runId), 'utf8')).includes(renewal.token), false);
  assert.equal(await readRunSessionControlToken(runId), capability.token);
  assert.equal(await readRunSessionControlRenewalToken(runId), renewal.token);
  assert.equal((await stat(runSessionControlCapabilityPath(runId))).mode & 0o777, 0o600);
  assert.equal((await stat(runSessionControlRenewalCapabilityPath(runId))).mode & 0o777, 0o600);

  const renewed = await renewRunSessionControlCapability({ runId, sessionId, turnId, now: now + 16 * 60 * 1000 });
  assert.notEqual(renewed.capability.token, capability.token);
  assert.equal(await readRunSessionControlRenewalToken(runId), renewal.token);
  const renewedManifest = await getRunManifest(runId);
  assert.equal(renewedManifest.options.sessionControlChannel.token, undefined);
  assert.equal(renewedManifest.options.sessionControlChannel.tokenHash, renewed.capability.tokenHash);
  assert.deepEqual(
    renewedManifest.options.sessionControlChannel.tokenHashes,
    [renewed.capability.tokenHash, capability.tokenHash],
  );
  assert.equal(await readRunSessionControlToken(runId), renewed.capability.token);

  console.log('test-session-control-storage: manifest redaction, 0600 files, rotation, and restart-read OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
