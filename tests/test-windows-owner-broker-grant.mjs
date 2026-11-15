import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { createWindowsOwnerBrokerGrant, submitOrResumeWindowsOwnerBrokerInstall } from '../chat/windows-owner-broker-install.mjs';
import { tryWindowsManagedAutoInstall } from '../chat/windows-managed-auto-install.mjs';

const binding = { sessionId: 'session', runId: 'run', turnId: 'turn', requestKey: 'gate:test' };
const trustedContext = { cwd: 'D:\\work', projectRoot: 'D:\\work', platform: 'win32' };
const facts = { name: 'fixture', async packageFacts(query) { return { manager: 'winget', source: 'winget', sourceTrust: 'configured',
  repositories: [{ id: 'winget', trust: 'configured' }], packages: query.packages.map((name) => ({ name, requestedVersion: '', availableVersion: '1.2.3' })) }; } };
async function prepare(command) {
  const operation = compileSemanticOperations({ request: { ...binding, executionClass: 'host', rawCommand: command }, trustedContext }).operations[0];
  const resolution = await resolveSemanticContext({ operation, options: { trustedContext, windowsFactsProvider: facts } });
  return { binding, projection: { decisions: [evaluateSemanticOperation(operation, resolution)] } };
}
const kid = 'inst_0123456789abcdef0123456789abcdef';
const identity = { instanceId: kid, ownerSid: 'S-1-5-21-1-2-3-1001' };
const health = { type: 'health', autoInstallReady: true, autoInstallKeyId: kid, installationId: 'broker', policyGeneration: 1 };
const keys = generateKeyPairSync('ed25519');
for (const riskMode of ['recommended', 'full-auto']) {
  const prepared = await prepare('winget install Vendor.App --scope user');
  const { grant, signature } = createWindowsOwnerBrokerGrant({ prepared, riskMode, kid, privateKey: keys.privateKey, health, identity });
  const bytes = Buffer.concat([Buffer.from('Ragent Windows owner auto install v1\0'), Buffer.from(JSON.stringify(grant))]);
  assert.equal(verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(grant.ownerSid, identity.ownerSid);
  assert.equal(grant.installScope, 'user');
}
const unspecified = await prepare('winget install Vendor.App');
assert.equal(createWindowsOwnerBrokerGrant({ prepared: unspecified, riskMode: 'recommended', kid, privateKey: keys.privateKey, health, identity }).grant.installScope, 'default');
const prepared = await prepare('winget install Vendor.App --scope user');
let stored, sends = 0, activeChecks = 0;
const client = { health: async () => health, ownerInstallIdentity: async () => identity,
  status: async (requestId) => stored || { type: 'result', requestId, code: 'REQUEST_NOT_FOUND' },
  executeOwnerInstall: async ({ grant }) => { sends++; stored = { type: 'result', requestId: grant.requestId, status: 'succeeded', ownerInstall: grant }; return stored; } };
const options = { client, prepared, riskMode: 'recommended', kid, privateKey: keys.privateKey, assertActive: async () => { activeChecks++; } };
assert.equal((await submitOrResumeWindowsOwnerBrokerInstall(options)).status, 'succeeded');
assert.equal((await submitOrResumeWindowsOwnerBrokerInstall(options)).duplicate, true);
assert.equal(sends, 1);
assert.equal(activeChecks, 1);
stored.ownerInstall = { ...stored.ownerInstall, packageId: 'Other.App' };
await assert.rejects(submitOrResumeWindowsOwnerBrokerInstall(options), { code: 'AUTO_INSTALL_BINDING_CONFLICT' });
for (const riskMode of ['recommended', 'full-auto']) {
  stored = null; sends = 0;
  const managed = { actions: [{ command: 'winget install Vendor.App --scope user' }], binding: { ...binding, authenticatedPrincipalKind: 'owner' },
    riskMode, trustedContext, runExecutionIsService: true, platform: 'win32' };
  const deps = { prepare: async () => prepared, client, getKey: async () => ({ kid, privateKey: keys.privateKey }), assertActive: async () => {} };
  assert.equal((await tryWindowsManagedAutoInstall({ ...managed, preflight: true }, deps)).ready, true);
  assert.equal((await tryWindowsManagedAutoInstall(managed, deps)).status, 'succeeded');
  assert.equal(sends, 1);
  stored = null; sends = 0;
  const defaultDeps = { ...deps, prepare: async () => unspecified };
  const defaultManaged = { ...managed, actions: [{ command: 'winget install Vendor.App' }] };
  assert.equal((await tryWindowsManagedAutoInstall(defaultManaged, defaultDeps)).status, 'succeeded');
  assert.equal(stored.ownerInstall.installScope, 'default');
  assert.equal(sends, 1);
}
console.log('windows-owner-broker-grant: signed binding and scope checks passed');
if (process.env.RAGENT_QA_OWNER_GRANT_INTEROP === '1') {
  const signed = createWindowsOwnerBrokerGrant({ prepared, riskMode: 'recommended', kid, privateKey: keys.privateKey, health, identity });
  process.stdout.write(`OWNER_GRANT_FIXTURE=${JSON.stringify({ ...signed, publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })}\n`);
}
