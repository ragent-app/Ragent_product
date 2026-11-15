#!/usr/bin/env node
/**
 * Phase 2B slice 2B-3 tests — the permission policy gate on the approved-action
 * host route.
 *
 * Run: node tests/test-approved-action-policy-gate.mjs
 *
 * Covers:
 *   - host action with a DENY policy → denied before any capability creation/exec
 *   - host action ASK + valid signed capability → proceeds (policy ALLOW)
 *   - host action ASK without capability → ASK result (not exec)
 *   - missing/invalid facts proof → DENY
 *   - default (un-injected) proof verifier → DENY (fail closed)
 *   - legacy privileged host action without policy facts → DENY (fail closed)
 *   - batch decisions aggregated DENY > ASK > ALLOW
 *   - session executionClass is unchanged
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeApprovedAction,
  buildHostPermissionFacts,
} from '../chat/approved-action-executor.mjs';
import { openCapabilityGrantStore } from '../chat/capability-grant-store.mjs';
import {
  APPROVED_ACTION_SCHEMA_VERSION,
  computeApprovedActionManifestHash,
} from '../chat/approved-actions.mjs';
import { computeApprovedActionSemanticManifestHash } from '../chat/approved-action-semantic.mjs';
import {
  createCapabilityGrantProof,
  createPermissionFactsProof,
  createPermissionProofVerifier,
} from '../chat/permission-proof-verifier.mjs';
import {
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
  createCapabilityGrant,
} from '../chat/permission-policy.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  computeSemanticManifestHash,
} from '../chat/semantic-operation.mjs';

// The apt adapter path is enabled so a gate ALLOW proceeds into the existing
// semantic-apt capability creation path.
process.env.RAGENT_SEMANTIC_APT_ADAPTER_ENABLED = '1';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const KID = 'test-kid-2b3';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const verifier = createPermissionProofVerifier({ publicKeyByKid: { [KID]: publicKey }, now: NOW });
const durableGrantStore = openCapabilityGrantStore({ dir: mkdtempSync(join(tmpdir(), 'approved-action-capability-store-')) });

const SESSION = 'session-test';
const RUN = 'run-test';
const TURN = 'turn-test';

function operation(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_test_001',
    requestBinding: { sessionId: SESSION, runId: RUN, turnId: TURN, requestKey: 'request-test' },
    primaryAction: 'package.install',
    effects: ['process.execute'],
    executionClass: 'host',
    target: {
      kind: 'package', platform: 'linux', manager: 'apt', source: 'trusted_repository',
      packages: ['nginx'], exact: true,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: new Date(NOW).toISOString(),
        identity: 'snapshot-nginx',
        manager: 'apt', source: 'trusted_repository',
        packages: [{ name: 'nginx', requestedVersion: '', availableVersion: '1.25' }],
        repositories: [{ id: 'main', trust: 'configured' }],
      },
    },
    scope: { kind: 'system', computed: true, manager: 'apt' },
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

function decisionEntry(operationObject, overrides = {}) {
  return {
    operationId: operationObject.operationId,
    operation: operationObject,
    operationManifestHash: computeSemanticManifestHash(operationObject),
    resolverSnapshotIdentity: operationObject.target?.resourceSnapshot?.identity,
    policyVersion: SEMANTIC_POLICY_VERSION,
    unknowns: [],
    decision: 'ASK',
    strictness: 2,
    reasons: [{ code: 'effect_strictness_raise', message: 'requires owner approval' }],
    ...overrides,
  };
}

function projection(decision, entries = [], extra = {}) {
  return {
    schemaVersion: 'approved-action-semantic/v1',
    decision,
    strictness: decision === 'ALLOW' ? 1 : decision === 'ASK' ? 2 : 3,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    policyVersion: SEMANTIC_POLICY_VERSION,
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    unknowns: (Array.isArray(entries) ? entries : []).flatMap((entry) => entry.unknowns || []),
    decisions: Array.isArray(entries) ? entries : [],
    ...extra,
  };
}

function actionFor(proj, overrides = {}) {
  const base = {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    actionId: 'aa_test_001',
    sessionId: SESSION,
    runId: RUN,
    turnId: TURN,
    requestKey: 'request-test',
    canonicalCommand: 'apt-get install nginx',
    cwd: '/tmp/project',
    declaredCategory: 'install',
    category: 'install',
    sawLeadingSudo: true,
    originalRequest: { description: 'install nginx', reason: 'test' },
    executionClass: 'host',
    risk: { tier: 'danger' },
    semanticProjection: proj,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 600000).toISOString(),
    state: 'authorized',
    auditId: 'aaudit_test_001',
    authorization: { source: 'owner', credentialId: 'cred-test', selectionManifestHash: 'sel-hash' },
    ...overrides,
  };
  base.semanticManifestHash = computeApprovedActionSemanticManifestHash({ action: base, projection: proj });
  base.manifestHash = computeApprovedActionManifestHash(base);
  return base;
}

/** Build a decision whose facts envelope is signed by the trusted server key. */
function signedEntry(operationObject, overrides = {}) {
  const entry = decisionEntry(operationObject);
  const signedFacts = createPermissionFactsProof({
    operation: operationObject,
    facts: buildHostPermissionFacts({ ...entry, factsProof: undefined }),
    privateKey,
    kid: KID,
    now: NOW,
    ttlMs: 600000,
  });
  return { ...entry, factsProof: signedFacts.proof, ...overrides };
}

