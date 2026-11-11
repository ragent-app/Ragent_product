#!/usr/bin/env node
import assert from 'node:assert/strict';

import { generateKeyPairSync } from 'node:crypto';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { computeSemanticManifestHash } from '../chat/semantic-operation.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import {
  SEMANTIC_ADAPTER_APT_INSTALL_V1,
  SEMANTIC_CAPABILITY_ERROR,
  SEMANTIC_CAPABILITY_TTL_MAX_MS,
  computeSemanticOperationSetHash,
  computeSemanticSelectionManifestHash,
  createSemanticCapability,
  revalidateSemanticCapability,
  signSemanticCapability,
  validateSemanticCapability,
  verifySemanticCapability,
} from '../chat/semantic-capability.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}
function throwsCode(label, fn, code) {
  assert.throws(fn, (error) => error?.code === code, `failed: ${label}`);
  passed += 1;
}

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');

function packageDecision(name = 'nginx', snapshotIdentity = 'pkg-snapshot-1') {
  const compiled = compileSemanticOperations({
    request: { rawCommand: `apt-get install ${name}`, sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: `req-${name}`, executionClass: 'host' },
    trustedContext: { cwd: '/project', projectRoot: '/project', home: '/home/owner', platform: 'linux' },
  });
  const resolution = {
    scope: { computed: true, kind: 'system', containment: 'inside' },
    impact: { estimatedItems: 1, containsTrackedFiles: false, containsModifiedFiles: false, containsSensitiveMaterial: false, containsGitMetadata: false, reversible: false },
    unknowns: [],
    resourceSnapshot: {
      resolverVersion: 'semantic-resolver/v1', identity: snapshotIdentity,
      manager: 'apt-get', source: 'trusted_repository',
      repositories: [{ id: 'debian-bookworm-main', trust: 'configured' }],
      packages: [{ name, requestedVersion: '', availableVersion: '1.0' }],
    },
  };
  const decision = evaluateSemanticOperation(compiled.operations[0], resolution);
  assert.equal(decision.decision, 'ASK');
  return decision;
}

const nginx = packageDecision();
const curl = packageDecision('curl', 'pkg-snapshot-2');
const input = {
  selectedDecisions: [nginx, curl],
  adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
  sessionId: 's1', runId: 'r1', turnId: 't1', credentialId: 'credential-pseudonym', kid: 'key_1', now: NOW,
};

const unsigned = createSemanticCapability(input);
check('capability uses random one-shot nonce', unsigned.nonce.length > 20);
eq('capability pins apt adapter', unsigned.adapter, SEMANTIC_ADAPTER_APT_INSTALL_V1);
eq('capability pins operation count', unsigned.operations.length, 2);
check('capability signs adapter input', unsigned.operations.every((entry) => entry.adapterInput.manager === 'apt-get'));
check('capability limits adapter input to package names', unsigned.operations.some((entry) => entry.adapterInput.packages.includes('nginx')));
eq('operation set hash is reproducible', unsigned.operationSetHash, computeSemanticOperationSetHash(unsigned.operations));
eq('selection manifest is reproducible', unsigned.selectionManifestHash, computeSemanticSelectionManifestHash(unsigned.operations));
eq('unsigned capability validates at issue time', validateSemanticCapability(unsigned, { now: NOW }).ok, true);
check('capability expiry is bounded', Date.parse(unsigned.expiresAt) - Date.parse(unsigned.issuedAt) <= SEMANTIC_CAPABILITY_TTL_MAX_MS);

const signed = signSemanticCapability(unsigned, keys.privateKey);
eq('signature verifies', verifySemanticCapability(signed, { publicKey: keys.publicKey, now: NOW }).ok, true);
check('signature is present', signed.sig.length > 20);

for (const [label, patch] of [
  ['session binding', { sessionId: 's2' }],
  ['run binding', { runId: 'r2' }],
  ['turn binding', { turnId: 't2' }],
  ['adapter', { adapter: 'shell/v1' }],
  ['policy version', { policyVersion: 'semantic-policy/v0' }],
  ['operation manifest', { operations: [{ ...signed.operations[0], operationManifestHash: '0'.repeat(64) }, signed.operations[1]] }],
  ['resource snapshot', { operations: [{ ...signed.operations[0], resourceSnapshotIdentity: 'changed' }, signed.operations[1]] }],
  ['adapter input', { operations: [{ ...signed.operations[0], adapterInput: { manager: 'apt-get', packages: ['--option=bad'] } }, signed.operations[1]] }],
  ['nonce', { nonce: 'replayed-nonce' }],
  ['selection hash', { selectionManifestHash: '0'.repeat(64) }],
]) {
  eq(`${label} mutation invalidates signed capability`, verifySemanticCapability({ ...signed, ...patch }, { publicKey: keys.publicKey, now: NOW }).ok, false);
}

eq('expired capability rejects', verifySemanticCapability(signed, { publicKey: keys.publicKey, now: Date.parse(signed.expiresAt) }).code, SEMANTIC_CAPABILITY_ERROR.EXPIRED);

