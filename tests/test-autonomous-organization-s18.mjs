#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s18-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const gates = await import('../chat/phase-gates.mjs');
const messaging = await import('../chat/organization-messaging.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function throwsCode(fn, code, message) { assertions += 1; assert.throws(fn, (e) => e?.code === code, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (e) => e?.code === code, message); }

await store.initializeOrganizationStore();
const org = await store.createOrganization({ id: 'org-s18-a', rootSessionId: 'root-s18-a' });
const otherOrg = await store.createOrganization({ id: 'org-s18-b', rootSessionId: 'root-s18-b' });
const rootNode = await store.createNode({ id: 'node-s18-root', organizationId: org.id, stableKey: 'root', nodeRole: 'manager', currentSessionId: 'session-root', depth: 0 });
const workerNode = await store.createNode({ id: 'node-s18-worker', organizationId: org.id, stableKey: 'worker', nodeRole: 'worker', currentSessionId: 'session-worker-v1', depth: 2 });
const otherNode = await store.createNode({ id: 'node-s18-other', organizationId: otherOrg.id, stableKey: 'other', nodeRole: 'worker', currentSessionId: 'session-other', depth: 2 });
await messaging.initializeOrganizationMessaging();
equal((await messaging.listInternalEnvelopeTypes()).length, 13, 'v1 exposes all typed envelope kinds');

// Existing phase-gate rows use the old columns and remain readable after the
// additive event migration.
await store.createGate({ organizationId: org.id, phaseId: 'legacy-phase', generation: 1, state: 'passed', decision: { decision: 'passed', acceptance: [{ status: 'passed', evidenceRef: 'test:evidence' }] } });
const legacyDone = await gates.completePhase({ organizationId: org.id, phaseId: 'legacy-phase', fromGeneration: 1, expectedProgressEpoch: 0 });
const eventsAfterLegacy = await messaging.listOrganizationEvents(org.id);
equal(eventsAfterLegacy.length, 1, 'legacy phase gate event remains in the unified event table');
equal(eventsAfterLegacy[0].type, 'phase_completed', 'legacy event type is preserved');
equal(eventsAfterLegacy[0].payload.progressEpoch, 1, 'legacy payload remains readable');
equal(eventsAfterLegacy[0].eventKey, '', 'legacy event without S18 key is not rewritten');
equal(legacyDone.eventId, eventsAfterLegacy[0].id, 'legacy event id is shared');

const eventInput = { organizationId: org.id, eventKey: 'evt-s18-1', type: 'task.assigned', organizationRevision: 1, nodeId: workerNode.id, actorNodeId: rootNode.id, actorSessionId: 'session-root', payloadRef: { kind: 'task', id: 'task-1' }, payload: { taskId: 'task-1' } };
const event = await messaging.appendOrganizationEvent(eventInput);
equal(event.type, 'task.assigned', 'new event appends to existing event table');
equal(event.schemaVersion, 1, 'event schema version is explicit');
equal(event.payloadRef.kind, 'task', 'event payload ref is bounded');
equal((await messaging.appendOrganizationEvent({ ...eventInput, eventKey: 'evt-s18-1' })).id, event.id, 'event key replay returns same row');
await rejectsCode(() => messaging.appendOrganizationEvent({ ...eventInput, payload: { changed: true } }), messaging.ORG_EVENT_CONFLICT, 'event key mutation is rejected');
await rejectsCode(() => messaging.appendOrganizationEvent({ ...eventInput, eventKey: 'evt-cross', actorNodeId: otherNode.id }), messaging.ORG_EVENT_INVALID, 'cross-organization actor is rejected');
await rejectsCode(() => messaging.appendOrganizationEvent({ ...eventInput, eventKey: 'evt-bad-ref', payloadRef: { content: 'free chat' } }), messaging.ORG_EVENT_INVALID, 'event free text payload is rejected');

const envelopeInput = {
  organizationId: org.id, organizationRevision: 1, type: 'TASK_ASSIGNED',
  fromNodeId: rootNode.id, fromSessionId: 'session-root', toNodeId: workerNode.id,
  taskId: 'task-1', attemptId: 'attempt-1', payloadRef: { kind: 'task', id: 'task-1', revision: 1 },
  subject: 'Task assigned', idempotencyKey: 'env-s18-1',
};
const envelope = await messaging.enqueueInternalEnvelope(envelopeInput);
equal(envelope.deliveryState, 'pending', 'envelope starts pending');
equal(envelope.toSessionId, 'session-worker-v1', 'target resolves from current node binding');
equal((await messaging.enqueueInternalEnvelope({ ...envelopeInput, envelopeId: 'different-id' })).envelopeId, envelope.envelopeId, 'envelope idempotency replays');
await rejectsCode(() => messaging.enqueueInternalEnvelope({ ...envelopeInput, payloadRef: { kind: 'other', id: 'x' } }), messaging.ORG_ENVELOPE_CONFLICT, 'envelope idempotency conflict is rejected');
await rejectsCode(() => messaging.enqueueInternalEnvelope({ ...envelopeInput, idempotencyKey: 'env-bad-type', type: 'FREE_CHAT' }), messaging.ORG_ENVELOPE_INVALID, 'free chat envelope type is rejected');
await rejectsCode(() => messaging.enqueueInternalEnvelope({ ...envelopeInput, idempotencyKey: 'env-cross', toNodeId: otherNode.id }), messaging.ORG_ENVELOPE_INVALID, 'cross-organization receiver is rejected');
await rejectsCode(() => messaging.enqueueInternalEnvelope({ ...envelopeInput, idempotencyKey: 'env-bad-payload', payloadRef: { text: 'hello' } }), messaging.ORG_ENVELOPE_INVALID, 'free text payload ref is rejected');

const claimed = await messaging.claimInternalEnvelope(envelope.envelopeId, { expectedGeneration: 0, consumerSessionId: 'session-worker-v1', leaseMs: 30_000 });
equal(claimed.deliveryState, 'claimed', 'claim advances delivery state');
equal(claimed.deliveryGeneration, 1, 'claim advances delivery generation');
await rejectsCode(() => messaging.claimInternalEnvelope(envelope.envelopeId, { expectedGeneration: 0 }), messaging.ORG_ENVELOPE_CONFLICT, 'stale claim generation is rejected');
await rejectsCode(() => messaging.acknowledgeInternalEnvelope(envelope.envelopeId, { expectedGeneration: 1 }), messaging.ORG_ENVELOPE_CONFLICT, 'ack before delivery is rejected');
const delivered = await messaging.deliverInternalEnvelope(envelope.envelopeId, { expectedGeneration: 1, sessionId: 'session-worker-v1' });
equal(delivered.deliveryState, 'delivered', 'delivery advances only from claimed');
equal(delivered.deliveryGeneration, 2, 'delivery advances generation');
await rejectsCode(() => messaging.deliverInternalEnvelope(envelope.envelopeId, { expectedGeneration: 1 }), messaging.ORG_ENVELOPE_CONFLICT, 'duplicate delivery is rejected');
const acknowledged = await messaging.acknowledgeInternalEnvelope(envelope.envelopeId, { expectedGeneration: 2, sessionId: 'session-worker-v1' });
equal(acknowledged.deliveryState, 'acknowledged', 'ack advances only from delivered');
await rejectsCode(() => messaging.acknowledgeInternalEnvelope(envelope.envelopeId, { expectedGeneration: 3 }), messaging.ORG_ENVELOPE_CONFLICT, 'duplicate acknowledgement is rejected');

const redirectSource = await messaging.enqueueInternalEnvelope({ ...envelopeInput, idempotencyKey: 'env-redirect', envelopeId: 'env-redirect', toSessionId: 'session-worker-v1' });
await store.bindNodeSession(workerNode.id, { expectedBindingGeneration: 0, sessionId: 'session-worker-v2' });
const redirected = await messaging.resolveInternalEnvelopeTarget(redirectSource.envelopeId);
equal(redirected.toSessionId, 'session-worker-v2', 'replacement redirects pending envelope to current node session');
const claimedRedirect = await messaging.claimInternalEnvelope(redirectSource.envelopeId, { expectedGeneration: 0, consumerSessionId: 'session-worker-v2' });
equal(claimedRedirect.claimedBySessionId, 'session-worker-v2', 'replacement target can claim');

const deadSource = await messaging.enqueueInternalEnvelope({ ...envelopeInput, idempotencyKey: 'env-dead', envelopeId: 'env-dead' });
const dead = await messaging.deadLetterInternalEnvelope(deadSource.envelopeId, { expectedGeneration: 0 });
equal(dead.deliveryState, 'dead_letter', 'pending envelope can be dead-lettered');
await rejectsCode(() => messaging.acknowledgeInternalEnvelope(deadSource.envelopeId, { expectedGeneration: 1 }), messaging.ORG_ENVELOPE_CONFLICT, 'dead-lettered envelope cannot be acknowledged');
equal((await messaging.listInternalEnvelopes(org.id, { deliveryState: 'dead_letter' })).length, 1, 'envelope listing filters by organization and state');
equal((await messaging.listInternalEnvelopes(otherOrg.id)).length, 0, 'organization isolation is preserved');

const freshRead = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { getInternalEnvelope } from ${JSON.stringify(new URL('../chat/organization-messaging.mjs', import.meta.url).href)};
  const value = await getInternalEnvelope(${JSON.stringify(envelope.envelopeId)});
  console.log(value.deliveryState + ':' + value.deliveryGeneration);
`], { env: process.env, encoding: 'utf8' }).trim();
equal(freshRead, 'acknowledged:3', 'fresh process reads durable envelope state');

console.log(`test-autonomous-organization-s18: ok (${assertions} assertions)`);
