#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAgentCreateReviewSummary,
  computeAgentCreatePayloadHash,
  computeToolDefinitionFingerprint,
  hasAgentScopeSessionProvenance,
  normalizeAgentCreatePayload,
  prepareAgentCreateSemanticProjection,
  validateAgentCreatePayloadRegistries,
} from '../chat/approved-agent-create.mjs';
import {
  buildApprovedAction,
  buildApprovedActionAuditEvent,
  createApprovedActionClientProjection,
} from '../chat/approved-actions.mjs';
import {
  buildHostPermissionFacts,
  executeApprovedAction,
  revalidateApprovedAgentCreateAction,
} from '../chat/approved-action-executor.mjs';
import { openCapabilityGrantStore } from '../chat/capability-grant-store.mjs';
import {
  createCapabilityGrantProof,
  createPermissionFactsProof,
  createPermissionProofVerifier,
} from '../chat/permission-proof-verifier.mjs';
import {
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  createCapabilityGrant,
} from '../chat/permission-policy.mjs';

const SESSION = 'session-agent-create';
const RUN = 'run-agent-create';
const TURN = 'turn-agent-create';
const REQUEST = 'request-agent-create';
const NOW = Date.now();
const ENV_ENABLED = { RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1' };
const payload = {
  name: 'Weekly Report Agent',
  systemPrompt: 'Prepare the weekly report. TOKEN=must-not-appear-in-review',
  welcomeMessage: 'Send me the source export.',
  tool: 'codex',
  skills: ['spreadsheets'],
  perMessageSystemPrompt: { auto: 'Check the reporting standard first.' },
};
const session = {
  id: SESSION,
  activeRunId: RUN,
  starterPreset: 'create_agent',
};
const run = { id: RUN, sessionId: SESSION, state: 'running' };
const manifest = {
  sessionId: SESSION,
  requestId: TURN,
  options: {
    approvedActionChannel: {
      turnId: TURN,
      productAgentCreate: true,
      authenticatedPrincipalKind: 'owner',
    },
  },
};
const availableTool = async (id) => ({ id, available: true, runtimeFamily: 'codex-app-server-json' });
const TOOL = { id: 'codex', available: true, runtimeFamily: 'codex-app-server-json' };
const TOOL_FINGERPRINT = computeToolDefinitionFingerprint(TOOL);
assert.notEqual(
  computeToolDefinitionFingerprint({ ...TOOL, provider: 'different-provider' }),
  TOOL_FINGERPRINT,
);
assert.notEqual(
  computeToolDefinitionFingerprint({ ...TOOL, promptMode: 'bare-user' }),
  TOOL_FINGERPRINT,
);
assert.equal(hasAgentScopeSessionProvenance({ templateId: 't' }), true);
assert.equal(hasAgentScopeSessionProvenance({ createdByPrincipalId: 'agent-guest-id' }), true);
assert.equal(hasAgentScopeSessionProvenance({ createdByPrincipalKind: 'agent_guest' }), true);
assert.equal(hasAgentScopeSessionProvenance({ visitorId: 'legacy-visitor' }), true);
assert.equal(hasAgentScopeSessionProvenance({ agentId: 'legacy-agent' }), true);
assert.equal(hasAgentScopeSessionProvenance({ scope: { agentId: 'legacy-agent' } }), true);
assert.equal(hasAgentScopeSessionProvenance({ surfaceMode: 'agent_scoped' }), true);
assert.equal(hasAgentScopeSessionProvenance({ sourceId: 'share_link' }), true);
assert.equal(hasAgentScopeSessionProvenance({ createdByPrincipalKind: 'owner' }), false);
assert.equal(hasAgentScopeSessionProvenance({}), false);

async function buildAction(agentPayload = payload) {
  const input = {
    actionId: 'aa_agent_create_test',
    operation: 'agent.create',
    agent: agentPayload,
    description: 'Create the Weekly Report Agent',
    reason: 'Owner requested this reusable workflow',
  };
  const context = {
    requestKey: REQUEST,
    sessionId: SESSION,
    runId: RUN,
    turnId: TURN,
    cwd: '/tmp',
  };
  const preliminary = buildApprovedAction(input, context);
  const semanticProjection = prepareAgentCreateSemanticProjection({
    action: preliminary,
    trustedContext: { session, run, manifest, platform: 'linux', toolFingerprint: TOOL_FINGERPRINT },
  });
  return buildApprovedAction(input, { ...context, semanticProjection });
}

const normalized = normalizeAgentCreatePayload(payload);
assert.equal(normalized.name, payload.name);
assert.equal(computeAgentCreatePayloadHash(payload), computeAgentCreatePayloadHash(normalized));
assert.doesNotMatch(buildAgentCreateReviewSummary(payload), /must-not-appear-in-review/);
assert.throws(
  () => normalizeAgentCreatePayload({ ...payload, systemPrompt: 'x'.repeat(70 * 1024) }),
  (error) => error?.code === 'AGENT_CREATE_FIELD_TOO_LARGE',
);
assert.equal((await validateAgentCreatePayloadRegistries(payload, {
  getToolDefinitionImpl: availableTool,
})).skillsSemantics, 'bounded_labels_only');
await assert.rejects(
  validateAgentCreatePayloadRegistries(payload, { getToolDefinitionImpl: async () => null }),
  (error) => error?.code === 'AGENT_CREATE_TOOL_UNKNOWN',
);
await assert.rejects(
  validateAgentCreatePayloadRegistries(payload, {
    getToolDefinitionImpl: async (id) => ({ id, available: false }),
  }),
  (error) => error?.code === 'AGENT_CREATE_TOOL_UNAVAILABLE',
);
assert.throws(
  () => normalizeAgentCreatePayload({ ...payload, collaborationPolicy: { canDelegate: true } }),
  (error) => error?.code === 'AGENT_CREATE_PAYLOAD_INVALID',
);

const action = await buildAction();
assert.equal(action.executionClass, 'product');
assert.equal(action.semanticProjection.decision, 'ASK');
assert.equal(action.semanticProjection.decisions[0].operation.primaryAction, 'agent.create');
assert.deepEqual(action.semanticProjection.decisions[0].operation.effects, [
  'product.agent_catalog.write',
  'product.agent_prompt.persist',
  'product.agent_runtime_binding.persist',
  'product.agent_skill_labels.persist',
]);
assert.equal(action.semanticProjection.decisions[0].operation.scope.authenticatedPrincipalKind, 'owner');
const clientProjection = createApprovedActionClientProjection(action);
assert.deepEqual(clientProjection.agentDefinition, normalizeAgentCreatePayload(payload));
assert.equal(clientProjection.agentPayload, undefined);
const auditEvent = buildApprovedActionAuditEvent(action, 'waiting_user');
assert.doesNotMatch(JSON.stringify(auditEvent), /must-not-appear-in-review/);
const windowsProjection = prepareAgentCreateSemanticProjection({
  action,
  trustedContext: { session, run, manifest, platform: 'win32', toolFingerprint: TOOL_FINGERPRINT },
});
assert.equal(windowsProjection.decision, 'ASK');
assert.equal(windowsProjection.decisions[0].operation.target.platform, 'win32');
assert.doesNotThrow(() => buildHostPermissionFacts(windowsProjection.decisions[0]));

const revalidationOptions = {
  sessionId: SESSION,
  runId: RUN,
  turnId: TURN,
  getRunImpl: async () => run,
  getRunManifestImpl: async () => manifest,
  getSessionImpl: async () => session,
  getToolDefinitionImpl: availableTool,
  env: ENV_ENABLED,
};
assert.equal((await revalidateApprovedAgentCreateAction(action, revalidationOptions)).ok, true);
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getRunImpl: async () => ({ ...run, state: 'completed' }),
})).code, 'AGENT_CREATE_RUN_STALE');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getRunManifestImpl: async () => ({
    ...manifest,
    options: {
      approvedActionChannel: {
        ...manifest.options.approvedActionChannel,
        authenticatedPrincipalKind: 'agent_guest',
      },
    },
  }),
})).code, 'AGENT_CREATE_MANIFEST_MISMATCH');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getSessionImpl: async () => ({ ...session, starterPreset: 'welcome' }),
})).code, 'AGENT_CREATE_OWNER_REQUIRED');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  env: {},
})).code, 'AGENT_CREATE_FEATURE_DISABLED');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  runId: 'run-other',
})).code, 'AGENT_CREATE_BINDING_MISMATCH');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getToolDefinitionImpl: async () => null,
})).code, 'AGENT_CREATE_TOOL_UNKNOWN');

