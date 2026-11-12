import assert from 'node:assert/strict';
import { codexBrokerPolicyDigest } from '../chat/codex-app-server-broker.mjs';
import { constrainCodexBrokerRequest } from '../lib/workbench-execution-policy.mjs';

const policy = { schemaVersion: 1, agentType: 'codex', authType: 'oauth', model: 'example', allowProviderSetup: false };
assert.equal(codexBrokerPolicyDigest(null), '');
assert.equal(codexBrokerPolicyDigest(policy), codexBrokerPolicyDigest({ model: 'example', authType: 'oauth', agentType: 'codex', schemaVersion: 1, allowProviderSetup: false }));
assert.notEqual(codexBrokerPolicyDigest(policy), codexBrokerPolicyDigest({ ...policy, model: 'different' }));
const safe = { method: 'thread/start', params: { cwd: '/workspace', model: 'example', config: {
  allow_login_shell: false, projects: { '/workspace': { trust_level: 'untrusted' } },
} } };
assert.equal(constrainCodexBrokerRequest(safe, policy).params.sandbox, 'read-only');
assert.throws(() => constrainCodexBrokerRequest({ ...safe, params: { ...safe.params, config: { allow_login_shell: true } } }, policy));
assert.throws(() => constrainCodexBrokerRequest({ ...safe, params: { ...safe.params, config: { projects: { '/other': { trust_level: 'trusted' } } } } }, policy));
console.log('test-codex-workbench-broker-policy: policy binding and trust bounds passed');
