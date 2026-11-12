#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TARGET_COMMAND_STATUSES,
  TARGET_RUNTIME_EVENT_TYPES,
  TARGET_RUNTIME_STATES,
  createLocalTargetRuntimeContext,
  createTargetCommand,
  createTargetEventDeduper,
  normalizeTargetDescriptor,
  normalizeTargetSummaryEvent,
} from '../lib/target-runtime-contract.mjs';
import { classifyTargetRuntimeRequest } from '../lib/target-runtime-policy.mjs';
import { createTargetRuntimeSummary } from '../chat/target-runtime-summary.mjs';

const fixedNow = Date.parse('2026-09-03T00:00:00.000Z');
const fixedExpiry = '2026-09-03T00:05:00.000Z';

assert.deepEqual(TARGET_RUNTIME_STATES, [
  'paired', 'connecting', 'online', 'degraded', 'offline', 'revoked',
]);
assert.deepEqual(TARGET_RUNTIME_EVENT_TYPES, ['created', 'updated', 'deleted', 'snapshot']);
assert.deepEqual(TARGET_COMMAND_STATUSES, [
  'accepted', 'queued', 'running', 'succeeded', 'failed', 'expired',
]);

const descriptor = normalizeTargetDescriptor({
  targetId: 'target-a',
  instanceId: 'instance-a',
  name: 'Office PC',
  status: 'online',
  capabilities: ['sessions', 'sessions', 'runs'],
  snapshotVersion: 12,
});
assert.deepEqual({
  targetId: descriptor.targetId,
  instanceId: descriptor.instanceId,
  label: descriptor.label,
  status: descriptor.status,
  capabilities: descriptor.capabilities,
  snapshotVersion: descriptor.snapshotVersion,
}, {
  targetId: 'target-a',
  instanceId: 'instance-a',
  label: 'Office PC',
  status: 'online',
  capabilities: ['sessions', 'runs'],
  snapshotVersion: 12,
});
assert.throws(
  () => normalizeTargetDescriptor({ targetId: 'target-a', instanceId: 'instance-a', status: 'connected' }),
  { code: 'TARGET_CONTRACT_ENUM_INVALID' },
);

const localContext = createLocalTargetRuntimeContext(
  { instanceId: 'instance-local' },
  { now: new Date(fixedNow) },
);
assert.equal(localContext.schemaVersion, 1);
assert.equal(localContext.target.targetId, 'instance-local');
assert.equal(localContext.target.instanceId, 'instance-local');
assert.equal(localContext.target.status, 'online');
assert.equal(localContext.target.lastSeenAt, '2026-09-03T00:00:00.000Z');
assert.equal('privateKey' in localContext.target, false);
assert.equal('publicKey' in localContext.target, false);

const event = normalizeTargetSummaryEvent({
  eventId: 'event-1',
  targetId: 'target-a',
  instanceId: 'instance-a',
  entityType: 'session',
  entityId: 'session-1',
  revision: 18,
  type: 'updated',
  emittedAt: '2026-09-03T00:00:00.000Z',
  summary: { title: 'A session' },
});
assert.equal(event.schemaVersion, 1);
assert.equal(event.summary.title, 'A session');
assert.throws(
  () => normalizeTargetSummaryEvent({ ...event, entityType: 'transcript' }),
  { code: 'TARGET_CONTRACT_ENUM_INVALID' },
);

const deduper = createTargetEventDeduper({ maxEntries: 2 });
assert.equal(deduper.accept(event), true);
assert.equal(deduper.accept({ ...event, revision: 19 }), false);
assert.equal(deduper.accept({ ...event, eventId: 'event-1', targetId: 'target-b' }), true);
assert.equal(deduper.has('target-a', 'event-1'), true);
assert.equal(deduper.size, 2);