function grantFor(operationObject, facts, {
  workloadScope = CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION,
  grantOverrides = {},
} = {}) {
  const workload = {
    scope: workloadScope,
    sessionId: operationObject.requestBinding.sessionId,
    turnBinding: 'provenance',
  };
  if (workloadScope === CAPABILITY_WORKLOAD_SCOPES.RUN) {
    workload.runId = operationObject.requestBinding.runId;
  }
  if (workloadScope === CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION) {
    workload.operationId = operationObject.operationId;
  }
  const grant = createCapabilityGrant({
    mode: PERMISSION_MODES.STANDARD,
    issuedAtTurn: 'turn-approval-2b3',
    issuedAt: new Date(NOW),
    ttlMs: 10 * 60 * 1000,
    usageMax: 1,
    workload,
    constraints: {
      action: operationObject.primaryAction,
      scope: facts.scope,
      resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
      executionClass: facts.executionClass,
      impact: {
        reversible: facts.impact.reversible,
        containsSensitiveMaterial: facts.impact.containsSensitiveMaterial,
        containsGitMetadata: facts.impact.containsGitMetadata,
      },
      target: operationObject.target,
      targetFlags: { recursive: false, force: false, exact: facts.selection?.exact === true },
      resource: facts.resource,
      selection: facts.selection,
      effects: { subset: operationObject.effects },
    },
    ...grantOverrides,
  });
  return createCapabilityGrantProof({ grant, privateKey, kid: KID, now: NOW, ttlMs: 600000 });
}

// --- 1. host action with DENY policy → denied before any exec -----------------

{
  const denyOperation = operation({
    operationId: 'sop_deny_001',
    primaryAction: 'credential.read',
    effects: ['process.execute'],
    target: {
      kind: 'filesystem_file', platform: 'linux', paths: ['/home/owner/.ssh/id_rsa'],
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        identity: 'snapshot-cred',
        paths: [{ canonical: '/home/owner/.ssh/id_rsa', identity: 'cred-1' }],
      },
    },
    scope: { kind: 'home_credential', computed: true },
    impact: { reversible: false, containsSensitiveMaterial: true, containsGitMetadata: false },
  });
  const entry = signedEntry(denyOperation);
  // Top-level ASK bypasses the durable-projection guard so this test exercises
  // the permission policy gate's DENY ceiling (credential.read is immutably
  // denied even when an exact capability is supplied).
  const act = actionFor(projection('ASK', [entry]));
  const facts = buildHostPermissionFacts(entry);
  const grant = grantFor(denyOperation, facts);
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    authorization: { credentialId: 'cred-test' },
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grant,
    useNonce: 'nonce-deny',
  });
  eq('host DENY policy returns DENY', result.decision, 'DENY');
  check('host DENY policy is not ok and never executes', result.ok === false && result.event === null);
  check('host DENY policy reports a policy reason', result.reasonCode === PERMISSION_REASON_CODES.META_PERMISSION);
}

