// S24: the read-only OrganizationProjection contract for Web and Android.
// The builder consumes bounded organization facts and never exposes raw policy,
// grants, budget internals, envelopes, prompts, or Session history.
import { createHash } from 'crypto';
import { canonicalJson } from './execution-scope.mjs';
import { getOrganization, getRevision, listOrganizationNodes, listOrganizationEdges, listOrganizationGates } from './organization-store.mjs';
import { listOrganizationEvents, listInternalEnvelopes } from './organization-messaging.mjs';
import { organizationHasCreatedSubordinate } from './organization-created-subordinate.mjs';
import { verifiedBirthActor } from './organization-birth-evidence.mjs';
import { getBudgetCounter } from './organization-governor.mjs';
import { collectOrganizationStatus } from './organization-status-projection.mjs';
import { reconcileReviewOptionalPhaseCompletions } from './organization-phase-completion.mjs';
import { getOrganizationRuntimeCapabilities } from './organization-runtime-capabilities.mjs';
import {
  organizationProjectionCache,
  organizationProjectionInflight,
  invalidateOrganizationProjectionCache,
  organizationProjectionGeneration,
} from './organization-projection-cache.mjs';

export const ORGANIZATION_PROJECTION_SCHEMA_VERSION = 1;
export const ORGANIZATION_PROJECTION_V2_SCHEMA_VERSION = 2;
export const ORGANIZATION_PROJECTION_INVALID = 'ORG_PROJECTION_INVALID';
const MAX_ITEMS = 200;

