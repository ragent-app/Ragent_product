#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static/chat/session-state-model.js'), 'utf8');
const labels = {
  'taskFlow.authRetrying': 'Reconnecting the account…',
  'taskFlow.authRecovered': 'Account reconnected',
  'taskFlow.authRetryExhausted': 'Account could not be reconnected',
  'taskFlow.reauthRequired': 'Sign-in required',
};
const context = {
  ragentT(key) { return labels[key] || key; },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'static/chat/session-state-model.js' });

const model = context.RagentSessionStateModel;
const session = {
  id: 'session-a',
  activity: {
    run: {
      state: 'running',
      runId: 'run-a',
      authRecovery: {
        state: 'auth_retrying',
        retryCount: 1,
        retryLimit: 2,
      },
    },
  },
};

const activity = model.normalizeSessionActivity(session);
assert.equal(activity.run.authRecovery.state, 'auth_retrying');
assert.equal(activity.run.authRecovery.retryCount, 1);
assert.equal(model.getSessionTaskFlowStage(session).key, 'auth_retrying');
assert.equal(model.getSessionTaskFlowStage(session).label, 'Reconnecting the account…');

for (const state of ['auth_recovered', 'auth_retry_exhausted', 'reauth_required']) {
  const next = { ...session, activity: { run: { ...session.activity.run, authRecovery: { state } } } };
  assert.equal(model.getSessionTaskFlowStage(next).key, state);
  assert.equal(model.getSessionStatusSummary(next).primary.key, state);
}

const unknown = { ...session, activity: { run: { state: 'running', authRecovery: { state: 'secret-state' } } } };
assert.equal(model.normalizeSessionActivity(unknown).run.authRecovery, null);
assert.equal(model.getSessionTaskFlowStage(unknown).key, 'running');

console.log('test-session-auth-recovery-status: retry, recovered, exhausted, and reauth states OK');
