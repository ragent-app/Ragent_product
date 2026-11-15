#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s16-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const registry = await import('../chat/agent-capability-registry.mjs');
const resolver = await import('../chat/agent-resolver.mjs');
const runtime = await import('../chat/organization-runtime.mjs');
const store = await import('../chat/organization-store.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function rejectsCode(fn, code, message) {
  assertions += 1;
  return assert.rejects(fn, (error) => error?.code === code, message);
}
function throwsCode(fn, code, message) {
  assertions += 1;
  assert.throws(fn, (error) => error?.code === code, message);
}

const manager = registry.normalizeCapabilityProfile({
  id: 'manager', role: 'manager', canDelegate: true,
  capabilities: ['read', 'write', 'review'],
  allowedAgentIds: ['worker-a', 'worker-b'], allowedRoles: ['worker'],
  writablePaths: ['/repo'], workspaceScope: '/repo', projectId: 'p1',
  accessMode: 'writer', executionIsolation: 'shared',
  maxDepth: 3, maxChildren: 2, maxConcurrent: 1,
});
const workerA = registry.normalizeCapabilityProfile({
  id: 'worker-a', role: 'worker', canDelegate: true,
  capabilities: ['read', 'write'], writablePaths: ['/repo/src'],
  workspaceScope: '/repo/src', projectId: 'p1', accessMode: 'writer',
  executionIsolation: 'shared', maxDepth: 2, maxChildren: 1, maxConcurrent: 1,
});
const workerB = { ...workerA, agentId: 'worker-b' };
const legacyProfile = await registry.buildAgentCapabilityProfile({
  id: 'legacy-agent',
  name: 'Legacy Agent',
  tool: '',
}, { toolDefinition: null });

equal(manager.canDelegate, true, 'manager delegation is enabled');
equal(workerA.canDelegate, false, 'worker delegation is forced off');
equal(manager.maxDepth, 3, 'default maxDepth is bounded at 3');
equal(registry.normalizeCapabilityProfile({ id: 'reviewer', role: 'reviewer', canDelegate: true }).canDelegate, false, 'reviewer delegation is forced off');
deepEqual(manager.allowedAgentIds, ['worker-a', 'worker-b'], 'allowlist is deterministic');
deepEqual(registry.normalizeCapabilityProfile({ id: 'x', role: 'worker', capabilities: ['write', 'read', 'read'] }).capabilities, ['read', 'write'], 'capabilities are deduplicated and sorted');
equal(registry.normalizeCapabilityProfile({ id: 'x', role: 'worker', accessMode: 'read' }).accessMode, 'read_only', 'legacy read mode is normalized');
equal(legacyProfile.role, 'specialist', 'legacy Agent gets a bounded default role');
equal(legacyProfile.roleSource, 'default', 'legacy Agent role source is explicit in the projection');
equal(legacyProfile.canDelegate, false, 'legacy default role cannot delegate');

const proof = resolver.proveNoCapabilityEscalation({
  parentProfile: manager,
  request: { role: 'worker', capabilities: ['read'], writablePaths: ['/repo/src'], workspaceScope: '/repo/src', accessMode: 'read_only', executionIsolation: 'shared', maxDepth: 2, maxChildren: 1, maxConcurrent: 1 },
  childProfile: workerA,
  depth: 0,
});
ok(proof.proof.capabilitySubset, 'capability subset proof is recorded');
ok(proof.proof.scopeSubset, 'scope subset proof is recorded');
ok(proof.proof.accessModeCeiling, 'access mode proof is recorded');
equal(proof.effective.workspaceScope, '/repo/src', 'child workspace stays inside parent');
equal(proof.effective.projectId, 'p1', 'project identity is inherited');
equal(proof.effective.canDelegate, false, 'worker effective grant cannot delegate');
equal(proof.effective.maxChildren, 1, 'child quota is bounded');

throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: { ...workerA, capabilities: ['admin'] }, request: { capabilities: ['admin'] } }), resolver.ORG_CAPABILITY_ESCALATION, 'unknown capability cannot escalate');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { writablePaths: ['/outside'] } }), resolver.ORG_CAPABILITY_ESCALATION, 'writable path escape is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { workspaceScope: '/outside' } }), resolver.ORG_CAPABILITY_ESCALATION, 'workspace escape is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { projectId: 'p2' } }), resolver.ORG_CAPABILITY_ESCALATION, 'project expansion is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: { ...manager, accessMode: 'read_only' }, childProfile: workerA, request: { accessMode: 'writer' } }), resolver.ORG_CAPABILITY_ESCALATION, 'access mode escalation is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { executionIsolation: 'container' } }), resolver.ORG_CAPABILITY_ESCALATION, 'isolation change is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { maxDepth: 3 } }), resolver.ORG_MAX_DEPTH_EXCEEDED, 'depth expansion is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { maxChildren: 3 } }), resolver.ORG_CAPABILITY_ESCALATION, 'child quota expansion is rejected');
throwsCode(() => resolver.proveNoCapabilityEscalation({ parentProfile: manager, childProfile: workerA, request: { maxConcurrent: 2 } }), resolver.ORG_CAPABILITY_ESCALATION, 'concurrency expansion is rejected');
throwsCode(() => resolver.assertDelegationAllowed({ ...manager, role: 'worker' }), resolver.ORG_DELEGATION_NOT_ALLOWED, 'worker cannot delegate');
throwsCode(() => resolver.assertDelegationAllowed({ ...manager, role: 'reviewer', canDelegate: true }), resolver.ORG_DELEGATION_NOT_ALLOWED, 'reviewer cannot delegate');
throwsCode(() => resolver.assertDelegationAllowed(manager, { depth: 3 }), resolver.ORG_MAX_DEPTH_EXCEEDED, 'max depth is enforced');
throwsCode(() => resolver.assertDelegationAllowed(manager, { childCount: 2 }), resolver.ORG_OPERATION_CONFLICT, 'max children is enforced');
throwsCode(() => resolver.assertDelegationAllowed(manager, { concurrentCount: 1 }), resolver.ORG_OPERATION_CONFLICT, 'max concurrent is enforced');

