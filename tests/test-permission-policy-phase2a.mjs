#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildPermissionFacts,
  CAPABILITY_AUTHORIZATION_CLASSES,
  CAPABILITY_WORKLOAD_SCOPES,
  IMMUTABLE_DENY_ACTIONS,
  STRONG_AUTH_ACTIONS,
  computeCapabilityConstraintHash,
  computePermissionFactsManifestHash,
  createCapabilityGrant,
  evaluatePermissionOperation,
  evaluatePermissionSet,
  PERMISSION_FACTS_VERSION,
  PERMISSION_KNOWN_TARGET_KINDS,
  PERMISSION_MODES,
  PERMISSION_MODE_POLICIES,
  PERMISSION_REASON_CODES,
  PERMISSION_SUPPORTED_PLATFORMS,
  consumeCapabilityUse,
  revalidateCapabilityGrant,
  validateCapabilityGrant,
  validatePermissionTargetIdentity,
  validatePermissionFacts,
  valueSatisfiesConstraint,
} from '../chat/permission-policy.mjs';
import {
  ACTION_TAXONOMY,
  computeSemanticManifestHash,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_RESOLVER_VERSION,
} from '../chat/semantic-operation.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const phase2aCorpus = readFileSync(new URL('../permission-corpus/phase2a.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid phase2a corpus JSON at line ${index + 1}: ${error.message}`);
    }
  });
check('phase2a corpus is non-empty', phase2aCorpus.length >= 9);
for (const entry of phase2aCorpus) {
  check(`phase2a corpus ${entry.id} has stable fields`, [
    entry.id, entry.raw, entry.action, entry.mode, entry.expected, entry.expectedDecision, entry.note,
  ].every((value) => typeof value === 'string' && value.length > 0));
  check(`phase2a corpus ${entry.id} never uses bare ALLOW`, entry.expected !== 'ALLOW');
  check(`phase2a corpus ${entry.id} has a valid expected decision`, ['ALLOW', 'ASK', 'DENY'].includes(entry.expectedDecision));
}

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function operation(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_phase2a_001',
    requestBinding: { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', requestKey: 'request-1' },
    primaryAction: 'package.install',
    effects: ['process.execute'],
    executionClass: 'host',
    target: { kind: 'package', platform: 'linux', manager: 'apt', source: 'trusted_repository', exact: true },
    scope: {
      kind: 'system',
      computed: true,
      selfProtection: {
        computed: true,
        matched: false,
        workspaceRecommended: false,
        boundary: 'none',
      },
    },
    impact: { estimatedItems: 1, containsSensitiveMaterial: false, containsGitMetadata: false, reversible: true },
    source: { rawRequestHash: `sha256:${'1'.repeat(64)}`, commandForm: 'argv' },
    analysis: {
      confidence: 'high', unknowns: [], policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION, resolverVersion: SEMANTIC_RESOLVER_VERSION,
      effectsComplete: true,
    },
    ...overrides,
  };
}

function factsFor(op = operation(), overrides = {}) {
  return buildPermissionFacts({
    operation: op,
    executionClass: op.executionClass,
    impact: {
      reversible: op.impact?.reversible === true,
      containsSensitiveMaterial: op.impact?.containsSensitiveMaterial === true,
      containsGitMetadata: op.impact?.containsGitMetadata === true,
    },
    resource: { manager: 'apt', source: 'trusted_repository', repository: 'main' },
    selection: { packages: ['cmake'], exact: true },
    resourceSnapshotIdentity: 'snapshot-1',
    effectEnumerationProof: 'effects-proof',
    attestation: 'resolver-proof',
    ...overrides,
  });
}

function grantFor(op = operation(), overrides = {}, providedFacts = null) {
  const facts = providedFacts || factsFor(op);
  const impact = {
    reversible: facts.impact.reversible,
    containsSensitiveMaterial: facts.impact.containsSensitiveMaterial,
    containsGitMetadata: facts.impact.containsGitMetadata,
  };
  const targetFlags = {
    recursive: false,
    force: false,
    exact: facts.selection?.exact === true,
  };
  return createCapabilityGrant({
    mode: PERMISSION_MODES.FULL_AUTONOMY,
    issuedAtTurn: 'turn-approval-1',
    issuedAt: new Date(NOW),
    ttlMs: 60 * 60 * 1000,
    usageMax: 2,
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
      impact,
      target: op.target,
      targetFlags,
      resource: facts.resource,
      selection: facts.selection,
      effects: { subset: op.effects },
    },
    grantProof: 'owner-proof',
    ...overrides,
  });
}

function grantForFacts(op, facts, overrides = {}) {
  return grantFor(op, overrides, facts);
}

function forgedCompleteFactsFor(op) {
  const forgedFacts = {
    schemaVersion: PERMISSION_FACTS_VERSION,
    serverComputed: true,
    source: 'server-resolver',
    operationManifestHash: computeSemanticManifestHash(op),
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    scope: op.scope,
    executionClass: op.executionClass,
    impact: {
      reversible: op.impact?.reversible === true,
      containsSensitiveMaterial: op.impact?.containsSensitiveMaterial === true,
      containsGitMetadata: op.impact?.containsGitMetadata === true,
    },
    effectsComplete: true,
    effectEnumerationProof: 'effects-proof',
    resource: { manager: 'apt', source: 'trusted_repository', repository: 'main' },
    selection: { packages: ['cmake'], exact: true },
    resourceSnapshotIdentity: 'snapshot-1',
    hostEffects: { dynamic: false, revalidatable: true },
    unknowns: [],
    attestation: 'resolver-proof',
  };
  forgedFacts.factsManifestHash = computePermissionFactsManifestHash(forgedFacts);
  return forgedFacts;
}

// Production supplies cryptographic verifiers. The fixture verifier models
// the trust boundary without making the policy evaluator trust an attestation
// field or a grant nonce by itself.
const verifyFactsProof = (op, facts) => facts.attestation === 'resolver-proof'
  && facts.operationManifestHash === computeSemanticManifestHash(op)
  && facts.effectEnumerationProof === 'effects-proof';
const verifyGrantProof = (grant) => grant.grantProof === 'owner-proof'
  && grant.constraintManifestHash === computeCapabilityConstraintHash(grant);
function evaluateWithProof(options) {
  return evaluatePermissionOperation({ ...options, verifyFactsProof, verifyGrantProof });
}

function evaluateCorpusCase(entry) {
  const baseEntry = { operationId: `sop_${entry.id}` };
  switch (entry.id) {
    case 'phase2a-package-run': {
      const op = operation(baseEntry);
      return evaluateWithProof({
        operation: op, facts: factsFor(op), mode: entry.mode,
        capability: grantFor(op), now: NOW, useNonce: `${entry.id}-use`,
      });
    }
    case 'phase2a-firewall-private': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: ['network.listen'], target: { kind: 'firewall_rule', platform: 'win32' } });
      const facts = factsFor(op, {
        resource: { program: 'Ragent.exe', direction: 'inbound' },
        selection: { protocol: 'tcp', port: 8080, profiles: ['private'] },
      });
      return evaluateWithProof({
        operation: op, facts, mode: entry.mode,
        capability: grantForFacts(op, facts, { constraints: {
          ...grantForFacts(op, facts).constraints,
          resource: facts.resource, selection: facts.selection, effects: { subset: ['network.listen'] },
        } }), now: NOW, useNonce: `${entry.id}-use`,
      });
    }
    case 'phase2a-firewall-public-expansion': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: ['network.listen'], target: { kind: 'firewall_rule', platform: 'win32' } });
      const narrowFacts = factsFor(op, {
        resource: { program: 'Ragent.exe', direction: 'inbound' },
        selection: { protocol: 'tcp', port: 8080, profiles: ['private'] },
      });
      const broadFacts = factsFor(op, {
        resource: narrowFacts.resource,
        selection: { protocol: 'tcp', port: 8080, profiles: ['private', 'public'] },
      });
      return evaluateWithProof({
        operation: op, facts: broadFacts, mode: entry.mode,
        capability: grantForFacts(op, narrowFacts, { constraints: {
          ...grantForFacts(op, narrowFacts).constraints,
          resource: narrowFacts.resource, selection: narrowFacts.selection, effects: { subset: ['network.listen'] },
        } }), now: NOW, useNonce: `${entry.id}-use`,
      });
    }
    case 'phase2a-defender-disable': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [] });
      return evaluateWithProof({ operation: op, facts: factsFor(op), mode: entry.mode, now: NOW });
    }
    case 'phase2a-policy-modify':
    case 'phase2a-unknown-host': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [] });
      return evaluatePermissionOperation({ operation: op, facts: factsFor(op), mode: entry.mode, now: NOW });
    }
    case 'phase2a-privilege-owner-grant': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [] });
      return evaluateWithProof({ operation: op, facts: factsFor(op), mode: entry.mode, capability: grantFor(op), now: NOW, useNonce: `${entry.id}-use` });
    }
    case 'phase2a-low-confidence': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [], analysis: { ...operation().analysis, confidence: 'low' } });
      return evaluateWithProof({ operation: op, facts: factsFor(op), mode: entry.mode, capability: grantFor(op), now: NOW, useNonce: `${entry.id}-use` });
    }
    case 'phase2a-impact-expansion': {
      const narrowOp = operation({ ...baseEntry, primaryAction: entry.action, effects: [], target: { kind: 'filesystem_tree', platform: 'linux', exact: true } });
      const narrowFacts = factsFor(narrowOp, { resource: { path: '/project/build/cache', exact: true } });
      const broadOp = operation({ ...baseEntry, primaryAction: entry.action, effects: [], executionClass: 'privileged', target: { kind: 'filesystem_tree', platform: 'linux', recursive: true, force: true, exact: true }, impact: { estimatedItems: 20, containsSensitiveMaterial: true, containsGitMetadata: false, reversible: false } });
      const broadFacts = factsFor(broadOp, { resource: { path: '/project/build/cache', recursive: true, force: true, exact: true }, impact: { reversible: false, containsSensitiveMaterial: true, containsGitMetadata: false } });
      return evaluateWithProof({ operation: broadOp, facts: broadFacts, mode: entry.mode, capability: grantForFacts(narrowOp, narrowFacts), now: NOW, useNonce: `${entry.id}-use` });
    }
    case 'phase2a-unmodeled-target': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [], target: { kind: 'future_target', platform: 'linux', root: '/project/out' } });
      return evaluatePermissionOperation({ operation: op, facts: forgedCompleteFactsFor(op), mode: entry.mode, now: NOW });
    }
    case 'phase2a-dynamic-target': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [], target: { kind: 'variable', platform: 'linux', variableName: 'TARGET' } });
      return evaluatePermissionOperation({ operation: op, facts: forgedCompleteFactsFor(op), mode: entry.mode, now: NOW });
    }
    case 'phase2a-unknown-target': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [], target: { kind: 'unknown', platform: 'linux' } });
      return evaluatePermissionOperation({ operation: op, facts: forgedCompleteFactsFor(op), mode: entry.mode, now: NOW });
    }
    case 'phase2a-unsupported-platform': {
      const op = operation({ ...baseEntry, primaryAction: entry.action, effects: [], target: { kind: 'package', platform: 'darwin', manager: 'brew' } });
      return evaluatePermissionOperation({ operation: op, facts: forgedCompleteFactsFor(op), mode: entry.mode, now: NOW });
    }
    default:
      throw new Error(`missing evaluator fixture for ${entry.id}`);
  }
}

for (const entry of phase2aCorpus) {
  const result = evaluateCorpusCase(entry);
  eq(`phase2a corpus ${entry.id} decision`, result.decision, entry.expectedDecision);
}

// Facts are server-owned and bound to the exact operation manifest.
const base = operation();
const baseFacts = factsFor(base, { attestation: 'resolver-proof' });
eq('facts schema pinned', baseFacts.schemaVersion, PERMISSION_FACTS_VERSION);
eq('facts source pinned', baseFacts.source, 'server-resolver');
eq('facts validate', validatePermissionFacts(base, baseFacts).ok, true);
eq('package target identity is modeled', validatePermissionTargetIdentity(base.target).ok, true);
check('permission target taxonomy is closed', PERMISSION_KNOWN_TARGET_KINDS.includes('package'));
check('permission target platforms are resolver-supported', PERMISSION_SUPPORTED_PLATFORMS.includes('linux')
  && PERMISSION_SUPPORTED_PLATFORMS.includes('win32'));
eq('facts manifest stable', baseFacts.factsManifestHash, computePermissionFactsManifestHash(baseFacts));
eq('caller-declared facts fail closed', validatePermissionFacts(base, { ...baseFacts, source: 'caller' }).code, PERMISSION_REASON_CODES.FACTS_NOT_SERVER_COMPUTED);
eq('manifest mutation fails', validatePermissionFacts({ ...base, target: { ...base.target, manager: 'evil' } }, baseFacts).code, PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH);
eq('dynamic host effect fails', validatePermissionFacts(base, { ...baseFacts, hostEffects: { dynamic: true, revalidatable: true } }).code, PERMISSION_REASON_CODES.DYNAMIC_HOST_EFFECT);
eq('non-boolean host effect flags fail', validatePermissionFacts(base, { ...baseFacts, hostEffects: { dynamic: 'false', revalidatable: true } }).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
eq('unknown host effect fails', validatePermissionFacts(base, { ...baseFacts, unknowns: ['host:dynamic'] }).code, PERMISSION_REASON_CODES.UNKNOWN_HOST_EFFECT);
eq('facts resource tamper fails manifest', validatePermissionFacts(base, { ...baseFacts, resource: { ...baseFacts.resource, repository: 'evil' } }).code, PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH);
eq('facts execution class is required', validatePermissionFacts(base, { ...baseFacts, executionClass: '' }).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
eq('facts impact is required', validatePermissionFacts(base, { ...baseFacts, impact: undefined }).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
eq('facts impact tamper fails manifest', validatePermissionFacts(base, { ...baseFacts, impact: { ...baseFacts.impact, reversible: false } }).code, PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH);
eq('facts execution class drift fails manifest', validatePermissionFacts(base, { ...baseFacts, executionClass: 'privileged' }).code, PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH);
eq('operation missing impact field cannot authorize', validatePermissionFacts(
  operation({ impact: { reversible: true, containsSensitiveMaterial: false } }),
  baseFacts,
).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
eq('host effect hidden field fails closed', validatePermissionFacts(base, {
  ...baseFacts,
  hostEffects: { ...baseFacts.hostEffects, securityWeakening: true },
}).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
eq('effect enumeration proof is required', validatePermissionFacts(base, {
  ...baseFacts,
  effectEnumerationProof: undefined,
}).code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
const targetExpansionOperation = operation({ target: { kind: 'filesystem_tree', platform: 'linux', recursive: true } });
check('operation target expansion must be reflected in facts', (() => {
  try {
    factsFor(targetExpansionOperation);
    return false;
  } catch (error) {
    return error.code === PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH;
  }
})());

// A forged but internally complete facts envelope cannot turn an unmodeled or
// dynamic target into an authorizable operation. This covers the reviewer
// finding where non-empty target.kind/platform values passed structure checks.
for (const [label, target, expectedCode] of [
  ['unmodeled target', { kind: 'future_target', platform: 'linux', root: '/project/out' }, PERMISSION_REASON_CODES.UNMODELED_TARGET_KIND],
  ['dynamic target', { kind: 'variable', platform: 'linux', variableName: 'TARGET' }, PERMISSION_REASON_CODES.DYNAMIC_TARGET_IDENTITY],
  ['unknown target', { kind: 'unknown', platform: 'linux' }, PERMISSION_REASON_CODES.UNKNOWN_TARGET_IDENTITY],
  ['unsupported target platform', { kind: 'package', platform: 'darwin', manager: 'brew' }, PERMISSION_REASON_CODES.UNSUPPORTED_TARGET_PLATFORM],
]) {
  const forgedOperation = operation({ target });
  const forgedFacts = {
    ...baseFacts,
    operationManifestHash: computeSemanticManifestHash(forgedOperation),
    scope: forgedOperation.scope,
  };
  forgedFacts.factsManifestHash = computePermissionFactsManifestHash(forgedFacts);
  eq(`${label} facts fail closed`, validatePermissionFacts(forgedOperation, forgedFacts).code, expectedCode);
  eq(`${label} cannot default allow`, evaluatePermissionOperation({
    operation: forgedOperation, facts: forgedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, now: NOW,
  }).decision, 'DENY');
}

// Product modes only change the default decision. They do not change facts.
eq('standard package install asks', evaluatePermissionOperation({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.STANDARD, now: NOW, verifyFactsProof }).decision, 'ASK');
eq('full autonomy without grant still asks', evaluatePermissionOperation({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, now: NOW, verifyFactsProof }).decision, 'ASK');
eq('missing resolver proof denies', evaluatePermissionOperation({ operation: base, facts: { ...baseFacts, attestation: null }, mode: PERMISSION_MODES.STANDARD, now: NOW }).reasonCode, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
eq('invalid resolver proof denies', evaluatePermissionOperation({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.STANDARD, now: NOW, verifyFactsProof: () => false }).reasonCode, PERMISSION_REASON_CODES.FACTS_PROOF_INVALID);
eq('standard has a short grant TTL ceiling', PERMISSION_MODE_POLICIES.STANDARD.maxGrantTtlMs, 15 * 60 * 1000);
eq('full autonomy has the broader bounded grant envelope', PERMISSION_MODE_POLICIES.FULL_AUTONOMY.maxGrantTtlMs, 24 * 60 * 60 * 1000);

const grant = grantFor(base);
eq('grant validation', validateCapabilityGrant(grant, { now: NOW }).ok, true);
eq('grant hash stable', grant.constraintManifestHash, computeCapabilityConstraintHash(grant));
eq('capability proof is mandatory for allow', evaluatePermissionOperation({
  operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant,
  now: NOW, useNonce: 'missing-proof', usageConsumed: 0, verifyFactsProof,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_PROOF_REQUIRED);
eq('invalid capability proof denies allow', evaluatePermissionOperation({
  operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant,
  now: NOW, useNonce: 'invalid-proof', usageConsumed: 0, verifyFactsProof, verifyGrantProof: () => false,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_PROOF_INVALID);
const readLike = operation({ primaryAction: 'fs.read', effects: [] });
const readLikeFacts = factsFor(readLike);
eq('invalid grant cannot preserve default allow', evaluatePermissionOperation({
  operation: readLike, facts: readLikeFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grant, now: NOW, useNonce: 'read-invalid-grant', usageConsumed: 0,
  verifyFactsProof, verifyGrantProof,
}).decision, 'ASK');
const sensitiveRead = operation({
  primaryAction: 'fs.read',
  effects: [],
  target: { kind: 'filesystem_file', platform: 'linux', path: '/project/.env', exact: true },
  impact: { estimatedItems: 1, containsSensitiveMaterial: true, containsGitMetadata: false, reversible: true },
});
const sensitiveReadFacts = factsFor(sensitiveRead, {
  impact: { reversible: true, containsSensitiveMaterial: true, containsGitMetadata: false },
});
eq('sensitive read requires review without grant', evaluatePermissionOperation({
  operation: sensitiveRead, facts: sensitiveReadFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  now: NOW, verifyFactsProof,
}).decision, 'ASK');
const sensitiveReadGrant = grantFor(sensitiveRead);
eq('sensitive read exact grant can authorize', evaluateWithProof({
  operation: sensitiveRead, facts: sensitiveReadFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: sensitiveReadGrant, now: NOW, useNonce: 'sensitive-read-1',
}).decision, 'ALLOW');
eq('full autonomy exact grant allows', evaluateWithProof({
  operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant,
  now: NOW, useNonce: 'use-1', usageConsumed: 0, verifyFactsProof, verifyGrantProof,
}).decision, 'ALLOW');
eq('grant mode mismatch is not silently reused', evaluateWithProof({
  operation: base, facts: baseFacts, mode: PERMISSION_MODES.STANDARD, capability: grant,
  now: NOW, useNonce: 'use-2', usageConsumed: 1, verifyFactsProof, verifyGrantProof,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_MODE_MISMATCH);

// Constraint sets are monotonic: actual facts may be richer, never broader.
check('constraint object rejects unpinned actual facts', !valueSatisfiesConstraint(
  { profiles: ['private'], protocol: 'tcp', port: 8080, program: 'Ragent.exe', extraFact: true },
  { profiles: ['private'], protocol: 'tcp', port: 8080 },
));
check('public profile expansion does not match', !valueSatisfiesConstraint(
  { profiles: ['private', 'public'], protocol: 'tcp', port: 8080 },
  { profiles: ['private'], protocol: 'tcp', port: 8080 },
));
check('actual array subset does not match a broader grant', !valueSatisfiesConstraint(
  { profiles: ['private'], protocol: 'tcp', port: 8080 },
  { profiles: ['private', 'public'], protocol: 'tcp', port: 8080 },
));
check('canonical array order is not an authorization dimension', valueSatisfiesConstraint(
  { profiles: ['public', 'private'], protocol: 'tcp', port: 8080 },
  { profiles: ['private', 'public'], protocol: 'tcp', port: 8080 },
));
check('wildcard grant is rejected', !validateCapabilityGrant({ ...grant, constraints: { ...grant.constraints, resource: { manager: '*' } } }, { now: NOW }).ok);
check('unmodeled top-level constraint field is rejected', !validateCapabilityGrant({
  ...grant,
  constraints: { ...grant.constraints, allowBroaderTarget: true },
}, { now: NOW }).ok);
check('unmodeled impact constraint field is rejected', !validateCapabilityGrant({
  ...grant,
  constraints: { ...grant.constraints, impact: { ...grant.constraints.impact, auditWeakening: false } },
}, { now: NOW }).ok);
check('empty resource constraint is rejected', !validateCapabilityGrant({ ...grant, constraints: { ...grant.constraints, resource: {} } }, { now: NOW }).ok);
check('scope kind is mandatory', !validateCapabilityGrant({ ...grant, constraints: { ...grant.constraints, scope: { computed: true } } }, { now: NOW }).ok);
check('dynamic target grant is rejected', !validateCapabilityGrant({
  ...grant,
  constraints: { ...grant.constraints, target: { kind: 'variable', platform: 'linux', variableName: 'TARGET' } },
}, { now: NOW }).ok);
check('unmodeled target grant is rejected', !validateCapabilityGrant({
  ...grant,
  constraints: { ...grant.constraints, target: { kind: 'future_target', platform: 'linux' } },
}, { now: NOW }).ok);
check('unsupported platform grant is rejected', !validateCapabilityGrant({
  ...grant,
  constraints: { ...grant.constraints, target: { kind: 'package', platform: 'darwin' } },
}, { now: NOW }).ok);
check('security taxonomy nested fields are frozen', Object.isFrozen(ACTION_TAXONOMY['fs.read']));
check('immutable deny set is frozen', Object.isFrozen(IMMUTABLE_DENY_ACTIONS));
check('strong auth set is frozen', Object.isFrozen(STRONG_AUTH_ACTIONS));
for (const [label, mutation] of [
  ['grant schema version', { schemaVersion: 'capability-grant/v999' }],
  ['grant TTL', { expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() }],
  ['grant usage budget', { usageBudget: { max: 3 } }],
  ['grant nonce', { nonce: 'different-grant-nonce' }],
  ['grant proof', { grantProof: 'different-proof' }],
]) {
  check(`${label} tamper changes manifest`, validateCapabilityGrant({ ...grant, ...mutation }, { now: NOW }).ok === false);
}

const packageExpansion = buildPermissionFacts({
  operation: base,
  executionClass: base.executionClass,
  impact: baseFacts.impact,
  resource: baseFacts.resource,
  selection: { packages: ['cmake', 'curl'], exact: true },
  resourceSnapshotIdentity: baseFacts.resourceSnapshotIdentity,
  effectEnumerationProof: 'effects-proof',
  attestation: 'resolver-proof',
});
eq('package selection expansion denied', evaluateWithProof({
  operation: base, facts: packageExpansion, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant,
  now: NOW, useNonce: 'use-expansion', usageConsumed: 0,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);
const resourceExpansion = buildPermissionFacts({
  operation: base,
  executionClass: base.executionClass,
  impact: baseFacts.impact,
  resource: { ...baseFacts.resource, extraSecurityField: 'expanded' },
  selection: baseFacts.selection,
  resourceSnapshotIdentity: baseFacts.resourceSnapshotIdentity,
  effectEnumerationProof: 'effects-proof',
  attestation: 'resolver-proof',
});
eq('unpinned resource field does not match capability', evaluateWithProof({
  operation: base, facts: resourceExpansion, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grant, now: NOW, useNonce: 'resource-expansion',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);
const targetKindExpansion = operation({ target: { ...base.target, kind: 'package_artifact' } });
const targetKindFacts = factsFor(targetKindExpansion);
eq('target kind expansion does not match capability', evaluateWithProof({
  operation: targetKindExpansion, facts: targetKindFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grant, now: NOW, useNonce: 'target-kind-expansion', usageConsumed: 0,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);
const targetPlatformExpansion = operation({ target: { ...base.target, platform: 'win32' } });
const targetPlatformFacts = factsFor(targetPlatformExpansion);
eq('target platform expansion does not match capability', evaluateWithProof({
  operation: targetPlatformExpansion, facts: targetPlatformFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grant, now: NOW, useNonce: 'target-platform-expansion', usageConsumed: 0,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);
const systemScope = operation({ scope: { kind: 'system', computed: true } });
const systemScopeFacts = factsFor(systemScope);
const projectScope = operation({ scope: { kind: 'project', computed: true } });
const projectScopeGrant = grantFor(projectScope);
eq('scope expansion does not match capability', evaluateWithProof({
  operation: systemScope, facts: systemScopeFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: projectScopeGrant, now: NOW, useNonce: 'scope-expansion',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);

const effectExpansion = operation({ effects: ['process.execute', 'network.egress'] });
const effectFacts = factsFor(effectExpansion);
eq('effect expansion denied', evaluateWithProof({
  operation: effectExpansion, facts: effectFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant,
  now: NOW, useNonce: 'use-effect-expansion', usageConsumed: 0,
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);

// Ceiling actions cannot be rescued by Full Autonomy or a forged grant.
for (const action of ['permission.policy.modify', 'capability.forge', 'approval.bypass', 'audit.tamper', 'executor.bypass', 'signing.key.read', 'credential.read', 'remote_code.execute']) {
  const op = operation({ primaryAction: action, effects: [] });
  const facts = factsFor(op);
  eq(`${action} ceiling`, evaluatePermissionOperation({ operation: op, facts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: null, now: NOW }).decision, 'DENY');
}
for (const [label, op] of [
  ['unknown confidence', operation({ analysis: { ...base.analysis, confidence: 'unknown' } })],
]) {
  const facts = factsFor(op);
  eq(`${label} is immutable deny`, evaluatePermissionOperation({ operation: op, facts, mode: PERMISSION_MODES.FULL_AUTONOMY, now: NOW, verifyFactsProof }).decision, 'DENY');
}
const lowConfidence = operation({ analysis: { ...base.analysis, confidence: 'low' } });
eq('low confidence cannot be rescued by exact grant', evaluateWithProof({
  operation: lowConfidence,
  facts: factsFor(lowConfidence),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(lowConfidence),
  now: NOW,
  useNonce: 'low-confidence',
}).decision, 'DENY');
const operationUnknown = operation({ analysis: { ...base.analysis, unknowns: ['host:unclassified-effect'] } });
eq('operation analysis unknowns fail closed', evaluateWithProof({
  operation: operationUnknown,
  facts: factsFor(operationUnknown),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(operationUnknown),
  now: NOW,
  useNonce: 'analysis-unknown',
}).decision, 'DENY');
eq('operation analysis unknowns use the unified unknown-host reason',
  evaluateWithProof({
    operation: operationUnknown,
    facts: factsFor(operationUnknown),
    mode: PERMISSION_MODES.FULL_AUTONOMY,
    capability: grantFor(operationUnknown),
    now: NOW,
    useNonce: 'analysis-unknown-reason',
  }).reasonCode, PERMISSION_REASON_CODES.UNKNOWN_HOST_EFFECT);

const elevated = operation({ primaryAction: 'privilege.elevate', effects: [] });
eq('owner grant cannot authorize privilege elevation', evaluateWithProof({
  operation: elevated,
  facts: factsFor(elevated),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(elevated),
  now: NOW,
  useNonce: 'elevation-owner',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);
const auditConfig = operation({ primaryAction: 'security.audit.config.modify', effects: [] });
eq('owner grant cannot authorize audit weakening config', evaluateWithProof({
  operation: auditConfig,
  facts: factsFor(auditConfig),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(auditConfig),
  now: NOW,
  useNonce: 'audit-config-owner',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);

const ordinaryDelete = operation({
  primaryAction: 'fs.delete',
  effects: [],
  target: { kind: 'filesystem_file', platform: 'linux', path: '/project/build/cache', exact: true },
  scope: {
    kind: 'project',
    computed: true,
    selfProtection: {
      computed: true,
      matched: false,
      workspaceRecommended: true,
      boundary: 'none',
    },
  },
  impact: { estimatedItems: 1, containsSensitiveMaterial: false, containsGitMetadata: false, reversible: true },
});
const expandedDelete = operation({
  ...ordinaryDelete,
  executionClass: 'privileged',
  target: { ...ordinaryDelete.target, recursive: true, force: true },
  impact: { estimatedItems: 20, containsSensitiveMaterial: true, containsGitMetadata: false, reversible: false },
});
eq('grant cannot expand execution class impact or target flags', evaluateWithProof({
  operation: expandedDelete,
  facts: factsFor(expandedDelete, { resource: { path: '/project/build/cache', recursive: true, force: true } }),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(ordinaryDelete),
  now: NOW,
  useNonce: 'delete-expansion',
}).decision, 'ASK');
const fewerEffects = operation({ ...base, effects: [] });
eq('grant effects are pinned exactly and cannot use subset semantics', evaluateWithProof({
  operation: fewerEffects,
  facts: factsFor(fewerEffects),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grant,
  now: NOW,
  useNonce: 'effects-subset',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);

const protectedDelete = operation({
  ...ordinaryDelete,
  scope: {
    ...ordinaryDelete.scope,
    selfProtection: {
      computed: true,
      matched: true,
      workspaceRecommended: false,
      boundary: 'ragent-service',
    },
  },
});
eq('exact grant cannot bypass self-protection ceiling', evaluateWithProof({
  operation: protectedDelete,
  facts: factsFor(protectedDelete),
  mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: grantFor(protectedDelete),
  now: NOW,
  useNonce: 'self-protection-boundary',
}).reasonCode, PERMISSION_REASON_CODES.SELF_PROTECTION_BOUNDARY);
const privilegedDelete = operation({
  ...ordinaryDelete,
  executionClass: 'privileged',
});
const privilegedFacts = factsFor(privilegedDelete);
eq('privileged facts require review without grant', evaluatePermissionOperation({
  operation: privilegedDelete, facts: privilegedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  now: NOW, verifyFactsProof,
}).decision, 'ASK');
const credentialOp = operation({ primaryAction: 'credential.read', effects: [] });
const credentialFacts = factsFor(credentialOp);
const credentialGrant = grantFor(credentialOp);
eq('direct revalidation keeps immutable ceiling', revalidateCapabilityGrant(
  credentialGrant,
  credentialOp,
  credentialFacts,
  { now: NOW, mode: PERMISSION_MODES.FULL_AUTONOMY, useNonce: 'credential-ceiling', verifyFactsProof, verifyGrantProof },
).code, PERMISSION_REASON_CODES.META_PERMISSION);

const firewall = operation({
  operationId: 'sop_firewall_1', primaryAction: 'security.firewall.rule.modify', effects: ['network.listen'],
  target: { kind: 'firewall_rule', platform: 'win32', manager: 'windows-firewall' },
});
const firewallFacts = buildPermissionFacts({
  operation: firewall,
  executionClass: firewall.executionClass,
  impact: {
    reversible: firewall.impact.reversible,
    containsSensitiveMaterial: false,
    containsGitMetadata: false,
  },
  resource: { program: 'Ragent.exe', direction: 'inbound' },
  selection: { protocol: 'tcp', port: 8080, profiles: ['private'] },
  resourceSnapshotIdentity: 'firewall-snapshot-1',
  effectEnumerationProof: 'effects-proof',
  attestation: 'resolver-proof',
});
const firewallGrant = createCapabilityGrant({
  mode: PERMISSION_MODES.FULL_AUTONOMY, issuedAtTurn: 'turn-firewall', issuedAt: new Date(NOW), ttlMs: 3600000, usageMax: 3,
  workload: { scope: CAPABILITY_WORKLOAD_SCOPES.RUN, sessionId: firewall.requestBinding.sessionId, runId: firewall.requestBinding.runId, turnBinding: 'provenance' },
  constraints: {
    action: 'security.firewall.rule.modify',
    scope: firewallFacts.scope,
    resourceSnapshotIdentity: firewallFacts.resourceSnapshotIdentity,
    executionClass: firewall.executionClass,
    impact: { reversible: firewall.impact.reversible, containsSensitiveMaterial: false, containsGitMetadata: false },
    target: firewall.target,
    targetFlags: { recursive: false, force: false, exact: false },
    resource: { program: 'Ragent.exe', direction: 'inbound' },
    selection: { protocol: 'tcp', port: 8080, profiles: ['private'] },
    effects: { subset: ['network.listen'] },
  },
  grantProof: 'owner-proof',
});
eq('private firewall rule exact grant allows', evaluateWithProof({ operation: firewall, facts: firewallFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: firewallGrant, now: NOW, useNonce: 'fw-1' }).decision, 'ALLOW');
const publicFirewallFacts = buildPermissionFacts({
  operation: firewall,
  executionClass: firewall.executionClass,
  impact: {
    reversible: firewall.impact.reversible,
    containsSensitiveMaterial: false,
    containsGitMetadata: false,
  },
  resource: firewallFacts.resource,
  selection: { protocol: 'tcp', port: 8080, profiles: ['public'] },
  resourceSnapshotIdentity: firewallFacts.resourceSnapshotIdentity,
  effectEnumerationProof: 'effects-proof',
  attestation: 'resolver-proof',
});
eq('public firewall expansion does not allow', evaluateWithProof({ operation: firewall, facts: publicFirewallFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: firewallGrant, now: NOW, useNonce: 'fw-2' }).decision, 'ASK');

const defender = operation({ operationId: 'sop_defender_1', primaryAction: 'security.antivirus.disable', effects: [] });
const defenderFacts = factsFor(defender, { attestation: 'resolver-proof' });
const weakDefenderGrant = createCapabilityGrant({
  mode: PERMISSION_MODES.FULL_AUTONOMY, issuedAtTurn: 'turn-defender', issuedAt: new Date(NOW), ttlMs: 3600000,
  workload: { scope: CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION, sessionId: defender.requestBinding.sessionId, operationId: defender.operationId, turnBinding: 'provenance' },
  constraints: { action: defender.primaryAction, scope: defenderFacts.scope, resourceSnapshotIdentity: defenderFacts.resourceSnapshotIdentity, executionClass: defender.executionClass, impact: { reversible: defender.impact.reversible, containsSensitiveMaterial: false, containsGitMetadata: false }, target: defender.target, targetFlags: { recursive: false, force: false, exact: true }, resource: { manager: 'apt', source: 'trusted_repository', repository: 'main' }, selection: { packages: ['cmake'], exact: true }, effects: { subset: [] } },
  grantProof: 'owner-proof',
});
eq('weak defender grant requires strong auth', evaluateWithProof({ operation: defender, facts: defenderFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: weakDefenderGrant, now: NOW, useNonce: 'def-1' }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);
const strongDefenderGrant = createCapabilityGrant({ ...weakDefenderGrant, authorizationClass: CAPABILITY_AUTHORIZATION_CLASSES.STRONG_OWNER });
eq('strong defender grant allows only exact operation', evaluateWithProof({ operation: defender, facts: defenderFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: strongDefenderGrant, now: NOW, useNonce: 'def-2' }).decision, 'ALLOW');
const hiddenDefender = operation({ operationId: 'sop_hidden_defender', primaryAction: 'process.execute', effects: ['security.antivirus.disable'] });
const hiddenDefenderFacts = factsFor(hiddenDefender, { attestation: 'resolver-proof' });
const hiddenDefenderGrant = createCapabilityGrant({
  mode: PERMISSION_MODES.FULL_AUTONOMY, issuedAtTurn: 'turn-hidden-defender', issuedAt: new Date(NOW), ttlMs: 3600000,
  workload: { scope: CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION, sessionId: hiddenDefender.requestBinding.sessionId, operationId: hiddenDefender.operationId, turnBinding: 'provenance' },
  constraints: { action: hiddenDefender.primaryAction, scope: hiddenDefenderFacts.scope, resourceSnapshotIdentity: hiddenDefenderFacts.resourceSnapshotIdentity, executionClass: hiddenDefender.executionClass, impact: { reversible: hiddenDefender.impact.reversible, containsSensitiveMaterial: false, containsGitMetadata: false }, target: hiddenDefender.target, targetFlags: { recursive: false, force: false, exact: true }, resource: { manager: 'apt', source: 'trusted_repository', repository: 'main' }, selection: { packages: ['cmake'], exact: true }, effects: { subset: ['security.antivirus.disable'] } },
  grantProof: 'owner-proof',
});
eq('strong auth applies to dangerous effects', evaluateWithProof({ operation: hiddenDefender, facts: hiddenDefenderFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: hiddenDefenderGrant, now: NOW, useNonce: 'hidden-defender-1' }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);
const avExclusion = operation({ operationId: 'sop_av_exclusion', primaryAction: 'security.antivirus.exclusion.add', effects: [] });
const avExclusionFacts = factsFor(avExclusion);
const avExclusionGrant = grantFor(avExclusion);
eq('antivirus exclusion requires strong auth', evaluateWithProof({
  operation: avExclusion, facts: avExclusionFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: avExclusionGrant, now: NOW, useNonce: 'av-exclusion-1',
}).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_STRONG_AUTH_REQUIRED);
eq('standard strong action without grant denies', evaluatePermissionOperation({ operation: defender, facts: defenderFacts, mode: PERMISSION_MODES.STANDARD, now: NOW, verifyFactsProof }).decision, 'DENY');
eq('full autonomy strong action without grant still asks', evaluatePermissionOperation({ operation: defender, facts: defenderFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, now: NOW, verifyFactsProof }).decision, 'ASK');

eq('expired grant denied', validateCapabilityGrant(grant, { now: Date.parse(grant.expiresAt) }).code, PERMISSION_REASON_CODES.CAPABILITY_EXPIRED);
eq('future-issued grant denied', validateCapabilityGrant({ ...grant, issuedAt: new Date(NOW + 60_000).toISOString() }, { now: NOW }).code, PERMISSION_REASON_CODES.CAPABILITY_INVALID);
eq('missing use nonce denied', evaluateWithProof({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant, now: NOW }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_USE_NONCE_REQUIRED);
eq('replayed use nonce denied', evaluateWithProof({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant, now: NOW, useNonce: 'use-replay', usageConsumed: 0, consumedUseNonces: ['use-replay'] }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_USE_NONCE_REPLAY);
eq('usage budget denied', evaluateWithProof({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.FULL_AUTONOMY, capability: grant, now: NOW, useNonce: 'use-budget', usageConsumed: grant.usageBudget.max }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_USAGE_EXHAUSTED);
const consumed = consumeCapabilityUse(grant, { operation: base, facts: baseFacts, now: NOW, mode: PERMISSION_MODES.FULL_AUTONOMY, consumed: 0, useNonces: [], verifyFactsProof, verifyGrantProof }, 'use-atomic');
eq('pure consume increments usage', consumed.state.consumed, 1);
eq('pure consume records nonce', consumed.state.useNonces[0], 'use-atomic');
eq('pure consume replay rejects', consumeCapabilityUse(grant, { operation: base, facts: baseFacts, now: NOW, mode: PERMISSION_MODES.FULL_AUTONOMY, consumed: 1, useNonces: ['use-atomic'], verifyFactsProof, verifyGrantProof }, 'use-atomic').code, PERMISSION_REASON_CODES.CAPABILITY_USE_NONCE_REPLAY);
eq('grant mode is bound', evaluateWithProof({ operation: base, facts: baseFacts, mode: PERMISSION_MODES.STANDARD, capability: grant, now: NOW, useNonce: 'mode-mismatch' }).reasonCode, PERMISSION_REASON_CODES.CAPABILITY_MODE_MISMATCH);

eq('execution revalidation accepts unchanged facts', revalidateCapabilityGrant(grant, base, baseFacts, { now: NOW, useNonce: 'revalidate-1', verifyFactsProof, verifyGrantProof, mode: PERMISSION_MODES.FULL_AUTONOMY }).ok, true);
eq('execution revalidation requires active mode', revalidateCapabilityGrant(grant, base, baseFacts, { now: NOW, useNonce: 'revalidate-no-mode', verifyFactsProof, verifyGrantProof }).code, PERMISSION_REASON_CODES.CAPABILITY_MODE_MISMATCH);
const changedSnapshotFacts = buildPermissionFacts({
  operation: base,
  executionClass: base.executionClass,
  impact: baseFacts.impact,
  resource: baseFacts.resource,
  selection: baseFacts.selection,
  resourceSnapshotIdentity: 'snapshot-2',
  effectEnumerationProof: 'effects-proof',
  attestation: 'resolver-proof',
});
eq('execution revalidation rejects changed snapshot', revalidateCapabilityGrant(grant, base, changedSnapshotFacts, { now: NOW, useNonce: 'revalidate-2', verifyFactsProof, verifyGrantProof, mode: PERMISSION_MODES.FULL_AUTONOMY }).code, PERMISSION_REASON_CODES.CAPABILITY_CONSTRAINT_MISMATCH);

const aggregate = evaluatePermissionSet([
  { operation: base, facts: baseFacts, mode: PERMISSION_MODES.STANDARD, now: NOW },
  { operation: operation({ operationId: 'sop_meta', primaryAction: 'audit.tamper', effects: [] }), facts: factsFor(operation({ operationId: 'sop_meta', primaryAction: 'audit.tamper', effects: [] })), mode: PERMISSION_MODES.FULL_AUTONOMY, now: NOW },
]);
eq('decision aggregation keeps DENY dominant', aggregate.decision, 'DENY');
eq('empty permission set is non-authorizing deny', evaluatePermissionSet([]).decision, 'DENY');

console.log(`permission-policy-phase2a: ${passed} checks passed`);