// --- 2. host action ASK + valid signed capability → proceeds ------------------

{
  const entry = signedEntry(operation());
  const act = actionFor(projection('ASK', [entry]));
  const facts = buildHostPermissionFacts(entry);
  const grant = grantFor(entry.operation, facts);
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    authorization: { credentialId: 'cred-test' },
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grant,
    useNonce: 'nonce-ask-ok',
    grantStore: durableGrantStore,
  });
  eq('ASK + capability is policy ALLOW (proceeds)', result.decision, 'ALLOW');
  // It proceeds into the apt capability path; without a real signing key the
  // executor stops at the signing-key gate (never a policy denial).
  eq('ASK + capability resultRef is the signing-key gate, not a policy denial', result.resultRef.error, 'Semantic capability signing key is unavailable');
  eq('failed pre-execution signing-key path does not consume grant', (await durableGrantStore.getGrantState({ grantId: grant.grantId })).state.consumed, 0);
}

// A production capability cannot execute without the durable CAS store. The
// unit-only policy path above injects a store stub explicitly; omission here
// must fail closed after policy ALLOW and before any executor call.
{
  const entry = signedEntry(operation({ operationId: 'sop_store_required' }));
  const act = actionFor(projection('ASK', [entry]), { actionId: 'aa_store_required' });
  const facts = buildHostPermissionFacts(entry);
  const grant = grantFor(entry.operation, facts);
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grant,
    useNonce: 'nonce-store-required',
  });
  eq('host capability without durable store is DENY', result.decision, 'DENY');
  eq('missing durable store reason is capability invalid', result.reasonCode, PERMISSION_REASON_CODES.CAPABILITY_INVALID);
}

// --- 3. host action ASK without capability → ASK result (not exec) ------------

{
  const entry = signedEntry(operation({ operationId: 'sop_ask_002' }));
  const act = actionFor(projection('ASK', [entry]));
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'nonce-ask-only',
  });
  eq('ASK without capability returns ASK', result.decision, 'ASK');
  check('ASK without capability does not execute', result.ok === false && result.event === null);
  eq('ASK without capability explains owner approval is required', result.reasonCode, PERMISSION_REASON_CODES.ASK_DEFAULT);
}

// --- 3b. uncertainty remains a DENY even with an exact capability ------------

{
  const lowConfidenceOperation = operation({
    operationId: 'sop_low_confidence_gate',
    analysis: { ...operation().analysis, confidence: 'low' },
  });
  const entry = signedEntry(lowConfidenceOperation);
  const act = actionFor(projection('ASK', [entry]), { actionId: 'aa_low_confidence_gate' });
  const facts = buildHostPermissionFacts(entry);
  const grant = grantFor(lowConfidenceOperation, facts);
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grant,
    useNonce: 'nonce-low-confidence-gate',
    grantStore: durableGrantStore,
  });
  eq('approved-action exact capability cannot authorize low confidence', result.decision, 'DENY');
  eq('approved-action low confidence hits the security ceiling', result.reasonCode, PERMISSION_REASON_CODES.SECURITY_CEILING);
}

