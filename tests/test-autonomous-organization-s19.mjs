#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s19-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const collaboration = await import('../chat/collaboration-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const hierarchy = await import('../chat/organization-hierarchy.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (e) => e?.code === code, message); }

await store.initializeOrganizationStore();
await messaging.initializeOrganizationMessaging();
await collaboration.initializeCollaborationStore();
const org = await store.createOrganization({ id: 'org-s19-a', rootSessionId: 'root-s19-a' });
const other = await store.createOrganization({ id: 'org-s19-b', rootSessionId: 'root-s19-b' });
const manager = await store.createNode({ id: 'node-s19-manager', organizationId: org.id, stableKey: 'manager', nodeRole: 'manager', currentSessionId: 'session-manager', depth: 0, grant: { canDelegate: true, allowedCapabilities: ['read', 'write'], projectId: 'p1' } });
const otherManager = await store.createNode({ id: 'node-s19-other-manager', organizationId: other.id, stableKey: 'manager', nodeRole: 'manager', currentSessionId: 'other-session', depth: 0, grant: { canDelegate: true } });

const createdSessions = [];
const createManagedSession = async (input) => {
  const result = { sessionId: `session-${input.stableKey}`, runId: `run-${input.stableKey}` };
  createdSessions.push({ input, result });
  return result;
};

const delegated = await hierarchy.delegateHierarchicalTask({
  organizationId: org.id, revision: 1, parentNodeId: manager.id, stableKey: 'worker-a', taskId: 'task-worker-a',
  objective: 'inspect files', role: 'worker', agentId: 'agent-worker', projectId: 'p1', fromSessionId: manager.currentSessionId,
  acceptance: [{ criterion: 'tests' }], capabilityProfile: { capabilities: ['read'] }, idempotencyKey: 'delegate-worker-a',
}, { createManagedSession });
ok(delegated.node.id, 'delegation creates organization node');
equal(delegated.node.parentNodeId, manager.id, 'node retains manager parent');
equal(delegated.node.sessionClass, 'WORKER', 'worker receives worker session class');
ok(delegated.roleInstance.id, 'delegation creates role instance');
ok(delegated.edge.id, 'delegation creates organization edge');
equal(delegated.node.grant.canDelegate, false, 'delegated worker receives a non-delegating organization grant');
equal(delegated.delegationGrant.parentNodeId, manager.id, 'delegation grant points to the manager');
equal(delegated.delegationGrant.childNodeId, delegated.node.id, 'delegation grant points to the child node');
ok(delegated.attempt.id, 'delegation creates collaboration attempt');
equal(delegated.attempt.taskId, 'task-worker-a', 'attempt references canonical task');
equal(delegated.envelope.type, 'TASK_ASSIGNED', 'delegation writes assignment envelope');
equal(createdSessions.length, 1, 'managed session factory invoked once');
const duplicate = await hierarchy.delegateHierarchicalTask({
  organizationId: org.id, revision: 1, parentNodeId: manager.id, stableKey: 'worker-a', taskId: 'task-worker-a',
  objective: 'inspect files', role: 'worker', agentId: 'agent-worker', projectId: 'p1', fromSessionId: manager.currentSessionId,
  capabilityProfile: { capabilities: ['read'] }, idempotencyKey: 'delegate-worker-a',
}, { createManagedSession });
equal(duplicate.node.id, delegated.node.id, 'duplicate delegation returns same node');
equal(createdSessions.length, 1, 'duplicate delegation does not create another session');
equal((await collaboration.getCollaboration(delegated.collaboration.id)).tasks.length, 1, 'duplicate delegation does not create another task');
await rejectsCode(() => hierarchy.delegateHierarchicalTask({ organizationId: org.id, revision: 1, parentNodeId: manager.id, stableKey: 'no-factory', taskId: 'no-factory', objective: 'x', agentId: 'a', idempotencyKey: 'no-factory' }, {}), hierarchy.ORG_HIERARCHY_INVALID, 'missing managed session factory is fail closed');
await rejectsCode(() => hierarchy.delegateHierarchicalTask({ organizationId: org.id, revision: 1, parentNodeId: otherManager.id, stableKey: 'cross', taskId: 'cross', objective: 'x', agentId: 'a', idempotencyKey: 'cross' }, { createManagedSession }), hierarchy.ORG_HIERARCHY_INVALID, 'cross organization manager is rejected');
await rejectsCode(() => hierarchy.delegateHierarchicalTask({ organizationId: org.id, revision: 1, parentNodeId: manager.id, stableKey: 'wide', taskId: 'wide', objective: 'x', agentId: 'a', idempotencyKey: 'wide', capabilityProfile: { capabilities: ['admin'] } }, { createManagedSession }), hierarchy.ORG_HIERARCHY_INVALID, 'capability escalation is rejected');