const command = createTargetCommand({
  requestId: 'request-1',
  idempotencyKey: 'idempotency-1',
  targetId: 'target-a',
  operation: 'session.message',
  resourceId: 'session-1',
  expectedRevision: 18,
  expiresAt: fixedExpiry,
}, { nowMs: fixedNow });
assert.deepEqual({
  requestId: command.requestId,
  idempotencyKey: command.idempotencyKey,
  targetId: command.targetId,
  operation: command.operation,
  resourceId: command.resourceId,
  expectedRevision: command.expectedRevision,
  expiresAt: command.expiresAt,
}, {
  requestId: 'request-1',
  idempotencyKey: 'idempotency-1',
  targetId: 'target-a',
  operation: 'session.message',
  resourceId: 'session-1',
  expectedRevision: 18,
  expiresAt: fixedExpiry,
});
assert.throws(
  () => createTargetCommand({
    requestId: 'request-1',
    idempotencyKey: 'idempotency-1',
    targetId: 'target-a',
    operation: 'session.message',
    resourceId: 'session-1',
    expiresAt: fixedExpiry,
  }, { nowMs: fixedNow }),
  { code: 'TARGET_CONTRACT_FIELD_REQUIRED' },
);
assert.throws(
  () => createTargetCommand({ ...command, expiresAt: '2026-09-02T23:59:00.000Z' }, { nowMs: fixedNow }),
  { code: 'TARGET_COMMAND_EXPIRED' },
);
assert.throws(
  () => createTargetCommand({ ...command, operation: 'provider.secret.read' }, { nowMs: fixedNow }),
  { code: 'TARGET_COMMAND_OPERATION_INVALID' },
);

assert.deepEqual(classifyTargetRuntimeRequest('GET', '/api/native-provider-oauth/jobs/job-1'), {
  method: 'GET',
  path: '/api/native-provider-oauth/jobs/job-1',
  operation: 'provider.read',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/providers/profile-1/codex/mcp-servers/docs/oauth'), {
  method: 'POST', path: '/api/providers/profile-1/codex/mcp-servers/docs/oauth', operation: 'connector.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/sessions/session-1/harness-capabilities/skills'), {
  method: 'POST', path: '/api/sessions/session-1/harness-capabilities/skills', operation: 'tool.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/providers/profile-1/codex/plugin-preference'), {
  method: 'POST', path: '/api/providers/profile-1/codex/plugin-preference', operation: 'connector.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('GET', '/api/providers/profile-1/codex/plugin-preference'), {
  method: 'GET', path: '/api/providers/profile-1/codex/plugin-preference', operation: 'connector.read',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/providers/profile-1/codex/capability-sync'), {
  method: 'POST', path: '/api/providers/profile-1/codex/capability-sync', operation: 'connector.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('GET', '/api/providers/profile-1/codex/mcp-servers/docs/oauth/abcd'), {
  method: 'GET', path: '/api/providers/profile-1/codex/mcp-servers/docs/oauth/abcd', operation: 'connector.read',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/native-provider-oauth/jobs/job-1/input'), {
  method: 'POST',
  path: '/api/native-provider-oauth/jobs/job-1/input',
  operation: 'provider.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('GET', '/api/organizations/org-1/projection'), {
  method: 'GET',
  path: '/api/organizations/org-1/projection',
  operation: 'workflow.read',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/organizations/org-1/phases/phase-1/dispatch'), {
  method: 'POST',
  path: '/api/organizations/org-1/phases/phase-1/dispatch',
  operation: 'workflow.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('GET', '/api/sessions/session-1/organization/projection'), {
  method: 'GET',
  path: '/api/sessions/session-1/organization/projection',
  operation: 'workflow.read',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/project-handoffs/handoff-1/accept'), {
  method: 'POST',
  path: '/api/project-handoffs/handoff-1/accept',
  operation: 'project.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('PUT', '/api/assets/fasset_0123456789abcdef01234567/upload'), {
  method: 'PUT',
  path: '/api/assets/fasset_0123456789abcdef01234567/upload',
  operation: 'file.write',
});
assert.deepEqual(classifyTargetRuntimeRequest('POST', '/api/runs/run-1/approved-actions/batch-1/webauthn-challenge'), {
  method: 'POST',
  path: '/api/runs/run-1/approved-actions/batch-1/webauthn-challenge',
  operation: 'approval.resolve',
});
assert.equal(classifyTargetRuntimeRequest('PUT', '/api/workspace-files/content'), null);
assert.equal(classifyTargetRuntimeRequest('PUT', '/api/assets/fasset_0123456789abcdef01234567/finalize'), null);
assert.equal(classifyTargetRuntimeRequest('POST', '/api/analytics/events'), null);

