import assert from 'node:assert/strict';
import {
  buildHarnessPolicyDocument,
  DEFAULT_HARNESS_POLICY,
  HARNESS_POLICY_CATALOG_REVISION,
} from '../lib/harness-policy.mjs';

const policy = buildHarnessPolicyDocument();
assert.equal(policy.schemaVersion, 2);
assert.equal(policy.catalogRevision, HARNESS_POLICY_CATALOG_REVISION);
assert.equal(policy.policies.claude.minimumVersion, '2.1.247');
assert.equal(policy.policies.codex.targetVersion, '0.167.2');
assert.equal(Object.keys(policy.policies).length, Object.keys(DEFAULT_HARNESS_POLICY).length);

process.env.AGENTOC_HARNESS_POLICY_URL = 'https://policy.example.test';
const { clearHarnessPolicyCache, fetchHarnessPolicy } = await import('../lib/harness-policy-client.mjs');
const stale = await fetchHarnessPolicy({
  force: true,
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      schemaVersion: 1,
      revision: 'builtin-v1',
      policies: { codex: { minimumVersion: '0.150.1', targetVersion: '0.150.1' } },
    }),
  }),
});
assert.equal(stale.source, 'builtin-fallback');
assert.equal(stale.policies.codex.targetVersion, '0.167.2');

clearHarnessPolicyCache();
const current = await fetchHarnessPolicy({
  force: true,
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      ...policy,
      policies: { codex: { minimumVersion: '0.151.0', targetVersion: '0.164.0' } },
    }),
  }),
});
assert.equal(current.source, 'central');
assert.equal(current.policies.codex.minimumVersion, '0.151.0');
console.log('test-harness-policy: ok');