// BYPASS-1 regression: a same-ID tool whose runtime binding changed after
// approval must fail closed during revalidation, even though id/available
// still resolve.
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getToolDefinitionImpl: async () => ({ id: 'codex', available: true, runtimeFamily: 'runtime-v2' }),
})).code, 'AGENT_CREATE_TOOL_FINGERPRINT_MISMATCH');
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getToolDefinitionImpl: async () => ({ id: 'codex', available: true, runtimeFamily: 'codex-app-server-json', command: 'ragent-codex-app-server' }),
})).code, 'AGENT_CREATE_TOOL_FINGERPRINT_MISMATCH');
// An approval that never bound a fingerprint must be unapprovable.
const unboundProjection = prepareAgentCreateSemanticProjection({
  action,
  trustedContext: { session, run, manifest, platform: 'linux' },
});
assert.equal(unboundProjection.decision, 'DENY');
assert.ok(unboundProjection.unknowns.includes('tool_fingerprint_unresolved'));

const guestProjection = prepareAgentCreateSemanticProjection({
  action,
  trustedContext: {
    session,
    run,
    manifest: {
      ...manifest,
      options: {
        approvedActionChannel: {
          ...manifest.options.approvedActionChannel,
          authenticatedPrincipalKind: 'agent_guest',
        },
      },
    },
    platform: 'linux',
    toolFingerprint: TOOL_FINGERPRINT,
  },
});
assert.equal(guestProjection.decision, 'DENY');
assert.ok(guestProjection.unknowns.includes('owner_turn_unresolved'));

