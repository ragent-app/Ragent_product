#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-session-auth-activity-'));
process.env.HOME = root;
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

try {
  const { createRun } = await import('../chat/runs.mjs');
  const {
    buildSessionActivity,
    resolveSessionRunActivity,
  } = await import('../chat/session-activity.mjs');

  const run = await createRun({
    status: {
      sessionId: 'session-terminal-auth',
      requestId: 'turn-terminal-auth',
      state: 'failed',
      finalizedAt: '2026-08-27T00:00:00.000Z',
      authRecovery: {
        authRetryState: 'reauth_required',
        authRetryCount: 2,
        authRetryLimit: 2,
        credentialInstanceId: 'must-not-be-exposed',
        resumeId: 'must-not-be-exposed',
      },
    },
    manifest: {
      sessionId: 'session-terminal-auth',
      requestId: 'turn-terminal-auth',
      tool: 'codex',
    },
  });

  const resolved = await resolveSessionRunActivity({ activeRunId: run.id });
  assert.equal(resolved.state, 'idle');
  assert.equal(resolved.run, null);
  assert.deepEqual(resolved.authRecovery, {
    state: 'reauth_required',
    retryCount: 2,
    retryLimit: 2,
  });

  const terminalActivity = buildSessionActivity(
    { activeRunId: run.id },
    {},
    { ...resolved, queuedCount: 0 },
  );
  assert.equal(terminalActivity.run.state, 'idle');
  assert.equal(terminalActivity.run.runId, null);
  assert.deepEqual(terminalActivity.run.authRecovery, resolved.authRecovery);

  const staleProjection = buildSessionActivity(
    {
      lastAuthRecovery: {
        state: 'auth_retry_exhausted',
        retryCount: 2,
        retryLimit: 2,
        credentialInstanceId: 'must-not-be-exposed',
      },
    },
    {},
    { runState: 'idle', run: null, queuedCount: 0 },
  );
  assert.deepEqual(staleProjection.run.authRecovery, {
    state: 'auth_retry_exhausted',
    retryCount: 2,
    retryLimit: 2,
  });

  const runningProjection = buildSessionActivity(
    {},
    {},
    {
      runState: 'running',
      run: {
        id: 'run-auth-retrying',
        state: 'accepted',
        authRecovery: {
          authRetryState: 'auth_retrying',
          authRetryCount: 1,
          authRetryLimit: 2,
        },
      },
      queuedCount: 0,
    },
  );
  assert.equal(runningProjection.run.state, 'running');
  assert.equal(runningProjection.run.authRecovery.state, 'auth_retrying');

  console.log('test-session-activity-auth-recovery: terminal recovery stays idle and redacted OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
