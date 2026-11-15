#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agent-create-ingress-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED = '1';
process.env.RAGENT_PERF_WRITE_DEBOUNCE = 'off';

const {
  createSession,
  createApprovedActionWebAuthnChallenge,
  getSessionEventsPage,
  proposeApprovedActions,
  submitApprovedActionApproval,
} = await import('../chat/session-manager.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function createBoundRun(session, suffix, authenticatedPrincipalKind = 'owner') {
  const token = `token-${suffix}`;
  const runId = `run_${suffix}`;
  const turnId = `turn_${suffix}`;
  const manifest = {
    sessionId: session.id,
    requestId: turnId,
    folder: root,
    tool: 'codex',
    options: {
      approvedActionChannel: {
        tokenHash: tokenHash(token),
        turnId,
        productAgentCreate: true,
        authenticatedPrincipalKind,
      },
    },
  };
  await createRun({
    status: {
      id: runId,
      sessionId: session.id,
      requestId: turnId,
      state: 'running',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest,
  });
  await mutateSessionMeta(session.id, (draft) => {
    draft.activeRunId = runId;
    return true;
  });
  return { token, runId, turnId };
}

function proposal(binding, sessionId, name = 'Ingress Agent', tool = 'codex') {
  return {
    token: binding.token,
    tokenMatches: (provided, expectedHash) => tokenHash(provided) === expectedHash,
    requestKey: `request-${binding.runId}`,
    sessionId,
    runId: binding.runId,
    turnId: binding.turnId,
    actions: [{
      operation: 'agent.create',
      agent: {
        name,
        systemPrompt: 'Do the bounded workflow.',
        welcomeMessage: 'Send the source material.',
        tool,
        skills: ['bounded-label'],
      },
    }],
  };
}

const ownerSession = await createSession(root, 'codex', 'Create Agent', {
  starterPreset: 'create_agent',
  riskMode: 'recommended',
});
const ownerBinding = await createBoundRun(ownerSession, 'owner');
const accepted = await proposeApprovedActions(proposal(ownerBinding, ownerSession.id));
assert.equal(accepted.status, 'awaiting_approval');
assert.equal(accepted.actions.length, 1);
assert.equal(accepted.actions[0].executionClass, 'product');
assert.equal(accepted.actions[0].needsPasskey, false);
const ownerEventPage = await getSessionEventsPage(ownerSession.id, { includeBodies: true });
const ownerApprovalEvent = ownerEventPage.events.find((event) => event.type === 'approved_action_batch_request');
assert.equal(ownerApprovalEvent.actions[0].agentDefinition.name, 'Ingress Agent');
assert.equal(ownerApprovalEvent.actions[0].agentPayload, undefined);
assert.equal(ownerApprovalEvent.actions[0].semanticProjection, undefined);

const ordinaryRootSession = await createSession(root, 'codex', 'Ordinary root', {
  riskMode: 'recommended',
});
const ordinaryRootBinding = await createBoundRun(ordinaryRootSession, 'ordinary-root');
const ordinaryRootAccepted = await proposeApprovedActions(
  proposal(ordinaryRootBinding, ordinaryRootSession.id, 'Ordinary Root Agent'),
);
assert.equal(ordinaryRootAccepted.status, 'awaiting_approval');
await assert.rejects(
  createApprovedActionWebAuthnChallenge(ownerBinding.runId, accepted.batchId, {
    selectedActionIds: [],
  }),
  (error) => error?.code === 'APPROVED_ACTION_EMPTY_SELECTION',
);
await assert.rejects(
  submitApprovedActionApproval(ownerBinding.runId, accepted.batchId, {
    approvalIntent: 'approve',
    decisions: { [accepted.actions[0].actionId]: 'deny' },
  }),
  (error) => error?.code === 'APPROVED_ACTION_EMPTY_SELECTION',
);
await assert.rejects(
  submitApprovedActionApproval(ownerBinding.runId, accepted.batchId, { decisions: {} }),
  (error) => error?.code === 'APPROVED_ACTION_EMPTY_SELECTION',
);
await assert.rejects(
  submitApprovedActionApproval(ownerBinding.runId, accepted.batchId, {
    authenticatedPrincipalKind: 'trusted_device',
    decisions: { [accepted.actions[0].actionId]: 'approve' },
  }),
  (error) => error?.code === 'AGENT_CREATE_OWNER_REQUIRED',
);

const guestSession = await createSession(root, 'codex', 'Create Agent guest', {
  starterPreset: 'create_agent',
  riskMode: 'recommended',
});
const guestBinding = await createBoundRun(guestSession, 'guest', 'agent_guest');
await assert.rejects(
  proposeApprovedActions(proposal(guestBinding, guestSession.id, 'Guest Agent')),
  (error) => error?.code === 'AGENT_CREATE_NOT_AUTHORIZED',
);

await assert.rejects(
  proposeApprovedActions({
    ...proposal(ownerBinding, ownerSession.id, 'Missing Session Binding'),
    sessionId: '',
  }),
  (error) => error?.code === 'APPROVED_ACTION_BINDING_MISMATCH',
);
await assert.rejects(
  proposeApprovedActions({
    ...proposal(ownerBinding, ownerSession.id, 'Missing Turn Binding'),
    turnId: '',
  }),
  (error) => error?.code === 'APPROVED_ACTION_BINDING_MISMATCH',
);
await assert.rejects(
  proposeApprovedActions(proposal(ownerBinding, ownerSession.id, 'Unknown Tool Agent', 'missing-tool')),
  (error) => error?.code === 'AGENT_CREATE_TOOL_UNKNOWN',
);

const otherStarter = await createSession(root, 'codex', 'Welcome', {
  starterPreset: 'welcome',
  createdByPrincipalKind: 'owner',
  riskMode: 'recommended',
});
const otherBinding = await createBoundRun(otherStarter, 'other');
await assert.rejects(
  proposeApprovedActions(proposal(otherBinding, otherStarter.id, 'Wrong Starter Agent')),
  (error) => error?.code === 'AGENT_CREATE_NOT_AUTHORIZED',
);

await assert.rejects(
  proposeApprovedActions({
    ...proposal(ownerBinding, ownerSession.id, 'Mismatched Run Agent'),
    sessionId: guestSession.id,
  }),
  (error) => error?.code === 'APPROVED_ACTION_BINDING_MISMATCH',
);

console.log('test-approved-agent-create-ingress: ok');
