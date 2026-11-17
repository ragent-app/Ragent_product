// S24 owner-only organization API. Android/Web consume the projection; the
// explicit provisioning command is the only Runtime-owned mutation exposed.
import { createHash } from 'crypto';
import { access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import {
  ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  ORG_PROJECTION_V1_ENABLED,
  ORG_PROJECTION_V2_ENABLED,
} from '../lib/config.mjs';
import { readBody as readRequestBody } from '../lib/utils.mjs';
import { buildOrganizationProjection, projectionDigest } from './organization-projection.mjs';
import { attachOrganizationNodeActivities, nativeDelegationActivity } from './organization-node-activity.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { provisionRootLeadershipRevision } from './organization-provisioning.mjs';
import { getOrganization, getOrganizationByRootSession, getNode, listOrganizationNodes } from './organization-store.mjs';
import { listOrganizationEvents, getInternalEnvelope } from './organization-messaging.mjs';
import { organizationHasCreatedSubordinate } from './organization-created-subordinate.mjs';
import { verifiedBirthActor } from './organization-birth-evidence.mjs';
import { getCollaboration } from './collaboration-store.mjs';
import { recoverOrganizationDispatchEvents } from './organization-dispatch-event-recovery.mjs';
import { getRun, listDurableSessionRunIndexEntries, readRunSpoolDelta, runSpoolPath, runSpoolGzPath, runSpoolZstPath } from './runs.mjs';
import { cancelOrganizationDescendants } from './organization-hierarchy.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function writeError(res, writeJson, error) {
  const code = text(error?.code);
  const status = code === 'ORGANIZATION_NOT_FOUND' ? 404 : error?.statusCode || 400;
  writeJson(res, status, { error: error?.message || 'Organization request failed', ...(code ? { code } : {}) });
}

