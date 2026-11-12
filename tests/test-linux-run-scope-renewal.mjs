import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxRunScopeRenewalSweep, issueLinuxRunScopeRenewal } from '../chat/linux-run-scope-renewal.mjs';

test('renewal issuance requires an existing binding and the current live generation', async () => {
  const run = { id: 'run_12345678', runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 2, state: 'running' };
  const manifest = {};
  let matching = true;
  const issueGrant = async (id, attempt, options) => {
    await options.readBoundary(id);
    await options.persistBinding();
    return { id, attempt };
  };
  const options = { readBoundary: async () => ({ run, manifest }), matchesBinding: async () => matching, issueGrant };
  assert.deepEqual(await issueLinuxRunScopeRenewal(run.id, 2, options), { id: run.id, attempt: 2 });
  matching = false;
  await assert.rejects(issueLinuxRunScopeRenewal(run.id, 2, options));
  matching = true;
  await assert.rejects(issueLinuxRunScopeRenewal(run.id, 1, options));
  run.cancelRequested = true;
  await assert.rejects(issueLinuxRunScopeRenewal(run.id, 2, options));
});

test('renewal sweep retries failures, skips terminal Runs and recovers after restart', async () => {
  let clock = 1_000_000, failure = true, requests = 0;
  const active = { id: 'run_12345678', state: 'running', runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 2 };
  const finished = { id: 'run_87654321', state: 'completed', runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 0 };
  const entries = [active, finished];
  const options = { listEntries: async () => entries, readBoundary: async (id) => ({ run: entries.find((item) => item.id === id) }),
    issueRenewal: async (id, attempt) => ({ id, attempt }), now: () => clock,
    renew: async () => { requests++; return { state: failure ? 'unavailable' : 'renewed' }; } };
  const sweep = createLinuxRunScopeRenewalSweep(options);
  assert.deepEqual(await sweep({ scanAll: true }), { attempted: 1, renewed: 0 });
  failure = false;
  assert.deepEqual(await sweep(), { attempted: 1, renewed: 1 });
  assert.deepEqual(await sweep(), { attempted: 0, renewed: 0 });
  clock += 5 * 60 * 1000;
  assert.deepEqual(await sweep(), { attempted: 1, renewed: 1 });
  assert.deepEqual(await createLinuxRunScopeRenewalSweep(options)({ scanAll: true }), { attempted: 1, renewed: 1 });
  active.cancelRequested = true;
  assert.deepEqual(await sweep({ scanAll: true }), { attempted: 0, renewed: 0 });
  assert.equal(requests, 4);
});
