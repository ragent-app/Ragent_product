#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildPermissionFacts,
  CAPABILITY_WORKLOAD_SCOPES,
  computeCapabilityConstraintHash,
  createCapabilityGrant,
  evaluatePermissionOperation,
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
} from '../chat/permission-policy.mjs';
import {
  computeSemanticManifestHash,
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
} from '../chat/semantic-operation.mjs';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
let passed = 0;
function eq(label, actual, expected) {
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  passed += 1;
}

function operation(overrides = {}) {
  const base = {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_adversarial_001',
    requestBinding: { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', requestKey: 'request-a' },
    primaryAction: 'fs.delete',
    effects: [],
    executionClass: 'host',
    target: { kind: 'filesystem_tree', platform: 'linux', path: '/project/cache', recursive: false, force: false, exact: true },
    scope: {
      kind: 'project',
      computed: true,
      selfProtection: { computed: true, matched: false, workspaceRecommended: true, boundary: 'none' },
    },
    impact: { estimatedItems: 1, reversible: true, containsSensitiveMaterial: false, containsGitMetadata: false },
    source: { rawRequestHash: `sha256:${'a'.repeat(64)}`, commandForm: 'argv' },
    analysis: {
      confidence: 'high',
      unknowns: [],
      policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      effectsComplete: true,
    },
  };
  return { ...base, ...overrides };
}

function factsFor(op, overrides = {}) {
  return buildPermissionFacts({
    operation: op,
    executionClass: op.executionClass,
    impact: {
      reversible: op.impact.reversible,
      containsSensitiveMaterial: op.impact.containsSensitiveMaterial,
      containsGitMetadata: op.impact.containsGitMetadata,
    },
    resource: { path: op.target.path || '/project/cache', recursive: op.target.recursive === true, force: op.target.force === true, exact: op.target.exact === true },
    selection: { paths: [op.target.path || '/project/cache'], recursive: op.target.recursive === true, force: op.target.force === true, exact: op.target.exact === true },
    resourceSnapshotIdentity: 'snapshot-a',
    effectEnumerationProof: 'effects-proof',
    attestation: 'facts-proof',
    ...overrides,
  });
}

function grantFor(op, facts, overrides = {}) {
  return createCapabilityGrant({
    mode: PERMISSION_MODES.FULL_AUTONOMY,
    issuedAtTurn: 'turn-a',
    issuedAt: new Date(NOW),
    ttlMs: 60 * 60 * 1000,
    usageMax: 5,
    workload: {
      scope: CAPABILITY_WORKLOAD_SCOPES.RUN,
      sessionId: op.requestBinding.sessionId,
      runId: op.requestBinding.runId,
      turnBinding: 'provenance',
    },
    constraints: {
      action: op.primaryAction,
      scope: facts.scope,
      resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
      executionClass: facts.executionClass,
      impact: facts.impact,
      target: op.target,
      targetFlags: { recursive: op.target.recursive === true, force: op.target.force === true, exact: op.target.exact === true },
      resource: facts.resource,
      selection: facts.selection,
      effects: { subset: op.effects },
    },
    grantProof: 'grant-proof',
    ...overrides,
  });
}

const verifyFactsProof = (op, facts) => facts.attestation === 'facts-proof'
  && facts.operationManifestHash === computeSemanticManifestHash(op);
const verifyGrantProof = (grant) => grant.grantProof === 'grant-proof'
  && grant.constraintManifestHash === computeCapabilityConstraintHash(grant);
function evaluate(op, facts, capability, useNonce) {
  return evaluatePermissionOperation({
    operation: op,
    facts,
    mode: PERMISSION_MODES.FULL_AUTONOMY,
    capability,
    now: NOW,
    useNonce,
    verifyFactsProof,
    verifyGrantProof,
  });
}

const narrow = operation();
const narrowFacts = factsFor(narrow);
const narrowGrant = grantFor(narrow, narrowFacts);
const broadened = operation({
  executionClass: 'privileged',
  target: { ...narrow.target, recursive: true, force: true },
  impact: { ...narrow.impact, estimatedItems: 100, reversible: false, containsSensitiveMaterial: true },
});
const broadenedFacts = factsFor(broadened);
eq('finding 1: execution, impact, recursive, and force expansion cannot ALLOW',
  evaluate(broadened, broadenedFacts, narrowGrant, 'use-f1').decision, 'ASK');

const elevated = operation({ primaryAction: 'privilege.elevate', target: { kind: 'process', platform: 'linux', executable: 'sudo', exact: true } });
const elevatedFacts = factsFor(elevated, { resource: { executable: 'sudo', exact: true }, selection: { argv: ['sudo', 'id'], exact: true } });
eq('finding 2: owner capability cannot elevate privilege',
  evaluate(elevated, elevatedFacts, grantFor(elevated, elevatedFacts), 'use-f2').reasonCode,
  PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);

const auditModify = operation({ primaryAction: 'security.audit.config.modify', target: { kind: 'process', platform: 'linux', auditEnabled: false, exact: true } });
const auditFacts = factsFor(auditModify, { resource: { auditEnabled: false, retention: 0, exact: true }, selection: { auditEnabled: false, retention: 0, exact: true } });
eq('finding 3: owner capability cannot weaken audit configuration',
  evaluate(auditModify, auditFacts, grantFor(auditModify, auditFacts), 'use-f3').reasonCode,
  PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);

const lowConfidence = operation({ analysis: { ...narrow.analysis, confidence: 'low' } });
const lowFacts = factsFor(lowConfidence);
eq('finding 4: low confidence cannot ALLOW with an exact capability',
  evaluate(lowConfidence, lowFacts, grantFor(lowConfidence, lowFacts), 'use-f4').decision, 'DENY');

const unknownAnalysis = operation({ analysis: { ...narrow.analysis, unknowns: ['host:unclassified-effect'] } });
const unknownFacts = factsFor(unknownAnalysis, { unknowns: [] });
const unknownAnalysisResult = evaluate(unknownAnalysis, unknownFacts, grantFor(unknownAnalysis, unknownFacts), 'use-f5');
eq('finding 5: operation analysis unknowns fail closed when facts unknowns are empty',
  unknownAnalysisResult.decision, 'DENY');
eq('finding 5: both unknown channels use the unknown-host reason',
  unknownAnalysisResult.reasonCode, PERMISSION_REASON_CODES.UNKNOWN_HOST_EFFECT);

const protectedOperation = operation({
  scope: {
    ...narrow.scope,
    selfProtection: { computed: true, matched: true, workspaceRecommended: false, boundary: 'ragent-service' },
  },
});
const protectedFacts = factsFor(protectedOperation);
eq('self-protection remains an immutable ceiling with an exact capability',
  evaluate(protectedOperation, protectedFacts, grantFor(protectedOperation, protectedFacts), 'use-self-protection').reasonCode,
  PERMISSION_REASON_CODES.SELF_PROTECTION_BOUNDARY);

console.log(`permission-policy-phase2a-adversarial: ${passed} checks passed`);