export async function handleOrganizationRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  readBody = readRequestBody,
  cancelDescendants = cancelOrganizationDescendants,
  provisionRevision = provisionRootLeadershipRevision,
  managedSessionFactory = createManagedSessionForNode,
  dispatchPhase = null,
}) {
  const organizationMatch = /^\/api\/organizations\/([^/]+)(?:\/(projection|cancel|provision))?$/.exec(String(pathname || ''));
  const conversationMatch = /^\/api\/organizations\/([^/]+)\/nodes\/([^/]+)\/conversation$/.exec(String(pathname || ''));
  const phaseDispatchMatch = /^\/api\/organizations\/([^/]+)\/phases\/([^/]+)\/dispatch$/.exec(String(pathname || ''));
  const rootSessionMatch = /^\/api\/sessions\/([^/]+)\/organization\/projection$/.exec(String(pathname || ''));
  const actionsMatch = /^\/api\/sessions\/([^/]+)\/organization\/actions$/.exec(String(pathname || ''));
  const nativeMatch = /^\/api\/sessions\/([^/]+)\/delegation-runs(?:\/([^/]+)\/events)?$/.exec(String(pathname || ''));
  if (!organizationMatch && !phaseDispatchMatch && !rootSessionMatch && !conversationMatch && !actionsMatch && !nativeMatch) return false;
  if (nativeMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const sessionId = decodeURIComponent(nativeMatch[1]);
      const runs = await listDurableSessionRunIndexEntries(sessionId);
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (!nativeMatch[2]) {
        writeJson(res, 200, { sessionId, runs: runs.map((run) => ({ id: run.id, state: run.state, updatedAt: run.updatedAt || null })) });
        return true;
      }
      const runId = decodeURIComponent(nativeMatch[2]);
      if (!runs.some((run) => run.id === runId && run.sessionId === sessionId)) {
        writeJson(res, 404, { error: 'Run not found' }); return true;
      }
      const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
      const afterLines = Number(url.searchParams.get('afterLines') || 0);
      if (!Number.isSafeInteger(afterLines) || afterLines < 0) { writeJson(res, 400, { error: 'Invalid cursor' }); return true; }
      const readable = (await Promise.all([runSpoolPath(runId), runSpoolGzPath(runId), runSpoolZstPath(runId)]
        .map((path) => access(path, fsConstants.R_OK).then(() => true, () => false)))).some(Boolean);
      const delta = await readRunSpoolDelta(runId, { skipLines: afterLines, maxRecords: 200, strictStatus: true });
      const run = await getRun(runId);
      const delegations = run?.sessionId === sessionId && Array.isArray(run?.providerNativeDelegation?.delegations)
        ? run.providerNativeDelegation.delegations.filter((entry) => entry.parentSessionId === sessionId && entry.parentRunId === runId && entry.delegationId)
          .map((entry) => ({ delegationId: entry.delegationId, parentDelegationId: entry.parentDelegationId || null,
            parentSessionId: sessionId, childSessionId: entry.childSessionId || entry.providerRefs?.childSessionId || null,
            provider: entry.provider || null, runId, state: entry.state, currentAction: entry.currentAction || null,
            startedAt: entry.startedAt || null, updatedAt: entry.updatedAt || null, completedAt: entry.completedAt || null,
            activity: nativeDelegationActivity(entry, run, readable && delta.readStatus === 'verified') })) : [];
      const nextAfterLines = delta.nextOffset === 0
        ? Math.max(afterLines, delta.processedLineCount || 0)
        : (delta.skippedLineCount || 0) + (delta.processedLineCount || 0);
      const events = delta.records.map((record) => record.json)
        .filter((value) => value?.type === 'ragent.delegation_event' && value.event?.parentSessionId === sessionId && value.event?.runId === runId)
        .map(({ event }) => ({ id: event.id, runId: event.runId, parentSessionId: event.parentSessionId, delegationId: event.delegationId, parentDelegationId: event.parentDelegationId || null, childSessionId: event.childSessionId || null, kind: event.kind, state: event.state, seq: event.seq, timestamp: event.timestamp, birthActor: event.kind === 'spawned' && event.provider === 'codex' && !event.parentDelegationId && event.facts?.birthActor === 'root_session' ? 'root_session' : null, details: event.facts?.candidate?.reason || event.facts?.recovery?.reason || null }));
      writeJson(res, 200, { sessionId, runId, events, delegations, nextAfterLines, hasMore: delta.truncated === true,
        sourceAvailability: readable ? delta.readStatus : 'missing',
        gap: !readable || delta.readStatus !== 'verified', recoverability: readable ? 'unknown' : 'unavailable' });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (actionsMatch) {
    if (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED) return false;
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const rootSessionId = decodeURIComponent(actionsMatch[1]);
      const org = await getOrganizationByRootSession(rootSessionId);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
      const afterId = Number(url.searchParams.get('afterId') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        writeJson(res, 400, { error: 'Invalid action cursor or limit' }); return true;
      }
      const nodes = await listOrganizationNodes(org.id);
      await recoverOrganizationDispatchEvents(org);
      const rows = await listOrganizationEvents(org.id, { afterId, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const actions = await Promise.all(page.filter((event) => ['node.created', 'task.delegated', 'task.dispatch_requested', 'result.available', 'organization.cancel_requested', 'node.session_replaced'].includes(event.type)).map(async (event) => {
        const envelope = event.envelopeId ? await getInternalEnvelope(event.envelopeId) : null;
        const collaboration = event.type === 'task.delegated' && event.payload?.collaborationId ? await getCollaboration(event.payload.collaborationId) : null;
        const task = collaboration?.rootSessionId === rootSessionId ? collaboration.tasks?.find((item) => item.id === event.taskId) : null;
        return { id: event.id, type: event.type, nodeId: event.nodeId || null, actorNodeId: verifiedBirthActor(event, nodes), taskId: event.taskId || null, attemptId: event.attemptId || null, createdAt: event.type === 'task.dispatch_requested' ? (event.payload?.requestedAt || event.createdAt) : event.createdAt,
          displayName: nodeById.get(event.nodeId)?.stableKey || null,
          summary: task?.objective || (event.type === 'task.dispatch_requested' ? event.payload?.objective : null) || (envelope?.organizationId === org.id ? envelope.subject : null),
          details: event.type === 'organization.cancel_requested' && typeof event.payload?.reason === 'string' ? event.payload.reason : null,
          operationId: null, status: ['organization.cancel_requested', 'task.dispatch_requested'].includes(event.type) ? 'requested' : null };
      }));
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, {
        rootSessionId, organizationId: org.id,
        hasCreatedSubordinate: await organizationHasCreatedSubordinate(org, nodes),
        actions,
        nextAfterId: page.at(-1)?.id || afterId,
        hasMore: rows.length > limit,
      });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (conversationMatch) {
    if (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED) return false;
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const organizationId = decodeURIComponent(conversationMatch[1]);
      const nodeId = decodeURIComponent(conversationMatch[2]);
      const org = await getOrganization(organizationId);
      const node = await getNode(nodeId);
      const available = (value) => value && value.organizationId === organizationId && value.retiredRevision === null
        && !['retired', 'deleted'].includes(String(value.lifecycleState || '').toLowerCase());
      if (!org || !available(node)) { writeJson(res, 404, { error: 'Node not found' }); return true; }
      const sessionId = node.currentSessionId || null;
      const generation = node.bindingGeneration;
      let runtimeState = 'unknown';
      if (ORG_PROJECTION_V2_ENABLED && sessionId) {
        const projection = await buildOrganizationProjection(organizationId, { version: 2 });
        const projected = projection?.nodes?.find((value) => value.id === nodeId);
        if (projected?.currentBinding?.sessionId === sessionId && projected.currentBinding.generation === generation) {
          runtimeState = projected.bindingRuntimeState || 'unknown';
        }
      }
      // This fences observed node binding changes during the projection read, not later history reads.
      const current = await getNode(nodeId);
      if (!available(current)) { writeJson(res, 404, { error: 'Node not found' }); return true; }
      if ((current.currentSessionId || null) !== sessionId || current.bindingGeneration !== generation) {
        writeJson(res, 409, { error: 'Node binding changed; refresh and retry', code: 'ORGANIZATION_BINDING_CHANGED' }); return true;
      }
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { organizationId, nodeId, currentBinding: { sessionId, generation }, runtimeState, observedAt: new Date().toISOString() });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (phaseDispatchMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    let payload = {};
    try {
      const rawBody = await readBody(req, 32 * 1024);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
      return true;
    }
    const organizationId = decodeURIComponent(phaseDispatchMatch[1]);
    const phaseId = decodeURIComponent(phaseDispatchMatch[2]);
    const revision = typeof payload.revision === 'string' && payload.revision.trim() ? Number(payload.revision) : payload.revision;
    const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
    try {
      const dispatcher = dispatchPhase || (await import('./organization-phase-dispatch.mjs')).dispatchOrganizationPhase;
      const result = await dispatcher({ organizationId, phaseId, revision, idempotencyKey });
      writeJson(res, 200, { dispatch: result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  const action = organizationMatch ? (organizationMatch[2] || '') : 'projection';
  const projectionEnabled = ORG_PROJECTION_V1_ENABLED || ORG_PROJECTION_V2_ENABLED;
  if (action === 'provision' ? !ORG_AUTONOMOUS_PROVISIONING_ENABLED : !projectionEnabled) return false;
  if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
  const requestedId = decodeURIComponent(organizationMatch ? organizationMatch[1] : rootSessionMatch[1]);
  try {
    const org = organizationMatch
      ? await getOrganization(requestedId)
      : await getOrganizationByRootSession(requestedId);
    if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
    if (req.method === 'GET' && (action === '' || action === 'projection')) {
      const requestUrl = req.url ? new URL(req.url, `http://${req.headers?.host || 'localhost'}`) : null;
      const sinceEventId = requestUrl ? Number(requestUrl.searchParams.get('sinceEventId') || 0) : 0;
      const cachedProjection = await buildOrganizationProjection(org.id, {
        version: ORG_PROJECTION_V2_ENABLED ? 2 : 1,
        sinceEventId: Number.isInteger(sinceEventId) && sinceEventId >= 0 ? sinceEventId : 0,
      });
      const projection = await attachOrganizationNodeActivities(cachedProjection, org.id);
      projection.digest = projectionDigest(projection);
      if (projection.asOf) projection.asOf = { ...projection.asOf, projectionDigest: projection.digest };
      const etag = `"${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}"`;
      if (req.headers?.['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return true; }
      res.setHeader?.('ETag', etag);
      res.setHeader?.('X-Organization-Projection-Schema', String(projection.schemaVersion));
      writeJson(res, 200, { projection });
      return true;
    }
    if (req.method === 'POST' && action === 'cancel') {
      const rootNodeId = text(req.headers?.['x-organization-root-node-id']);
      if (!rootNodeId) { writeJson(res, 400, { error: 'root node id is required', code: 'ORG_PROJECTION_INVALID' }); return true; }
      const result = await cancelDescendants({ organizationId: org.id, rootNodeId, reason: 'cancelled by owner' });
      writeJson(res, 200, { cancelled: result.cancelled?.length || 0 });
      return true;
    }
    if (req.method === 'POST' && action === 'provision') {
      let payload = {};
      try {
        const rawBody = await readBody(req, 32 * 1024);
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
        return true;
      }
      const revision = typeof payload.revision === 'string' && payload.revision.trim()
        ? Number(payload.revision)
        : payload.revision;
      if (!Number.isInteger(revision) || revision < 1) {
        writeJson(res, 400, { error: 'revision must be a positive integer', code: 'ORG_PROVISIONING_REVISION_INVALID' });
        return true;
      }
      const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
      if (!idempotencyKey) {
        writeJson(res, 400, { error: 'idempotencyKey is required', code: 'ORG_PROVISIONING_IDEMPOTENCY_REQUIRED' });
        return true;
      }
      const result = await provisionRevision({
        organizationId: org.id,
        revision,
        idempotencyKey,
        createManagedSession: managedSessionFactory,
      });
      writeJson(res, result?.attempted === false ? 503 : 200, { provisioning: result });
      return true;
    }
    writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeError(res, writeJson, error); }
  return true;
}