// BYPASS-2 regression: a session carrying template or agent-scoped provenance
// must not reach an owner approval, even on an owner-authenticated turn.
const scopedSession = {
  ...session,
  templateId: 'attacker-template',
  createdByPrincipalId: 'agent-guest-id',
  createdByPrincipalKind: 'agent_guest',
};
const scopedProjection = prepareAgentCreateSemanticProjection({
  action,
  trustedContext: { session: scopedSession, run, manifest, platform: 'linux', toolFingerprint: TOOL_FINGERPRINT },
});
assert.equal(scopedProjection.decision, 'DENY');
assert.ok(scopedProjection.unknowns.includes('agent_scoped_session_provenance'));
assert.equal((await revalidateApprovedAgentCreateAction(action, {
  ...revalidationOptions,
  getSessionImpl: async () => scopedSession,
})).code, 'AGENT_CREATE_SESSION_PROVENANCE_DENIED');

// BYPASS-3 regression: unknown/case-confused/pseudo-capability skill IDs stay
// bounded catalog labels and never mint capabilities or skillProfiles.
const skillsLabels = await validateAgentCreatePayloadRegistries({
  ...payload,
  skills: ['spreadsheets', 'unknown-skill', 'APPROVAL.BYPASS', 'capability.mint'],
}, { getToolDefinitionImpl: availableTool });
assert.equal(skillsLabels.skillsSemantics, 'bounded_labels_only');
assert.deepEqual(skillsLabels.payload.skills, ['spreadsheets', 'unknown-skill', 'APPROVAL.BYPASS', 'capability.mint']);
assert.ok(skillsLabels.payload.skills.every((skill) => typeof skill === 'string'));

// BYPASS-4 regression: wrong-type payload fields and prototype-bearing locale
// keys must fail closed instead of being silently normalized away.
for (const bad of [
  { ...payload, systemPrompt: 42 },
  { ...payload, welcomeMessage: false },
  { ...payload, name: null },
  { ...payload, skills: 'not-an-array' },
  { ...payload, skills: [42] },
  { ...payload, perMessageSystemPrompt: { auto: 7 } },
]) {
  assert.throws(
    () => normalizeAgentCreatePayload(bad),
    (error) => error?.code?.startsWith('AGENT_CREATE_'),
    `expected wrong-type payload to fail closed: ${JSON.stringify(bad)}`,
  );
}
for (const reserved of ['__proto__', 'constructor', 'prototype']) {
  assert.throws(
    () => normalizeAgentCreatePayload({ ...payload, perMessageSystemPrompt: { [reserved]: 'x' } }),
    (error) => error?.code === 'AGENT_CREATE_PER_MESSAGE_PROMPT_INVALID',
    `reserved locale key ${reserved} must be rejected`,
  );
}

