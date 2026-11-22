#!/usr/bin/env node
// S21 provisioning contract test: turning a Frozen Revision into real managed
// Sessions. Verifies the materialization order contract (parent node before
// child, node ID before the session factory), idempotent replay, fail-closed
// paths, the command-surface flag gate, and the real factory's fail-closed
// behavior without a running provider.
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-provisioning-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const planner = await import('../chat/organization-planner.mjs');
const provisioning = await import('../chat/organization-provisioning.mjs');
const factory = await import('../chat/organization-managed-session-factory.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function rejectsCode(fn, code, message) { assertions += 1; return assert.rejects(fn, (error) => error?.code === code, message); }

await store.initializeOrganizationStore();

const profiles = [
  { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
  { agentId: 'worker', role: 'worker', capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  { agentId: 'reviewer', role: 'reviewer', capabilities: ['review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
];
const proposal = {
  schemaVersion: 1, proposalId: 'provision-proposal', idempotencyKey: 'provision-proposal', objective: 'provision a team',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage', 'review'], phaseId: 'p1', acceptance: [{ criterion: 'lead' }] },
    { stableKey: 'worker', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'p1', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'reviewer', role: 'reviewer', agentId: 'reviewer', capabilities: ['review'], phaseId: 'p1', parentKey: 'lead', dependsOn: ['worker'] },
  ],
  phases: [{ phaseId: 'p1', objective: 'build', acceptance: [{ criterion: 'tests' }], reviewerRoles: ['reviewer'] }],
  manages: [{ parentKey: 'lead', childKey: 'worker' }, { parentKey: 'lead', childKey: 'reviewer' }],
  reviewPolicy: { required: true, minReviewers: 1 }, acceptance: [{ criterion: 'result' }], budget: { maxNodes: 6 },
};

const org = await store.createOrganization({ id: 'org-provision', rootSessionId: 'root-provision', idempotencyKey: 'org-provision' });
const compiled = await planner.compileOrganizationProposal(proposal, { profiles });
const revision = await store.createRevisionAtHead(org.id, {
  expectedCurrentRevision: 0,
  proposal: compiled.proposal,
  compiled: compiled.compiled,
  digest: compiled.digest,
  idempotencyKey: 'provision-proposal',
});
const frozen = await store.freezeRevision(org.id, revision.revision);
equal(frozen.state, 'frozen', 'revision is frozen before provisioning');

const factoryCalls = [];
const mockFactory = async (input) => {
  factoryCalls.push(input);
  return { sessionId: `session-${input.stableKey}`, runId: `run-${input.stableKey}` };
};

const result = await provisioning.provisionFrozenRevision({
  organizationId: org.id,
  revision: revision.revision,
  createManagedSession: mockFactory,
});
equal(result.state, 'provisioned', 'provisioning reports provisioned');
equal(result.createdManagedSessions, 3, 'one managed session per compiled node');
equal(factoryCalls.length, 3, 'factory runs once per node');

// Materialization order contract: lead (no parent) first, then its children,
// and every session factory call receives the node ID that was already created.
const callOrder = factoryCalls.map((call) => call.stableKey);
deepEqual(callOrder, ['lead', 'worker', 'reviewer'], 'nodes materialize topologically (parent before child)');
for (const call of factoryCalls) {
  const node = await store.getNode(call.organizationNodeId);
  ok(node && node.stableKey === call.stableKey, `factory binds the created node ID for ${call.stableKey}`);
  equal(call.organizationRevision, revision.revision, `factory receives the frozen revision for ${call.stableKey}`);
  equal(call.sessionClass, call.role === 'reviewer' ? 'REVIEWER' : call.role === 'manager' ? 'MANAGER' : 'WORKER', `sessionClass matches role for ${call.stableKey}`);
}
equal(factoryCalls[1].parentSessionId, 'session-lead', 'worker binds to the materialized lead session');
equal(factoryCalls[2].parentSessionId, 'session-lead', 'reviewer binds to the materialized lead session');

const nodes = await store.listOrganizationNodes(org.id);
const leadNode = nodes.find((node) => node.stableKey === 'lead');
const workerNode = nodes.find((node) => node.stableKey === 'worker');
const reviewerNode = nodes.find((node) => node.stableKey === 'reviewer');
equal(leadNode.depth, 0, 'lead is the root node');
equal(workerNode.depth, 1, 'worker sits at depth 1');
equal(reviewerNode.depth, 1, 'reviewer sits at depth 1');
equal(leadNode.currentSessionId, 'session-lead', 'lead session is bound');
equal(workerNode.currentSessionId, 'session-worker', 'worker session is bound');
equal(reviewerNode.currentSessionId, 'session-reviewer', 'reviewer session is bound');
equal(leadNode.bindingGeneration, 1, 'lead binding generation advances once');
const edges = await store.listOrganizationEdges(org.id);
equal(edges.length, 2, 'MANAGES edges are materialized for every parent->child pair');
ok(edges.some((edge) => edge.parentNodeId === leadNode.id && edge.childNodeId === workerNode.id), 'lead MANAGES worker edge exists');
ok(edges.some((edge) => edge.parentNodeId === leadNode.id && edge.childNodeId === reviewerNode.id), 'lead MANAGES reviewer edge exists');
const delegationGrants = await store.listDelegationGrants(org.id, { revision: revision.revision });
equal(delegationGrants.length, 2, 'provisioning materializes one DelegationGrant per MANAGES edge');
const workerDelegationGrant = delegationGrants.find((grant) => grant.childNodeId === workerNode.id);
const reviewerDelegationGrant = delegationGrants.find((grant) => grant.childNodeId === reviewerNode.id);
equal(workerDelegationGrant.parentNodeId, leadNode.id, 'worker DelegationGrant points to its manager');
equal(workerDelegationGrant.canDelegate, false, 'worker DelegationGrant cannot delegate');
equal(reviewerDelegationGrant.accessMode, 'read_only', 'reviewer DelegationGrant is read-only');
equal(reviewerDelegationGrant.canDelegate, false, 'reviewer DelegationGrant cannot delegate');

// Idempotent replay: a second provision run converges without new facts.
const replayCalls = [];
const replayResult = await provisioning.provisionFrozenRevision({
  organizationId: org.id,
  revision: revision.revision,
  createManagedSession: async (input) => { replayCalls.push(input); return { sessionId: `session-${input.stableKey}` }; },
});
equal(replayResult.createdManagedSessions, 0, 'replay provisions nothing new');
equal(replayCalls.length, 0, 'replay does not call the session factory');
equal((await store.listOrganizationNodes(org.id)).length, 3, 'replay does not duplicate nodes');
equal((await store.listOrganizationEdges(org.id)).length, 2, 'replay does not duplicate edges');

// Crash recovery: a node may be durable before its managed Session is. A
// replay must resume that node, then continue with the remaining topology.
const recoveryOrg = await store.createOrganization({ id: 'org-provision-recovery', rootSessionId: 'root-provision-recovery', idempotencyKey: 'org-provision-recovery' });
const recoveryRevision = await store.createRevisionAtHead(recoveryOrg.id, {
  expectedCurrentRevision: 0,
  proposal: compiled.proposal,
  compiled: compiled.compiled,
  digest: compiled.digest,
  idempotencyKey: 'provision-recovery',
});
await store.freezeRevision(recoveryOrg.id, recoveryRevision.revision);
await rejectsCode(() => provisioning.provisionFrozenRevision({
  organizationId: recoveryOrg.id,
  revision: recoveryRevision.revision,
  idempotencyKey: 'recovery-first-attempt',
  createManagedSession: async () => { throw new Error('injected crash before session binding'); },
}), 'ORG_PROVISIONING_SESSION_FACTORY_FAILED', 'factory failure leaves a durable partial node');
const partialRecoveryNode = await store.getNodeByStableKey(recoveryOrg.id, 'lead');
equal(partialRecoveryNode.currentSessionId, '', 'partial node has no session binding after injected failure');
const recoveryCalls = [];
const recovered = await provisioning.provisionFrozenRevision({
  organizationId: recoveryOrg.id,
  revision: recoveryRevision.revision,
  idempotencyKey: 'recovery-retry-with-a-new-request-key',
  createManagedSession: async (input) => {
    recoveryCalls.push(input);
    return { sessionId: `recovered-${input.stableKey}` };
  },
});
equal(recovered.createdManagedSessions, 3, 'replay repairs the partial node and provisions the rest');
equal(recoveryCalls.length, 3, 'recovery invokes the factory once per unbound node');
equal((await store.getNodeByStableKey(recoveryOrg.id, 'lead')).currentSessionId, 'recovered-lead', 'recovery binds the existing lead node');
equal((await store.listOrganizationNodes(recoveryOrg.id)).length, 3, 'recovery does not duplicate nodes');
equal((await store.listOrganizationEdges(recoveryOrg.id)).length, 2, 'recovery recreates the missing hierarchy edges only once');

// Fail-closed: no factory.
await rejectsCode(() => provisioning.provisionFrozenRevision({ organizationId: org.id, revision: revision.revision }), 'ORG_PROVISIONING_FACTORY_REQUIRED', 'missing factory fails closed');

// Fail-closed: non-frozen revision cannot be provisioned.
const draftCompiled = await planner.compileOrganizationProposal({ ...proposal, idempotencyKey: 'provision-draft', proposalId: 'provision-draft' }, { profiles });
await store.createRevisionAtHead(org.id, {
  expectedCurrentRevision: 1,
  proposal: draftCompiled.proposal,
  compiled: draftCompiled.compiled,
  digest: draftCompiled.digest,
  idempotencyKey: 'provision-draft',
});
await rejectsCode(() => provisioning.provisionFrozenRevision({ organizationId: org.id, revision: 2, createManagedSession: mockFactory }), 'ORG_PROVISIONING_REVISION_NOT_FROZEN', 'draft revision cannot be provisioned');

// Command surface: gated on ORG_AUTONOMOUS_PROVISIONING_ENABLED (probed in a
// child process with the flag off so the module import sees it).
const commandSurfaceUrl = new URL('../chat/organization-provisioning.mjs', import.meta.url).href;
const childOut = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { provisionRootLeadershipRevision } from ${JSON.stringify(commandSurfaceUrl)};
  const out = await provisionRootLeadershipRevision({ organizationId: 'org-x', revision: 1, createManagedSession: async () => ({ sessionId: 'x' }) });
  console.log(JSON.stringify(out));
`], {
  env: {
    ...process.env,
    RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED: '',
  },
  encoding: 'utf8',
}).trim().split('\n').at(-1);
const childResult = JSON.parse(childOut);
equal(childResult.skipped, 'ORG_PROVISIONING_DISABLED', 'command surface skips when provisioning flag is off');

// Real factory fail-closed paths (no running provider needed).
await rejectsCode(() => factory.createManagedSessionForNode({ organizationId: 'org-missing', agentId: 'lead' }), 'ORGANIZATION_NOT_FOUND', 'factory rejects a missing organization');
await rejectsCode(() => factory.createManagedSessionForNode({
  organizationId: org.id,
  organizationRevision: 1,
  organizationNodeId: 'node-x',
  roleInstanceId: 'role-x',
  stableKey: 'worker',
  role: 'worker',
  agentId: 'no-such-agent',
  sessionClass: 'WORKER',
}), 'ORG_PROVISIONING_AGENT_TOOL_MISSING', 'factory fails closed when the Agent has no provider tool');
await rejectsCode(() => factory.createManagedSessionForNode({
  organizationId: org.id,
  organizationRevision: 1,
  organizationNodeId: 'node-x',
  roleInstanceId: 'role-x',
  stableKey: 'worker',
  role: 'worker',
  agentId: 'chat',
  sessionClass: 'WORKER',
}), 'ORG_PROVISIONING_ROOT_SESSION_NOT_FOUND', 'factory fails closed when the Root Session is missing');

// The real factory must reuse the same durable Session when a response is
// lost after createSession but before the organization node is bound.
const sessionManager = await import('../chat/session-manager.mjs');
const realRoot = await sessionManager.createSession(join(tempHome, 'workspace'), 'claude', 'Provisioning Root', {
  sessionPlane: 'user',
  sessionClass: 'ROOT_LEADERSHIP',
});
const realOrg = await store.createOrganization({ id: 'org-real-factory', rootSessionId: realRoot.id, idempotencyKey: 'org-real-factory' });
const firstManaged = await factory.createManagedSessionForNode({
  organizationId: realOrg.id,
  organizationRevision: 1,
  organizationNodeId: 'real-node-worker',
  roleInstanceId: 'real-role-worker',
  stableKey: 'worker',
  role: 'worker',
  agentId: 'chat',
  sessionClass: 'WORKER',
  idempotencyKey: 'real-session-request-1',
  replacementKey: 'real-session-replacement',
});
const replayedManaged = await factory.createManagedSessionForNode({
  organizationId: realOrg.id,
  organizationRevision: 1,
  organizationNodeId: 'real-node-worker',
  roleInstanceId: 'real-role-worker',
  stableKey: 'worker',
  role: 'worker',
  agentId: 'chat',
  sessionClass: 'WORKER',
  idempotencyKey: 'real-session-request-2',
  replacementKey: 'real-session-replacement',
});
equal(replayedManaged.sessionId, firstManaged.sessionId, 'replacement key replays the same managed Session');
equal((await sessionManager.getSession(firstManaged.sessionId)).organizationNodeId, 'real-node-worker', 'replayed Session keeps organization lineage');
equal(factory.normalizeManagedSessionName('worker', 'w1'), 'org:worker:w1', 'managed session name is deterministic');

// Root session riskMode inheritance (Item 1a regression).
const recommendedRoot = await sessionManager.createSession(join(tempHome, 'workspace'), 'claude', 'Recommended Root', {
  sessionPlane: 'user',
  sessionClass: 'ROOT_LEADERSHIP',
  riskMode: 'recommended',
});
const recommendedOrg = await store.createOrganization({
  id: 'org-risk-inherit-rec',
  rootSessionId: recommendedRoot.id,
  idempotencyKey: 'org-risk-inherit-rec',
});
const recommendedManaged = await factory.createManagedSessionForNode({
  organizationId: recommendedOrg.id,
  organizationRevision: 1,
  organizationNodeId: 'node-rec-1',
  roleInstanceId: 'role-rec-1',
  stableKey: 'lead',
  role: 'manager',
  agentId: 'chat',
  sessionClass: 'MANAGER',
  idempotencyKey: 'rec-risk-1',
});
equal((await sessionManager.getSession(recommendedManaged.sessionId)).riskMode, 'recommended', 'managed node session inherits recommended riskMode instead of falling back to full-auto');

const explicitFullAutoRoot = await sessionManager.createSession(join(tempHome, 'workspace'), 'claude', 'FullAuto Root', {
  sessionPlane: 'user',
  sessionClass: 'ROOT_LEADERSHIP',
  riskMode: 'full-auto',
  riskModeExplicit: true,
});
const explicitFullAutoOrg = await store.createOrganization({
  id: 'org-risk-inherit-full',
  rootSessionId: explicitFullAutoRoot.id,
  idempotencyKey: 'org-risk-inherit-full',
});
const explicitFullAutoManaged = await factory.createManagedSessionForNode({
  organizationId: explicitFullAutoOrg.id,
  organizationRevision: 1,
  organizationNodeId: 'node-full-1',
  roleInstanceId: 'role-full-1',
  stableKey: 'writer',
  role: 'specialist',
  agentId: 'chat',
  sessionClass: 'WORKER',
  idempotencyKey: 'full-risk-1',
});
const fullAutoChildMeta = await sessionManager.getSession(explicitFullAutoManaged.sessionId);
equal(fullAutoChildMeta.riskMode, 'full-auto', 'explicit full-auto root preserves full-auto on managed child');
equal(fullAutoChildMeta.riskModeExplicit, true, 'explicit full-auto flag is preserved on managed child');

const unexplicitClamped = factory.inheritSessionRiskOptions({ riskMode: 'full-auto', riskModeExplicit: false });
equal(unexplicitClamped.riskMode, 'recommended', 'unexplicit full-auto root clamps managed child to recommended');
equal(unexplicitClamped.riskModeExplicit, undefined, 'clamped full-auto clears riskModeExplicit');

const consultManaged = await factory.createManagedSessionForConsultation({
  rootSessionId: recommendedRoot.id,
  consultationRoundId: 'round-rec-1',
  expertAssignmentId: 'assign-rec-1',
  controllerSessionId: recommendedRoot.id,
  agentId: 'chat',
  role: 'specialist',
  sessionClass: 'WORKER',
  idempotencyKey: 'consult-rec-1',
});
equal((await sessionManager.getSession(consultManaged.sessionId)).riskMode, 'recommended', 'consultation managed session also inherits recommended riskMode');

console.log(`test-organization-provisioning: ok (${assertions} assertions)`);