// --- owner-click authorization mode (passkey policy off) ---
{
  const clickUnsigned = createSemanticCapability({ ...input, authMode: 'owner-click' });
  eq('owner-click capability records no credential', clickUnsigned.credentialId, '');
  eq('owner-click capability validates', validateSemanticCapability(clickUnsigned, { now: NOW }).ok, true);
  const clickSigned = signSemanticCapability(clickUnsigned, keys.privateKey);
  eq('owner-click signature verifies', verifySemanticCapability(clickSigned, { publicKey: keys.publicKey, now: NOW }).ok, true);
  // A capability must never claim a passkey credential it does not have.
  eq('owner-click with credential rejects', verifySemanticCapability({ ...clickSigned, credentialId: 'credential-pseudonym' }, { publicKey: keys.publicKey, now: NOW }).ok, false);
  // Passkey-mode capabilities still require their credential.
  eq('owner-selection without credential rejects', verifySemanticCapability({ ...signed, credentialId: '' }, { publicKey: keys.publicKey, now: NOW }).ok, false);
  eq('unknown auth mode rejects', verifySemanticCapability({ ...signed, authMode: 'sudo-vibes' }, { publicKey: keys.publicKey, now: NOW }).ok, false);
}

eq('expired capability rejects', verifySemanticCapability(signed, { publicKey: keys.publicKey, now: Date.parse(signed.expiresAt) }).code, SEMANTIC_CAPABILITY_ERROR.EXPIRED);
eq('missing signature rejects', verifySemanticCapability({ ...unsigned }, { publicKey: keys.publicKey, now: NOW }).code, SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID);
throwsCode('capability rejects TTL over maximum', () => createSemanticCapability({ ...input, ttlMs: SEMANTIC_CAPABILITY_TTL_MAX_MS + 1 }), SEMANTIC_CAPABILITY_ERROR.INVALID);
throwsCode('capability rejects non-ASK policy result', () => createSemanticCapability({ ...input, selectedDecisions: [{ ...nginx, decision: 'ALLOW' }] }), SEMANTIC_CAPABILITY_ERROR.POLICY_DENIED);
throwsCode('capability rejects unknown facts', () => createSemanticCapability({ ...input, selectedDecisions: [{ ...nginx, unknowns: ['tree:too-large'] }] }), SEMANTIC_CAPABILITY_ERROR.POLICY_DENIED);
throwsCode('capability rejects unsupported adapter', () => createSemanticCapability({ ...input, adapter: 'shell/v1' }), SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED);
{
  const sessionOperation = { ...nginx.operation, executionClass: 'session' };
  throwsCode('apt adapter rejects session execution class', () => createSemanticCapability({
    ...input,
    selectedDecisions: [{ ...nginx, operation: sessionOperation, operationManifestHash: computeSemanticManifestHash(sessionOperation) }],
  }), SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED);
}
{
  const elevatedOperation = { ...nginx.operation, effects: ['privilege.elevate', 'process.execute'] };
  throwsCode('apt adapter rejects privilege elevation effect', () => createSemanticCapability({
    ...input,
    selectedDecisions: [{ ...nginx, operation: elevatedOperation, operationManifestHash: computeSemanticManifestHash(elevatedOperation) }],
  }), SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED);
}
{
  const unboundOperation = {
    ...nginx.operation,
    requestBinding: { ...nginx.operation.requestBinding, runId: 'unknown' },
  };
  throwsCode('capability rejects unknown run binding', () => createSemanticCapability({
    ...input,
    selectedDecisions: [{ ...nginx, operation: unboundOperation, operationManifestHash: computeSemanticManifestHash(unboundOperation) }],
  }), SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED);
}
{
  const mismatchedOperation = {
    ...nginx.operation,
    requestBinding: { ...nginx.operation.requestBinding, runId: 'r-other' },
  };
  throwsCode('capability rejects operation envelope binding mismatch', () => createSemanticCapability({
    ...input,
    selectedDecisions: [{ ...nginx, operation: mismatchedOperation, operationManifestHash: computeSemanticManifestHash(mismatchedOperation) }],
  }), SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED);
}
{
  const nonLinux = {
    ...unsigned,
    operations: unsigned.operations.map((entry) => ({ ...entry, platform: 'win32' })),
  };
  nonLinux.operationSetHash = computeSemanticOperationSetHash(nonLinux.operations);
  nonLinux.selectionManifestHash = computeSemanticSelectionManifestHash(nonLinux.operations);
  eq('non-Linux operation set cannot use apt adapter', validateSemanticCapability(nonLinux, { now: NOW }).code, SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED);
}
{
  const optionOperation = {
    ...nginx.operation,
    target: { ...nginx.operation.target, packages: ['--option=bad'] },
  };
  throwsCode('capability rejects package target mutation before adapter selection', () => createSemanticCapability({ ...input, selectedDecisions: [{
    ...nginx,
    operation: optionOperation,
    operationManifestHash: computeSemanticManifestHash(optionOperation),
  }] }), SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED);
}

eq('identical fresh decisions revalidate', revalidateSemanticCapability(signed, [curl, nginx]).ok, true);
eq('changed resolver snapshot rejects revalidation', revalidateSemanticCapability(signed, [packageDecision('nginx', 'pkg-snapshot-changed'), curl]).code, SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED);
eq('subset rejects revalidation', revalidateSemanticCapability(signed, [nginx]).code, SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED);

console.log(`semantic-capability: ${passed} checks passed`);