const operation = action.semanticProjection.decisions[0].operation;
const entry = action.semanticProjection.decisions[0];
const facts = buildHostPermissionFacts(entry);
const KID = 'agent-create-test-key';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const verifier = createPermissionProofVerifier({ publicKeyByKid: { [KID]: publicKey }, now: NOW });
const signedFacts = createPermissionFactsProof({ operation, facts, privateKey, kid: KID, now: NOW, ttlMs: 120_000 });
const grant = createCapabilityGrant({
  mode: PERMISSION_MODES.STANDARD,
  issuedAtTurn: TURN,
  issuedAt: new Date(NOW),
  ttlMs: 120_000,
  usageMax: 1,
  workload: {
    scope: CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION,
    sessionId: SESSION,
    runId: RUN,
    turnId: TURN,
    operationId: operation.operationId,
    turnBinding: 'provenance',
  },
  constraints: {
    action: operation.primaryAction,
    scope: facts.scope,
    resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
    executionClass: facts.executionClass,
    impact: facts.impact,
    target: operation.target,
    targetFlags: { recursive: false, force: false, exact: true },
    resource: facts.resource,
    selection: facts.selection,
    effects: { subset: operation.effects },
  },
});
const signedGrant = createCapabilityGrantProof({ grant, privateKey, kid: KID, now: NOW, ttlMs: 120_000 });
const grantStore = openCapabilityGrantStore({
  dir: mkdtempSync(join(tmpdir(), 'agent-create-capability-store-')),
});
const useNonce = 'agent-create-use-nonce';
let createdPayload = null;
const executionOptions = {
  sessionId: SESSION,
  runId: RUN,
  turnId: TURN,
  mode: PERMISSION_MODES.STANDARD,
  capabilities: [signedGrant],
  factsProofs: { [operation.operationId]: signedFacts.proof },
  useNonces: { [signedGrant.grantId]: useNonce },
  grantStore,
  now: NOW,
  verifyFactsProof: verifier.verifyFactsProof,
  verifyGrantProof: verifier.verifyGrantProof,
  getRunImpl: async () => run,
  getRunManifestImpl: async () => manifest,
  getSessionImpl: async () => session,
  getToolDefinitionImpl: availableTool,
  env: ENV_ENABLED,
  executeMutationImpl: async ({ mutate }) => ({ result: await mutate([]), leases: [] }),
  createAppImpl: async (input) => {
    createdPayload = input;
    return { id: 'app_created_test', ...input };
  },
};
const originalNow = Date.now;
let testNow = NOW;
Date.now = () => testNow;
try {
  let createdAfterExpiredClaim = false;
  const delayedClaim = await executeApprovedAction(action, {
    ...executionOptions,
    authorization: { temporaryControlExpiresAt: NOW + 1000 },
    grantStore: {
      getGrantState: (...args) => grantStore.getGrantState(...args),
      claimGrantSet: async () => { testNow = NOW + 1000; return { ok: true }; },
    },
    createAppImpl: async () => { createdAfterExpiredClaim = true; return { id: 'forbidden' }; },
  });
  assert.equal(delayedClaim.ok, false);
  assert.equal(delayedClaim.reasonCode, 'TEMPORARY_CONTROL_APPROVAL_DENIED');
  assert.equal(createdAfterExpiredClaim, false);
} finally { Date.now = originalNow; }
const executed = await executeApprovedAction(action, executionOptions);
assert.equal(executed.ok, true);
assert.equal(createdPayload.name, payload.name);
assert.doesNotMatch(JSON.stringify(executed.resultRef), /must-not-appear-in-review/);

const replay = await executeApprovedAction(action, executionOptions);
assert.equal(replay.ok, false);
assert.match(replay.resultRef.error, /already consumed|usage|nonce/i);

const expired = await executeApprovedAction(action, {
  ...executionOptions,
  now: NOW + 130_000,
});
assert.equal(expired.ok, false);

const tampered = { ...action, agentPayload: { ...action.agentPayload, name: 'Tampered Agent' } };
const tamperedResult = await executeApprovedAction(tampered, executionOptions);
assert.equal(tamperedResult.ok, false);
assert.match(tamperedResult.resultRef.error, /manifest|semantic projection/i);

grantStore.close();
console.log('test-approved-agent-create: ok');