function error(message, details = {}) {
  return Object.assign(new Error(message), { code: ORGANIZATION_PROJECTION_INVALID, statusCode: 400, ...details });
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value, fallback = 0) { return Number.isInteger(value) ? value : fallback; }
function clone(value, fallback = null) { try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; } }
function digest(value) { return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`; }
function bounded(list) { return Array.isArray(list) ? list.slice(0, MAX_ITEMS) : []; }

function publicNode(node, edgeByChild = new Map(), display = {}) {
  return {
    id: node.id,
    parentId: edgeByChild.get(node.id) || null,
    role: node.nodeRole,
    currentBinding: { sessionId: node.currentSessionId || null, generation: node.bindingGeneration },
    domain: typeof display.domain === 'string' && [...display.domain].length <= 160 ? display.domain : null,
    iconKey: typeof display.iconKey === 'string' && [...display.iconKey].length <= 64 ? display.iconKey : null,
    displayName: typeof display.displayName === 'string' && [...display.displayName].length <= 160 ? display.displayName : '',
    responsibility: typeof display.responsibility === 'string' && [...display.responsibility].length <= 1000 ? display.responsibility : null,
    sessionClass: node.sessionClass || '',
    status: node.lifecycleState,
    currentActivity: node.currentSessionId ? 'bound' : 'unbound',
    currentTask: null,
    progress: { state: node.lifecycleState, epoch: 0 },
    reviewState: node.nodeRole === 'reviewer' ? 'reviewer' : 'not_applicable',
  };
}

function publicEvent(event, nodes) {
  return {
    id: event.id,
    type: event.type,
    revision: event.organizationRevision ?? null,
    phaseId: event.phaseId || null,
    nodeId: event.nodeId || null,
    actorNodeId: verifiedBirthActor(event, nodes),
    taskId: event.taskId || null,
    attemptId: event.attemptId || null,
    packetId: event.packetId || null,
    createdAt: event.createdAt,
  };
}

function publicPhase(phase, phaseEvents = []) {
  const completed = phaseEvents.some((event) => event.type === 'phase.completed' || event.type === 'phase_completed');
  return {
    phaseId: phase.phaseId,
    objective: phase.objective,
    state: completed ? 'completed' : 'active',
    dependsOn: [...(phase.dependsOn || [])].sort(),
    acceptance: bounded((phase.acceptance || []).map((entry) => ({
      criterion: entry.criterion,
      evidenceRequired: entry.evidenceRequired !== false,
    }))),
    reviewRequired: phase.reviewRequired !== false,
    reviewState: completed ? 'complete' : 'pending',
  };
}

function deriveV2Phases(phases = []) {
  if (!Array.isArray(phases)) return [];
  return phases.map((phase) => {
    if (!phase || typeof phase !== 'object') return phase;
    const total = Number(phase.progress?.total || 0);
    const completed = Number(phase.progress?.completed || 0);
    const blocked = Number(phase.progress?.blocked || 0);
    const activeTasks = Number(phase.progress?.activeTasks || 0);
    const gateState = text(phase.gate?.state);
    if (
      phase.state === 'planned'
      && total > 0
      && completed === total
      && blocked === 0
      && activeTasks === 0
      && !['open', 'decided', 'needs_changes'].includes(gateState)
    ) {
      return {
        ...phase,
        state: 'completed',
      };
    }
    return phase;
  });
}

export function projectionDigest(projection) {
  const copy = clone(projection, {});
  delete copy.digest;
  if (copy.asOf && typeof copy.asOf === 'object') delete copy.asOf.projectionDigest;
  return digest(copy);
}

async function buildOrganizationProjectionUncached(organizationId, {
  maxItems = MAX_ITEMS,
  version = ORGANIZATION_PROJECTION_SCHEMA_VERSION,
  sinceEventId = 0,
  organization = null,
} = {}) {
  const org = organization || await getOrganization(organizationId);
  if (!org) return null;
  const v2 = Number(version) >= ORGANIZATION_PROJECTION_V2_SCHEMA_VERSION;
  const revision = org.currentRevision ? await getRevision(org.id, org.currentRevision) : null;
  const compiled = revision?.compiled || {};
  const nodes = await listOrganizationNodes(org.id);
  const edges = await listOrganizationEdges(org.id, { revision: null });
  const itemLimit = Math.min(MAX_ITEMS, Math.max(1, integer(maxItems, MAX_ITEMS)));
  let eventHistory = await listOrganizationEvents(org.id, {
    limit: v2 ? 5000 : itemLimit,
    // V2 status/changes are explicitly recent; fetch the tail directly so a
    // long-lived organization does not waste the 5k-event window on its
    // oldest history.
    latest: v2,
  });
  let events = v2 ? eventHistory.slice(-itemLimit) : eventHistory.slice(0, itemLimit);
  const envelopes = await listInternalEnvelopes(org.id, { limit: Math.min(MAX_ITEMS, Math.max(1, integer(maxItems, MAX_ITEMS))) });
  const counter = org.currentRevision ? await getBudgetCounter(org.id, org.currentRevision) : null;
  const edgeByChild = new Map(edges.filter((edge) => edge.edgeType === 'MANAGES').map((edge) => [edge.childNodeId, edge.parentNodeId]));
  const displayNodes = new Map((revision?.state === 'frozen' && Array.isArray(compiled.nodes) ? compiled.nodes : []).map((node) => [node.stableKey, node]));
  const safeNodes = bounded(nodes).map((node) => publicNode(node, edgeByChild, displayNodes.get(node.stableKey)));
  const safeEdges = bounded(edges).map((edge) => ({
    id: edge.id, type: edge.edgeType, parentId: edge.parentNodeId, childId: edge.childNodeId, revision: edge.organizationRevision,
  }));
  let safeEvents = bounded(events).map((event) => publicEvent(event, nodes));
  const eventsByPhase = new Map();
  for (const event of eventHistory) {
    const phaseId = text(event?.phaseId);
    if (!phaseId) continue;
    const phaseEvents = eventsByPhase.get(phaseId) || [];
    phaseEvents.push(event);
    eventsByPhase.set(phaseId, phaseEvents);
  }
  const activeCommunications = bounded(envelopes.filter((envelope) => ['pending', 'claimed', 'delivered'].includes(envelope.deliveryState)).map((envelope) => ({
    id: envelope.envelopeId, type: envelope.type, fromNodeId: envelope.fromNodeId, toNodeId: envelope.toNodeId,
    state: envelope.deliveryState, revision: envelope.organizationRevision, createdAt: envelope.createdAt,
  })));
  const phases = bounded(Array.isArray(compiled.phases) ? compiled.phases : [])
    .map((phase) => publicPhase(phase, eventsByPhase.get(phase.phaseId) || []));
  const gates = v2 ? await listOrganizationGates(org.id) : [];
  let status = v2 ? await collectOrganizationStatus({
    organizationId: org.id,
    organization: org,
    revision,
    nodes,
    events: eventHistory,
    gates,
  }) : null;
  const reviewOptionalDisabled = (compiled?.reviewPolicy?.required === false || revision?.proposal?.reviewPolicy?.required === false);
  if (v2 && status && revision?.state === 'frozen' && reviewOptionalDisabled) {
    const completedEventPhases = new Set(
      eventHistory
        .filter((event) => ['phase.completed', 'phase_completed'].includes(event?.type))
        .map((event) => text(event?.phaseId))
        .filter(Boolean),
    );
    const candidatePhaseIds = (status.phases || [])
      .filter((phase) => (
        !completedEventPhases.has(text(phase.phaseId))
        && Number(phase.progress?.total || 0) > 0
        && Number(phase.progress?.completed || 0) === Number(phase.progress?.total || 0)
        && Number(phase.progress?.blocked || 0) === 0
        && Number(phase.progress?.activeTasks || 0) === 0
        && !['open', 'decided', 'needs_changes'].includes(text(phase.gate?.state))
      ))
      .map((phase) => text(phase.phaseId))
      .filter(Boolean);
    if (candidatePhaseIds.length > 0) {
      const persisted = await reconcileReviewOptionalPhaseCompletions({
        organizationId: org.id,
        revision: org.currentRevision,
        phaseIds: candidatePhaseIds,
        allowPendingAggregation: false,
        organization: org,
        revisionRow: revision,
        nodes,
        gates,
        events: eventHistory,
        status,
      });
      if (persisted.length > 0) {
        eventHistory = await listOrganizationEvents(org.id, { limit: 5000, latest: true });
        events = eventHistory.slice(-itemLimit);
        safeEvents = bounded(events).map((event) => publicEvent(event, nodes));
        status = await collectOrganizationStatus({
          organizationId: org.id,
          organization: org,
          revision,
          nodes,
          events: eventHistory,
          gates,
        });
      }
    }
  }
  const progress = {
    epoch: org.progressEpoch,
    state: org.state,
  };
  const projection = {
    schemaVersion: v2 ? ORGANIZATION_PROJECTION_V2_SCHEMA_VERSION : ORGANIZATION_PROJECTION_SCHEMA_VERSION,
    organizationId: org.id,
    rootSessionId: org.rootSessionId,
    hasCreatedSubordinate: await organizationHasCreatedSubordinate(org, nodes),
    revision: revision ? { number: revision.revision, digest: revision.digest, state: revision.state } : null,
    objective: text(compiled.objective || revision?.proposal?.objective || ''),
    state: status?.state || org.state,
    progress: status ? { ...progress, state: status.state } : progress,
    nodes: status?.nodes || safeNodes,
    edges: safeEdges,
    phases: status?.phases ? deriveV2Phases(status.phases) : phases,
    activeCommunications,
    blockers: status?.blockers || bounded(events.filter((event) => ['blocker.reported', 'blocker.escalated'].includes(event.type)).map((event) => ({ id: event.id, nodeId: event.nodeId || null, type: event.type, createdAt: event.createdAt }))),
    recentEvents: safeEvents,
    generatedAt: org.updatedAt,
  };
  if (status) {
    projection.runtimeCapabilities = getOrganizationRuntimeCapabilities({ publicOnly: true });
    projection.summary = status.summary;
    const lastEventId = eventHistory.at(-1)?.id || 0;
    const since = Number.isInteger(Number(sinceEventId)) && Number(sinceEventId) >= 0 ? Number(sinceEventId) : 0;
    projection.asOf = {
      revision: org.currentRevision,
      eventId: lastEventId,
      progressEpoch: integer(org.progressEpoch),
      projectionDigest: null,
    };
    projection.changes = eventHistory.filter((event) => event.id > since).slice(-itemLimit).map((event) => publicEvent(event, nodes));
  }
  projection.digest = projectionDigest(projection);
  if (projection.asOf) projection.asOf.projectionDigest = projection.digest;
  return projection;
}

export async function buildOrganizationProjection(organizationId, options = {}) {
  const org = await getOrganization(organizationId);
  if (!org) return null;
  const maxItems = Math.min(MAX_ITEMS, Math.max(1, integer(options.maxItems, MAX_ITEMS)));
  const version = Number(options.version) >= ORGANIZATION_PROJECTION_V2_SCHEMA_VERSION
    ? ORGANIZATION_PROJECTION_V2_SCHEMA_VERSION
    : ORGANIZATION_PROJECTION_SCHEMA_VERSION;
  const sinceEventId = Number.isInteger(Number(options.sinceEventId)) && Number(options.sinceEventId) >= 0
    ? Number(options.sinceEventId)
    : 0;
  const generation = organizationProjectionGeneration(org.id);
  // Events do not mutate the organization row, so the explicit invalidation
  // hook is part of the key's freshness contract. Metadata changes still
  // naturally produce a new key through version/revision/epoch/updatedAt.
  const key = [
    org.id,
    org.version,
    org.currentRevision,
    org.progressEpoch,
    org.updatedAt,
    version,
    maxItems,
    sinceEventId,
    generation,
  ].map((value) => String(value ?? '')).join('|');
  const cached = organizationProjectionCache.get(key);
  if (cached) return cached;
  const existing = organizationProjectionInflight.get(key);
  if (existing) return existing;
  const pending = buildOrganizationProjectionUncached(org.id, {
    maxItems,
    version,
    sinceEventId,
    organization: org,
  }).then((projection) => {
    if (projection && generation === organizationProjectionGeneration(org.id)) {
      organizationProjectionCache.set(key, projection);
    }
    return projection;
  }).finally(() => {
    if (organizationProjectionInflight.get(key) === pending) organizationProjectionInflight.delete(key);
  });
  organizationProjectionInflight.set(key, pending);
  return pending;
}

export function assertPublicProjection(projection) {
  if (!projection || typeof projection !== 'object') throw error('projection is required');
  const runtimeCapabilities = projection.runtimeCapabilities;
  if (runtimeCapabilities !== undefined) {
    if (!runtimeCapabilities || typeof runtimeCapabilities !== 'object' || Array.isArray(runtimeCapabilities)) {
      throw error('projection runtimeCapabilities must be an object');
    }
    const booleanKeys = [
      'organizationProposal', 'durableCollaboration', 'managedSessions', 'managedInput',
      'managedWriter', 'reviewerRuntime', 'internalEnvelopes', 'hierarchicalDelegation',
      'dynamicReplan', 'stallGovernor', 'projectionV1', 'projectionV2', 'recovery',
      'sessionAddressability', 'automaticProvisioning',
    ];
    for (const key of booleanKeys) {
      if (typeof runtimeCapabilities[key] !== 'boolean') throw error(`projection runtimeCapabilities.${key} must be boolean`);
    }
    if (!Array.isArray(runtimeCapabilities.supportedModes)) throw error('projection runtimeCapabilities.supportedModes must be an array');
    if (!runtimeCapabilities.limits || typeof runtimeCapabilities.limits !== 'object') throw error('projection runtimeCapabilities.limits must be bounded');
  }
  const encoded = JSON.stringify(projection);
  for (const forbidden of ['policy', 'grant', 'budget_json', 'rawHistory', 'payload', 'prompt', 'secret', 'effectiveGrants']) {
    if (encoded.toLowerCase().includes(forbidden.toLowerCase())) throw error(`projection contains forbidden field: ${forbidden}`);
  }
  return true;
}

export { projectionDigest as organizationProjectionDigest, invalidateOrganizationProjectionCache };
