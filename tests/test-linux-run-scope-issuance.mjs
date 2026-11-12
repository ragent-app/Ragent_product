import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRunPublication, bindRunPublication } from '../chat/run-publication-contract.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { verifyLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { issueLinuxRunScopeGrant } from '../chat/linux-run-scope-issuance.mjs';

function fixture() {
  const run = { id: 'run_12345678', sessionId: 's1', requestId: 't1', state: 'accepted', runPublication: createRunPublication() };
  const executionScope = { sessionId: 's1', cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
    riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
  const manifest = bindRunPublication(run, { executionScope, executionScopeDigest: computeExecutionScopeDigest(executionScope),
    options: { approvedActionChannel: { turnId: 't1' } } });
  const keys = generateKeyPairSync('ed25519');
  return { run, manifest, keys, options: { enabled: true, platform: 'linux', readBoundary: async () => ({ run, manifest }),
    loadKeys: async () => {}, getKey: () => keys, ensureIntentStore: async () => {}, hasIntent: async () => false } };
}
test('control plane issues a launch-specific grant from fresh bound Run data', async () => {
  const { run, manifest, keys, options } = fixture();
  const grant = await issueLinuxRunScopeGrant(run.id, 2, options);
  assert.equal(verifyLinuxRunScopeGrant(grant, { run, manifest, launchAttempt: 2, publicKey: keys.publicKey }).ok, true);
  assert.equal(verifyLinuxRunScopeGrant(grant, { run, manifest, launchAttempt: 3, publicKey: keys.publicKey }).ok, false);
  assert.equal(await issueLinuxRunScopeGrant(run.id, 2, { ...options, enabled: false }), null);
  assert.equal(await issueLinuxRunScopeGrant(run.id, 2, { ...options, platform: 'darwin' }), null);
  run.cancelRequested = true;
  await assert.rejects(issueLinuxRunScopeGrant(run.id, 2, options), { code: 'LINUX_RUN_SCOPE_INACTIVE' });
});
test('legacy and malformed Run scope cannot acquire a grant', async () => {
  const { run, manifest, options } = fixture();
  manifest.executionScope.cwd.realPath = '/etc';
  await assert.rejects(issueLinuxRunScopeGrant(run.id, 0, options), { code: 'APPROVED_ACTION_EXECUTION_SCOPE_INVALID' });
  delete manifest.executionScope;
  assert.equal(await issueLinuxRunScopeGrant(run.id, 0, options), null);
});