{
  const unknownOperation = operation({
    operationId: 'sop_analysis_unknown_gate',
    analysis: { ...operation().analysis, unknowns: ['host:unclassified-effect'] },
  });
  const act = actionFor(projection('ASK', [decisionEntry(unknownOperation)]), { actionId: 'aa_analysis_unknown_gate' });
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'nonce-analysis-unknown-gate',
  });
  eq('approved-action analysis unknowns cannot reach capability evaluation', result.decision, 'DENY');
  eq('approved-action analysis unknowns fail closed while facts are built', result.reasonCode, PERMISSION_REASON_CODES.UNKNOWN_HOST_EFFECT);
}

// --- 4. missing/invalid facts proof → DENY ------------------------------------

{
  // Missing facts proof: the projection decision carries no signed factsProof.
  const entry = decisionEntry(operation({ operationId: 'sop_noproof' }));
  const act = actionFor(projection('ASK', [entry]));
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'nonce-noproof',
  });
  eq('missing facts proof is DENY', result.decision, 'DENY');
  eq('missing facts proof reason is FACTS_PROOF_INVALID', result.reasonCode, PERMISSION_REASON_CODES.FACTS_PROOF_INVALID);

  // Invalid facts proof: a tampered signature must also fail closed.
  const entry2 = signedEntry(operation({ operationId: 'sop_badproof' }));
  entry2.factsProof = { ...entry2.factsProof, sig: 'AA'.repeat(32) };
  const act2 = actionFor(projection('ASK', [entry2]));
  const result2 = await executeApprovedAction(act2, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'nonce-badproof',
  });
  eq('tampered facts proof is DENY', result2.decision, 'DENY');
  eq('tampered facts proof reason is FACTS_PROOF_INVALID', result2.reasonCode, PERMISSION_REASON_CODES.FACTS_PROOF_INVALID);
}

// --- 5. default (un-injected) proof verifier → DENY (fail closed) -------------

{
  const entry = signedEntry(operation({ operationId: 'sop_noverifier' }));
  const act = actionFor(projection('ASK', [entry]));
  const result = await executeApprovedAction(act, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    useNonce: 'nonce-noverifier',
    // No verifyFactsProof / verifyGrantProof injected — the fail-closed default.
  });
  eq('no injected verifier is DENY', result.decision, 'DENY');
  eq('no injected verifier reason is FACTS_PROOF_REQUIRED', result.reasonCode, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
}

// --- 6. legacy privileged host action without policy facts → DENY (fail closed)

{
  const legacy = {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    actionId: 'aa_legacy_001',
    sessionId: SESSION,
    runId: RUN,
    turnId: TURN,
    requestKey: 'request-legacy',
    canonicalCommand: 'systemctl restart nginx',
    cwd: '/tmp/project',
    declaredCategory: 'privileged_other',
    category: 'privileged_other',
    sawLeadingSudo: true,
    originalRequest: { description: 'restart nginx', reason: 'test' },
    executionClass: 'host',
    risk: { tier: 'danger' },
    semanticProjection: null,
    semanticManifestHash: '',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 600000).toISOString(),
    state: 'authorized',
    auditId: 'aaudit_legacy',
    authorization: { source: 'owner', credentialId: 'cred-test', selectionManifestHash: 'sel-hash' },
  };
  legacy.manifestHash = computeApprovedActionManifestHash(legacy);
  const result = await executeApprovedAction(legacy, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
  });
  eq('legacy privileged host action without policy facts is DENY', result.decision, 'DENY');
  check('legacy privileged host action never reaches the privileged executor', result.ok === false && result.event === null);
  eq('legacy privileged host action fails closed on missing facts', result.reasonCode, PERMISSION_REASON_CODES.FACTS_REQUIRED);
}

// --- 7. batch decisions aggregated DENY > ASK > ALLOW --------------------------