const candidates = await resolver.resolveAgentCandidates({ role: 'worker', capabilities: ['read'] }, { profiles: [workerB, workerA], parentProfile: manager, parentGrant: { allowedCapabilities: ['read', 'write'], writablePaths: ['/repo/src'], workspaceScope: '/repo/src', accessMode: 'writer', executionIsolation: 'shared', maxDepth: 3, maxChildren: 1, maxConcurrent: 1 } });
equal(candidates.length, 2, 'allowlisted candidates resolve');
equal(candidates[0].profile.agentId, 'worker-a', 'tie break is stable by agent id');
await rejectsCode(() => resolver.resolveAgent({ role: 'worker', capabilities: ['read'] }, { profiles: [{ ...workerA, agentId: 'other' }], parentProfile: manager }), resolver.ORG_AGENT_NOT_ALLOWED, 'non-allowlisted candidate is rejected');
await rejectsCode(() => resolver.resolveAgent({ role: 'worker' }, { profiles: [workerA], parentProfile: { ...manager, canDelegate: false } }), resolver.ORG_DELEGATION_NOT_ALLOWED, 'non-delegating parent is rejected');
const compiled = await runtime.compileDelegationPlan({ request: { role: 'worker', capabilities: ['read'] }, parentProfile: manager, parentGrant: { allowedCapabilities: ['read', 'write'], writablePaths: ['/repo/src'], workspaceScope: '/repo/src', accessMode: 'writer', executionIsolation: 'shared', maxDepth: 3, maxChildren: 1, maxConcurrent: 1 }, profiles: [workerA] });
equal(compiled.selectedAgentId, 'worker-a', 'runtime compiler selects resolver result');
ok(compiled.proof.capabilitySubset, 'runtime compiler carries proof');

await store.initializeOrganizationStore();
const org = await store.createOrganization({ rootSessionId: 's16-root', idempotencyKey: 'org-key' });
const orgReplay = await store.createOrganization({ rootSessionId: 's16-root', idempotencyKey: 'org-key', id: 'different-org' });
equal(orgReplay.id, org.id, 'organization idempotency replays same fact');
const node = await store.createNode({ organizationId: org.id, stableKey: 'worker-a', nodeRole: 'worker', idempotencyKey: 'node-key', depth: 2, sessionClass: 'WORKER' });
equal((await store.createNode({ organizationId: org.id, stableKey: 'different', nodeRole: 'worker', idempotencyKey: 'node-key' })).id, node.id, 'node idempotency replays same fact');
const role = await store.createRoleInstance({ organizationId: org.id, organizationRevision: 1, stableKey: 'worker-a', role: 'worker', agentId: 'worker-a', idempotencyKey: 'role-key', capabilityProfile: workerA });
equal((await store.createRoleInstance({ organizationId: org.id, organizationRevision: 1, stableKey: 'other', role: 'worker', agentId: 'worker-a', idempotencyKey: 'role-key' })).id, role.id, 'role idempotency replays same fact');
const grant = await store.createDelegationGrant({ organizationId: org.id, organizationRevision: 1, parentNodeId: node.id, idempotencyKey: 'grant-key', allowedCapabilities: ['read'] });
equal((await store.createDelegationGrant({ organizationId: org.id, organizationRevision: 1, parentNodeId: node.id, idempotencyKey: 'grant-key' })).id, grant.id, 'grant idempotency replays same fact');
const edge = await store.createOrganizationEdge({ organizationId: org.id, organizationRevision: 1, stableKey: 'root-worker', parentNodeId: node.id, childNodeId: node.id, idempotencyKey: 'edge-key' });
equal((await store.createOrganizationEdge({ organizationId: org.id, organizationRevision: 1, stableKey: 'other', parentNodeId: node.id, childNodeId: node.id, idempotencyKey: 'edge-key' })).id, edge.id, 'edge idempotency replays same fact');
const bound = await store.bindNodeSession(node.id, { expectedBindingGeneration: 0, sessionId: 's16-worker', roleInstanceId: role.id });
equal(bound.bindingGeneration, 1, 'node binding advances by CAS');
await rejectsCode(() => store.bindNodeSession(node.id, { expectedBindingGeneration: 0, sessionId: 'stale' }), 'ORG_OPERATION_CONFLICT', 'stale binding generation is rejected');

console.log(`test-autonomous-organization-s16: ok (${assertions} assertions)`);