const workerB = await hierarchy.delegateHierarchicalTask({ organizationId: org.id, revision: 1, parentNodeId: manager.id, stableKey: 'worker-b', taskId: 'task-worker-b', objective: 'review output', role: 'reviewer', agentId: 'agent-reviewer', fromSessionId: manager.currentSessionId, idempotencyKey: 'delegate-worker-b' }, { createManagedSession });
equal(workerB.node.grant.accessMode, 'read_only', 'reviewer delegation is read-only');
const aggregationInput = { aggregationId: 'agg-s19', organizationId: org.id, managerNodeId: manager.id, generation: 0, expectedChildNodeIds: [delegated.node.id, workerB.node.id], expectedPacketIds: ['packet-a', 'packet-b'], claimId: 'claim-1' };
const aggregation = await hierarchy.ensureManagerAggregation(aggregationInput);
equal(aggregation.state, 'pending', 'aggregation starts pending');
await rejectsCode(() => hierarchy.claimManagerAggregation(aggregationInput), hierarchy.ORG_AGGREGATION_NOT_READY, 'incomplete child barrier cannot claim');
const afterA = await hierarchy.recordChildResultPacket({ aggregationId: 'agg-s19', childNodeId: delegated.node.id, packetId: 'packet-a' });
equal(afterA.receivedPacketRefs.length, 1, 'first packet reference recorded');
const afterADupe = await hierarchy.recordChildResultPacket({ aggregationId: 'agg-s19', childNodeId: delegated.node.id, packetId: 'packet-a' });
equal(afterADupe.receivedPacketRefs.length, 1, 'duplicate packet reference is deduplicated');
await rejectsCode(() => hierarchy.recordChildResultPacket({ aggregationId: 'agg-s19', childNodeId: delegated.node.id, packetId: 'packet-unknown' }), hierarchy.ORG_HIERARCHY_INVALID, 'unknown packet is rejected');
const afterB = await hierarchy.recordChildResultPacket({ aggregationId: 'agg-s19', childNodeId: workerB.node.id, packetId: 'packet-b' });
equal(afterB.state, 'ready', 'all direct child packet references make barrier ready');
const claimed = await hierarchy.claimManagerAggregation(aggregationInput);
equal(claimed.state, 'claimed', 'ready barrier is claimed');
equal(claimed.generation, 1, 'aggregation claim advances generation');
const claimReplay = await hierarchy.claimManagerAggregation({ ...aggregationInput, generation: 1 });
equal(claimReplay.generation, 1, 'same claim replays without another generation');
await rejectsCode(() => hierarchy.claimManagerAggregation({ ...aggregationInput, claimId: 'claim-other' }), hierarchy.ORG_HIERARCHY_CONFLICT, 'stale aggregation generation is rejected');
const aggregateCalls = [];
const completed = await hierarchy.createBoundedAggregation({ aggregationId: 'agg-s19', createAggregationRun: async (input) => { aggregateCalls.push(input); return { runId: 'run-aggregation-s19' }; } });
equal(completed.state, 'completed', 'aggregation completes after callback');
equal(aggregateCalls[0].packetRefs.length, 2, 'aggregation callback receives packet refs only');
ok(aggregateCalls[0].packetRefs.every((ref) => !ref.raw && !ref.content), 'aggregation callback receives no raw child chat');
const completedReplay = await hierarchy.createBoundedAggregation({ aggregationId: 'agg-s19', createAggregationRun: async () => ({ runId: 'should-not-run' }) });
equal(completedReplay.aggregationRunId, 'run-aggregation-s19', 'completed aggregation replays same run');

const cancelCalls = [];
const cancelResult = await hierarchy.cancelOrganizationDescendants({ organizationId: org.id, rootNodeId: manager.id, reason: 'stop now' }, {
  cancelManagedSession: async (value) => cancelCalls.push(['session', value.node.id]),
  cancelCollaboration: async (value) => cancelCalls.push(['collaboration', value.nodeId]),
});
equal(cancelResult.cancelled.length, 2, 'root cancel reaches all descendants');
equal(cancelCalls.length, 4, 'root cancel invokes session and collaboration cancellation callbacks for each descendant');
equal(cancelResult.cancelled[0].envelope.type, 'CANCEL_REQUESTED', 'root cancel writes cancel envelope');
const cancelReplay = await hierarchy.cancelOrganizationDescendants({ organizationId: org.id, rootNodeId: manager.id, reason: 'stop now' }, {
  cancelManagedSession: async () => {}, cancelCollaboration: async () => {},
});
equal(cancelReplay.cancelled[0].envelope.envelopeId, cancelResult.cancelled[0].envelope.envelopeId, 'root cancel envelope replay is idempotent');

const persisted = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { getManagerAggregation } from ${JSON.stringify(new URL('../chat/organization-hierarchy.mjs', import.meta.url).href)};
  const value = await getManagerAggregation('agg-s19');
  console.log(value.state + ':' + value.aggregationRunId);
`], { env: process.env, encoding: 'utf8' }).trim();
equal(persisted, 'completed:run-aggregation-s19', 'fresh process reads aggregation facts');
equal((await messaging.listInternalEnvelopes(org.id, { deliveryState: 'pending' })).length >= 3, true, 'assignment/result/cancel envelopes are durable');
equal((await hierarchy.getManagerAggregation('agg-other')), null, 'unknown organization aggregation is absent');

console.log(`test-autonomous-organization-s19: ok (${assertions} assertions)`);