{
  // DENY > ASK: one deny-ceiling member forces the whole batch to DENY.
  const askEntry = signedEntry(operation({ operationId: 'sop_batch_ask' }));
  const denyEntry = signedEntry(operation({
    operationId: 'sop_batch_deny',
    primaryAction: 'credential.read',
    target: {
      kind: 'filesystem_file', platform: 'linux', paths: ['/home/owner/.ssh/id_rsa'],
      resourceSnapshot: { resolverVersion: SEMANTIC_RESOLVER_VERSION, identity: 'snapshot-cred-b', paths: [{ canonical: '/home/owner/.ssh/id_rsa', identity: 'cred-b' }] },
    },
    scope: { kind: 'home_credential', computed: true },
    impact: { reversible: false, containsSensitiveMaterial: true, containsGitMetadata: false },
  }));
  const actDeny = actionFor(projection('ASK', [askEntry, denyEntry]), { actionId: 'aa_batch_deny' });
  const resultDeny = await executeApprovedAction(actDeny, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'nonce-batch-deny',
  });
  eq('batch [ASK, DENY] aggregates to DENY', resultDeny.decision, 'DENY');

  // ASK > ALLOW: a capability that matches one member but not the other forces ASK.
  const entry1 = signedEntry(operation({ operationId: 'sop_b1' }));
  const entry2 = signedEntry(operation({
    operationId: 'sop_b2',
    target: {
      ...operation().target,
      packages: ['curl'],
      resourceSnapshot: {
        ...operation().target.resourceSnapshot,
        identity: 'snapshot-curl',
        packages: [{ name: 'curl', requestedVersion: '', availableVersion: '8.0' }],
      },
    },
  }));
  const actAsk = actionFor(projection('ASK', [entry1, entry2]), { actionId: 'aa_batch_ask' });
  const facts1 = buildHostPermissionFacts(entry1);
  const grant = grantFor(entry1.operation, facts1); // pins packages ['nginx'] — entry2 (curl) cannot match
  const resultAsk = await executeApprovedAction(actAsk, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grant,
    useNonce: 'nonce-batch-ask',
  });
  eq('batch [ALLOW-via-cap, unmatched member] aggregates to ASK', resultAsk.decision, 'ASK');

  // ALLOW: a capability matching every identical member aggregates to ALLOW.
  const a1 = signedEntry(operation({ operationId: 'sop_a1' }));
  const a2 = signedEntry(operation({ operationId: 'sop_a2' }));
  const actAllow = actionFor(projection('ASK', [a1, a2]), { actionId: 'aa_batch_allow' });
  const factsA = buildHostPermissionFacts(a1);
  const grantA = grantFor(a1.operation, factsA, { workloadScope: CAPABILITY_WORKLOAD_SCOPES.RUN });
  const resultAllow = await executeApprovedAction(actAllow, {
    now: NOW,
    sessionId: SESSION, runId: RUN, turnId: TURN,
    authorization: { credentialId: 'cred-test' },
    mode: PERMISSION_MODES.STANDARD,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    capability: grantA,
    useNonce: 'nonce-batch-allow',
    grantStore: durableGrantStore,
  });
  eq('batch [ALLOW, ALLOW] aggregates to ALLOW and proceeds', resultAllow.decision, 'ALLOW');
  eq('batch ALLOW proceeds into the capability path', resultAllow.resultRef.error, 'Semantic capability signing key is unavailable');
}

// --- 8. session executionClass is unchanged ------------------------------------

{
  const sessionCwd = mkdtempSync(join(tmpdir(), 'approved-action-policy-gate-'));
  const sessionResult = await executeApprovedAction({
    actionId: 'aa_session_2b3',
    executionClass: 'session',
    argv: [process.execPath, '-e', 'process.stdout.write("approved-action-policy-gate-ok")'],
    cwd: sessionCwd,
  }, { sessionId: 's-session', runId: 'r-session', turnId: 't-session' });
  check('session executionClass still executes argv', sessionResult.ok === true);
  eq('session executionClass stdout unchanged', sessionResult.resultRef.stdout, 'approved-action-policy-gate-ok');
}

durableGrantStore.close();

console.log(`approved-action-policy-gate: ${passed} checks passed`);
