import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { computeSemanticManifestHash } from '../chat/semantic-operation.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { buildSemanticCapabilitySelection, createSemanticCapability } from '../chat/semantic-capability.mjs';
import { signLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';
import { bindLinuxDeleteObservation } from '../chat/linux-delete-observation.mjs';

const now = Date.parse('2026-11-12T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519'), otherKeys = generateKeyPairSync('ed25519');
const target = '/srv/project/file';
const request = { rawCommand: `rm ${target}`, sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1', executionClass: 'host' };
const compiled = compileSemanticOperations({ request, trustedContext: { cwd: '/srv/project', projectRoot: '/srv/project', home: '/home/user', platform: 'linux' } });
assert.equal(compiled.operations.length, 1);
const resolution = {
  scope: { computed: true, kind: 'project', containment: 'inside', projectRoot: '/srv/project',
    selfProtection: { computed: true, matched: false, workspaceRecommended: true, boundary: 'none' } },
  impact: { estimatedItems: 1, containsTrackedFiles: false, containsModifiedFiles: false,
    containsSensitiveMaterial: false, containsGitMetadata: false, reversible: false },
  unknowns: [],
  resourceSnapshot: { resolverVersion: 'semantic-resolver/v1', identity: 'snapshot-1', provider: 'fixture',
    paths: [{ requested: target, canonical: target, identity: '42:100', expectedParentIdentity: '42:99',
      mountId: '42', noFollow: false, symlinkChain: [], missingPathSegments: [], parentIsDirectory: true }] },
};
const decision = evaluateSemanticOperation(compiled.operations[0], resolution);
assert.equal(decision.decision, 'ASK');
const context = { sessionId: 's1', runId: 'r1', turnId: 't1', requestId: 'q1' };
const snapshot = { version: 1, mountId: '500', parentDevice: '42', parentInode: '99', device: '42', inode: '100',
  size: '1', ctimeSeconds: '10', ctimeNanoseconds: '20', mtimeSeconds: '11', mtimeNanoseconds: '21' };
const attestation = signLinuxTargetAttestation({ privateKey: keys.privateKey, context, path: target, snapshot, now });
const input = { decision, attestation, trustedPublicKey: keys.publicKey, now };
const bound = bindLinuxDeleteObservation(input);
assert.equal(bound.decision, 'ASK');
assert.notEqual(bound.operationManifestHash, decision.operationManifestHash);
assert.deepEqual(bound.operation.target.resourceSnapshot.linuxTargetAttestation, attestation);
assert.notEqual(buildSemanticCapabilitySelection([bound]).selectionManifestHash, buildSemanticCapabilitySelection([decision]).selectionManifestHash);
assert.throws(() => createSemanticCapability({ selectedDecisions: [bound], adapter: 'linux-file-delete/v1', sessionId: 's1', runId: 'r1', turnId: 't1', kid: 'test', credentialId: 'owner', now }),
  { code: 'SEMANTIC_CAPABILITY_ADAPTER_DENIED' });
attestation.binding.inode = '101';
assert.equal(bound.operation.target.resourceSnapshot.linuxTargetAttestation.binding.inode, '100');

const fresh = () => ({ ...input, attestation: signLinuxTargetAttestation({ privateKey: keys.privateKey, context, path: target, snapshot, now }) });
const modified = (change) => {
  const value = structuredClone(decision);
  change(value);
  value.operationManifestHash = computeSemanticManifestHash(value.operation);
  return value;
};
for (const bad of [
  { ...fresh(), trustedPublicKey: otherKeys.publicKey },
  { ...fresh(), now: now + 300000 },
  { ...fresh(), decision: { ...decision, decision: 'DENY' } },
  { ...fresh(), decision: { ...decision, operationManifestHash: '0'.repeat(64) } },
  { ...fresh(), decision: modified((d) => { d.operation.scope.kind = 'system'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.scope.selfProtection.matched = true; }) },
  { ...fresh(), decision: modified((d) => { delete d.operation.scope.selfProtection; }) },
  { ...fresh(), decision: modified((d) => { d.operation.target.resourceSnapshot.paths[0].identity = '42:101'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.target.resourceSnapshot.paths[0].expectedParentIdentity = '42:98'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.target.resourceSnapshot.paths[0].mountId = '43'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.target.resourceSnapshot.paths[0].symlinkChain = [{ path: '/srv/link' }]; }) },
  { ...fresh(), decision: modified((d) => { d.operation.requestBinding.runId = 'other-run'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.target.root = '/srv/project/other'; }) },
  { ...fresh(), decision: modified((d) => { d.operation.effects.push('network.request'); }) },
  { ...fresh(), decision: modified((d) => { d.operation.analysis.unknowns.push('unmodeled-evidence'); }) },
]) assert.throws(() => bindLinuxDeleteObservation(bad), { code: 'LINUX_DELETE_OBSERVATION_INVALID' });
console.log('linux delete observation: policy and identity binding checks passed');