const homeSummary = await createTargetRuntimeSummary({
  identity: { instanceId: 'instance-home' },
  revision: 9,
  listSessionsImpl: async () => [
    { id: 'session-old', projectId: 'project-old', updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'session-new', projectId: 'project-new', updatedAt: '2026-09-02T00:00:00.000Z' },
  ],
  listProjectsImpl: async () => [
    { id: 'project-old', name: 'Older project', rootPath: 'C:/private/older' },
    { id: 'project-new', name: 'Newer project', rootPath: 'G:/private/newer' },
  ],
  getRunImpl: async () => null,
  recordSnapshotImpl: async () => ({ revision: 9, cursor: 4, changed: false }),
});
assert.deepEqual(homeSummary.recentProjects, [
  { id: 'project-new', name: 'Newer project', updatedAt: '2026-09-02T00:00:00.000Z' },
  { id: 'project-old', name: 'Older project', updatedAt: '2026-09-01T00:00:00.000Z' },
]);
assert.equal(JSON.stringify(homeSummary.recentProjects).includes('C:/private'), false);
assert.equal(JSON.stringify(homeSummary.recentProjects).includes('G:/private'), false);

const runtimeClientSource = readFileSync(new URL('../static/chat/target-runtime-client.js', import.meta.url), 'utf8');
assert.match(runtimeClientSource, /TARGET_RUNTIME_UNAVAILABLE/);
assert.match(runtimeClientSource, /\/api\/account-policy/);
assert.match(runtimeClientSource, /\/api\/device/);
const controlRoutesSource = readFileSync(new URL('../chat/router-control-routes.mjs', import.meta.url), 'utf8');
assert.match(controlRoutesSource, /\/api\/target-runtime\/context/);
assert.match(controlRoutesSource, /createLocalTargetRuntimeContext/);

const routeTestRoot = await mkdtemp(join(tmpdir(), 'agentoc-target-runtime-route-'));
const routeConfigDir = join(routeTestRoot, 'config');
await mkdir(routeConfigDir, { recursive: true });
await writeFile(join(routeConfigDir, 'auth.json'), JSON.stringify({
  username: 'target-runtime-test-owner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');
process.env.HOME = routeTestRoot;
process.env.AGENTOC_CONFIG_DIR = routeConfigDir;
delete process.env.AGENTOC_INSTANCE_ROOT;

try {
  const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
  const response = {
    statusCode: 0,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body = '') { this.body = body; },
  };
  const writeJson = (res, statusCode, payload) => {
    res.writeHead(statusCode);
    res.end(JSON.stringify(payload));
  };
  const handled = await handleControlRoutes({
    req: { method: 'GET' },
    res: response,
    pathname: '/api/target-runtime/context',
    authSession: { role: 'owner' },
    writeJson,
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const routePayload = JSON.parse(response.body);
  assert.equal(routePayload.target.targetId, routePayload.target.instanceId);
  assert.equal(routePayload.target.status, 'online');
  assert.equal('privateKey' in routePayload.target, false);
  assert.equal('publicKey' in routePayload.target, false);

  const deniedResponse = { statusCode: 0, body: '', writeHead(statusCode) { this.statusCode = statusCode; }, end(body = '') { this.body = body; } };
  const denied = await handleControlRoutes({
    req: { method: 'GET' },
    res: deniedResponse,
    pathname: '/api/target-runtime/context',
    authSession: { role: 'visitor' },
    writeJson,
  });
  assert.equal(denied, true);
  assert.equal(deniedResponse.statusCode, 403);
} finally {
  await rm(routeTestRoot, { recursive: true, force: true });
}

console.log('test-target-runtime-contract: ok');
