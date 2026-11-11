#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  SEMANTIC_ADAPTER_APT_INSTALL_V1,
} from '../chat/semantic-capability.mjs';
import {
  SEMANTIC_APPROVAL_PROOF_PURPOSE,
  authorizeSemanticApproval,
  prepareSemanticApproval,
  selectSemanticApproval,
} from '../chat/semantic-approval.mjs';

let passed = 0;
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
async function rejectsCode(label, fn, code) {
  await assert.rejects(Promise.resolve().then(fn), (error) => error?.code === code, `failed: ${label}`);
  passed += 1;
}

const request = {
  rawCommand: 'apt-get install nginx curl',
  sessionId: 'session_1', runId: 'run_1', turnId: 'turn_1', requestKey: 'request_1',
  executionClass: 'host',
};
const trustedContext = { cwd: '/project', projectRoot: '/project', home: '/home/owner', platform: 'linux' };
const packageFacts = async ({ packages, manager }) => ({
  manager,
  source: 'trusted_repository',
  repositories: [{ id: 'debian-bookworm-main', trust: 'configured' }],
  packages: packages.map((name) => ({ name, requestedVersion: '', availableVersion: '1.0' })),
});
const prepared = await prepareSemanticApproval({
  request,
  trustedContext,
  // These false claims must be recorded as evidence only; policy derives the
  // actual system package scope from resolver facts.
  callerEvidence: { projectRoot: '/attacker/project', declaredScope: 'project', declaredSafe: true },
  resolverOptions: { fsProvider: { name: 'package-fixture', packageFacts } },
});

eq('compiler creates one operation per selected package', prepared.projection.decisions.length, 2);
eq('package operations are ASK', prepared.projection.decision, 'ASK');
eq('projection cannot issue capability by itself', prepared.capabilityEligible, false);
check('caller claimed project root is not computed scope', prepared.projection.decisions.every((entry) => entry.operation.scope.kind === 'system'));

const ids = prepared.projection.decisions.map((entry) => entry.operationId);
const selected = selectSemanticApproval(prepared.projection, ids.slice().reverse());
eq('selection hash is invariant to UI order', selected.selected.map((entry) => entry.operationId).sort(), ids.slice().sort());
check('selection manifest is deterministic', /^[0-9a-f]{64}$/.test(selected.selectionManifestHash));

let proofRequest = null;
const capability = await authorizeSemanticApproval({
  prepared,
  selectedOperationIds: ids,
  proofToken: 'one-shot-proof',
  credentialId: 'credential-pseudonym',
  kid: 'key_1',
  adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
  now: Date.parse('2026-08-11T00:00:00.000Z'),
  consumeOwnerProof: async (input) => {
    proofRequest = input;
    return input.token === 'one-shot-proof';
  },
});
eq('capability binds current run', capability.runId, 'run_1');
eq('owner proof uses semantic purpose', proofRequest.purpose, SEMANTIC_APPROVAL_PROOF_PURPOSE);
eq('owner proof binds exact selection manifest', proofRequest.manifestHash, selected.selectionManifestHash);
eq('owner proof binds request key', proofRequest.requestId, 'request_1');

await rejectsCode('missing owner proof denies capability', () => authorizeSemanticApproval({
  prepared, selectedOperationIds: ids, credentialId: 'credential-pseudonym', kid: 'key_1', adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
  consumeOwnerProof: async () => false,
}), 'SEMANTIC_APPROVAL_PROOF_REQUIRED');
await rejectsCode('unknown UI operation denies selection', () => selectSemanticApproval(prepared.projection, ['not-an-operation']), 'SEMANTIC_APPROVAL_SELECTION_INVALID');
await rejectsCode('ALLOW operation cannot become capability selection', () => selectSemanticApproval({
  decisions: [{ ...prepared.projection.decisions[0], decision: 'ALLOW' }],
}, [prepared.projection.decisions[0].operationId]), 'SEMANTIC_APPROVAL_SELECTION_DENIED');

const unresolved = await prepareSemanticApproval({
  request,
  trustedContext,
  resolverOptions: { fsProvider: { name: 'no-package-provider', packageFacts: async () => null } },
});
eq('metadata unavailable fails closed', unresolved.projection.decision, 'DENY');

// Platform is a server-owned fact. A missing, empty, or macOS platform must
// not inherit Linux package semantics or be overridden by a caller claim.
for (const platform of [undefined, '', 'darwin']) {
  const denied = await prepareSemanticApproval({
    request: { ...request, platform: 'linux' },
    trustedContext: { ...trustedContext, platform },
    resolverOptions: { fsProvider: { name: 'package-fixture', packageFacts } },
  });
  eq(`platform ${String(platform)} is denied`, denied.projection.decision, 'DENY');
  check(`platform ${String(platform)} has unknown effect`, denied.compiler.operations.every((op) => op.primaryAction === 'unknown.host_effect'));
  check(`platform ${String(platform)} cannot issue capability`, !denied.capabilityEligible);
}

console.log(`semantic-approval: ${passed} checks passed`);
