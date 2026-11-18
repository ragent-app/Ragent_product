// S20 bounded context projection. The projector is a read-only boundary: it
// accepts server facts, selects role-specific fields, and never returns raw
// Session history, prompts, grants, or tool configuration.
import { createHash } from 'crypto';
import { canonicalJson } from './execution-scope.mjs';

export const CONTEXT_PROJECTION_SCHEMA_VERSION = 1;
export const CONTEXT_TARGET_ROLES = Object.freeze(['EXECUTIVE', 'MANAGER', 'WORKER', 'REVIEWER']);

export const CONTEXT_PROJECTION_INVALID = 'CONTEXT_PROJECTION_INVALID';
export const CONTEXT_PROJECTION_FORBIDDEN = 'CONTEXT_PROJECTION_FORBIDDEN';
export const CONTEXT_PROJECTION_TOO_LARGE = 'CONTEXT_PROJECTION_TOO_LARGE';

const ROLES = new Set(CONTEXT_TARGET_ROLES);
const DEFAULT_MAX_BYTES = 32 * 1024;
const MAX_ARRAY_ITEMS = 128;
const MAX_STRING_LENGTH = 2048;
const FORBIDDEN_KEYS = new Set([
  'history', 'rawHistory', 'raw_history', 'transcript', 'messages', 'chatHistory',
  'systemPrompt', 'system_prompt', 'prompt', 'privatePrompt', 'private_prompt',
  'grant', 'grantToken', 'grant_token', 'capabilityToken', 'capability_token',
  'secret', 'secrets', 'token', 'accessToken', 'access_token', 'cookie',
  'toolConfig', 'tool_config', 'toolSecrets', 'tool_secrets', 'credentials',
  'privateFields', 'private_fields', 'rawPayload', 'raw_payload',
]);

function projectionError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function text(value, label = 'value') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw projectionError(CONTEXT_PROJECTION_INVALID, `${label} must be a string`);
  return value.slice(0, MAX_STRING_LENGTH);
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
    .sort()
    .slice(0, MAX_ARRAY_ITEMS);
}

function boundedList(value, mapper = (entry) => entry) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARRAY_ITEMS).map(mapper).filter(Boolean);
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function cloneBounded(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => cloneBounded(entry, depth + 1));
  if (!plain(value)) return null;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const next = cloneBounded(value[key], depth + 1);
    if (next !== null && next !== undefined) result[key] = next;
  }
  return result;
}

function assertNoForbidden(value, path = 'facts', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw projectionError(CONTEXT_PROJECTION_FORBIDDEN, `${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbidden(entry, `${path}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw projectionError(CONTEXT_PROJECTION_FORBIDDEN, `${path}.${key} is not projectionable`, 403, { field: key });
      }
      assertNoForbidden(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function stableRef(value, kind = 'ref') {
  if (typeof value === 'string') return value.trim() ? { kind, id: value.trim() } : null;
  if (!plain(value)) return null;
  const id = text(value.id || value.ref || value.packetId || value.artifactId || value.evidenceRef);
  if (!id) return null;
  return {
    kind: text(value.kind) || kind,
    id,
    ...(text(value.type) ? { type: text(value.type) } : {}),
    ...(text(value.digest) ? { digest: text(value.digest) } : {}),
  };
}

function refs(value, kind) {
  const unique = new Map();
  for (const entry of boundedList(value, (item) => stableRef(item, kind))) {
    unique.set(`${entry.kind}:${entry.id}`, entry);
  }
  return [...unique.values()]
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function projectionNode(node, includeTask = false) {
  if (!plain(node)) return null;
  const result = {
    id: text(node.id),
    parentId: text(node.parentId || node.parentNodeId),
    role: text(node.role || node.nodeRole).toUpperCase(),
    status: text(node.status || node.lifecycleState || 'unknown'),
  };
  if (text(node.stableKey)) result.stableKey = text(node.stableKey);
  if (text(node.phaseId)) result.phaseId = text(node.phaseId);
  if (text(node.sessionId)) result.sessionId = text(node.sessionId);
  if (text(node.currentActivity)) result.currentActivity = text(node.currentActivity);
  if (text(node.taskId || node.currentTask?.taskId)) result.taskId = text(node.taskId || node.currentTask.taskId);
  if (includeTask && node.progress !== undefined) result.progress = cloneBounded(node.progress);
  if (includeTask && plain(node.currentTask)) result.currentTask = cloneBounded(node.currentTask);
  if (includeTask && plain(node.plannedTask)) result.plannedTask = cloneBounded(node.plannedTask);
  if (includeTask && plain(node.blocker)) result.blocker = cloneBounded(node.blocker);
  return result.id ? result : null;
}

function normalizePhase(phase) {
  if (!plain(phase)) return null;
  const result = {
    phaseId: text(phase.phaseId || phase.id),
    objective: text(phase.objective),
    state: text(phase.state || 'unknown'),
    acceptance: boundedList(phase.acceptance, (entry) => plain(entry) ? {
      criterion: text(entry.criterion || entry.id),
      status: text(entry.status || 'pending'),
      evidenceRefs: refs(entry.evidenceRefs || entry.evidence, 'evidence'),
    } : null).filter((entry) => entry.criterion),
    packetRefs: refs(phase.packetRefs || phase.resultPacketRefs, 'result_packet'),
    reviewRefs: refs(phase.reviewRefs || phase.reviewDecisionRefs, 'review'),
  };
  return result.phaseId ? result : null;
}

function baseProjection(facts, targetRole, sourceRevision, maxBytes) {
  const result = {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    targetRole,
    organizationId: text(facts.organizationId),
    sourceRevision,
    generatedAt: new Date().toISOString(),
    sizeBound: maxBytes,
  };
  if (plain(facts.asOf)) {
    result.asOf = {
      revision: Number.isInteger(facts.asOf.revision) ? facts.asOf.revision : sourceRevision,
      eventId: Number.isInteger(facts.asOf.eventId) ? facts.asOf.eventId : 0,
      progressEpoch: Number.isInteger(facts.asOf.progressEpoch) ? facts.asOf.progressEpoch : 0,
      projectionDigest: text(facts.asOf.projectionDigest),
    };
  }
  return result;
}

function buildRoleBody(facts, targetRole, nodeId) {
  const frozen = plain(facts.frozenRevision) ? {
    revision: facts.frozenRevision.revision,
    digest: text(facts.frozenRevision.digest),
    state: text(facts.frozenRevision.state || 'frozen'),
  } : null;
  if (targetRole === 'EXECUTIVE') {
    return {
      objective: text(facts.objective),
      frozenRevision: frozen,
      phases: boundedList(facts.phases, normalizePhase).filter(Boolean),
      packetRefs: refs(facts.packetRefs || facts.phasePacketRefs, 'result_packet'),
      reviewRefs: refs(facts.reviewRefs || facts.reviewDecisionRefs, 'review'),
      blockerRefs: refs(facts.blockerRefs || facts.blockers, 'blocker'),
      progress: plain(facts.progress) ? cloneBounded(facts.progress) : null,
      budget: plain(facts.budgetProgress) ? cloneBounded(facts.budgetProgress) : null,
    };
  }

  const targetNode = plain(facts.targetNode) ? facts.targetNode : null;
  const subtreeIds = new Set([nodeId, ...list(facts.subtreeNodeIds)]);
  const nodes = boundedList(facts.nodes, (node) => {
    const projected = projectionNode(node, targetRole === 'MANAGER');
    return projected && (targetRole === 'MANAGER' ? subtreeIds.has(projected.id) : projected.id === nodeId) ? projected : null;
  }).filter(Boolean);

  if (targetRole === 'MANAGER') {
    return {
      phase: normalizePhase(facts.phase),
      targetNode: projectionNode(targetNode, true),
      subtree: nodes,
      childPacketRefs: refs(facts.directChildPacketRefs || facts.resultPacketRefs, 'result_packet'),
      reviewRefs: refs(facts.reviewRefs, 'review'),
      projectRefs: refs(facts.projectRefs, 'project'),
    };
  }

  if (targetRole === 'WORKER') {
    return {
      task: plain(facts.task) ? {
        taskId: text(facts.task.taskId || facts.task.id),
        objective: text(facts.task.objective),
        state: text(facts.task.state || 'unknown'),
        phaseId: text(facts.task.phaseId),
        attempt: Number.isInteger(facts.task.attempt) ? facts.task.attempt : 0,
        runId: text(facts.task.runId),
        runState: text(facts.task.runState),
        acceptance: boundedList(facts.task.acceptance, (entry) => cloneBounded(entry)).filter(Boolean),
      } : null,
      executionScope: plain(facts.executionScopeSnapshot) ? cloneBounded(facts.executionScopeSnapshot) : null,
      parentHandoff: stableRef(facts.parentHandoff, 'handoff'),
      projectRefs: refs(facts.projectRefs, 'project'),
    };
  }

  return {
    reviewPolicy: plain(facts.reviewPolicy) ? cloneBounded(facts.reviewPolicy) : null,
    acceptance: boundedList(facts.acceptance, (entry) => cloneBounded(entry)).filter(Boolean),
    targetPacketRefs: refs(facts.targetPacketRefs || facts.resultPacketRefs, 'result_packet'),
    diffRefs: refs(facts.diffRefs || facts.diffs, 'diff'),
    testRefs: refs(facts.testRefs || facts.tests, 'test'),
    artifactRefs: refs(facts.artifactRefs || facts.artifacts, 'artifact'),
    evidenceRefs: refs(facts.evidenceRefs || facts.evidence, 'evidence'),
    readOnly: true,
  };
}

function trimToSize(projection, maxBytes) {
  const withoutDigest = { ...projection };
  delete withoutDigest.digest;
  // Reserve room for the final digest and its JSON field. This keeps the
  // public bound true for the returned object, not only for the pre-digest
  // body.
  const bodyLimit = Math.max(256, maxBytes - 120);
  const size = Buffer.byteLength(canonicalJson(withoutDigest), 'utf8');
  if (size <= bodyLimit) return withoutDigest;
  const candidates = ['phases', 'subtree', 'childPacketRefs', 'packetRefs', 'reviewRefs', 'blockerRefs', 'projectRefs', 'diffRefs', 'testRefs', 'artifactRefs', 'evidenceRefs'];
  const trimmed = { ...withoutDigest };
  for (const key of candidates) {
    if (Array.isArray(trimmed[key])) trimmed[key] = trimmed[key].slice(0, Math.max(0, Math.floor(trimmed[key].length / 2)));
    if (Buffer.byteLength(canonicalJson(trimmed), 'utf8') <= bodyLimit) return trimmed;
  }
  const optionalKeys = [
    'phases', 'subtree', 'childPacketRefs', 'packetRefs', 'reviewRefs', 'blockerRefs',
    'projectRefs', 'diffRefs', 'testRefs', 'artifactRefs', 'evidenceRefs',
    'objective', 'frozenRevision', 'phase', 'targetNode', 'task', 'executionScope',
    'parentHandoff', 'reviewPolicy', 'acceptance', 'progress', 'budget',
  ];
  for (const key of optionalKeys) {
    if (!Object.hasOwn(trimmed, key)) continue;
    if (Array.isArray(trimmed[key])) trimmed[key] = [];
    else delete trimmed[key];
    trimmed.truncated = true;
    if (Buffer.byteLength(canonicalJson(trimmed), 'utf8') <= bodyLimit) return trimmed;
  }
  const minimal = {
    schemaVersion: trimmed.schemaVersion,
    targetRole: trimmed.targetRole,
    organizationId: trimmed.organizationId,
    sourceRevision: trimmed.sourceRevision,
    generatedAt: trimmed.generatedAt,
    sizeBound: trimmed.sizeBound,
    truncated: true,
  };
  if (Buffer.byteLength(canonicalJson(minimal), 'utf8') <= bodyLimit) return minimal;
  if (Buffer.byteLength(canonicalJson(trimmed), 'utf8') > bodyLimit) {
    throw projectionError(CONTEXT_PROJECTION_TOO_LARGE, 'context projection exceeds its size bound', 413, { maxBytes });
  }
  return trimmed;
}

export function buildContextProjection({ targetRole, organizationId, nodeId = '', revision = 0, facts = {}, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const role = text(targetRole).toUpperCase();
  if (!ROLES.has(role)) throw projectionError(CONTEXT_PROJECTION_INVALID, 'targetRole is unknown', 400, { targetRole });
  const orgId = text(organizationId);
  if (!orgId || text(facts.organizationId) !== orgId) throw projectionError(CONTEXT_PROJECTION_INVALID, 'organization identity does not match facts', 403);
  const sourceRevision = Number.isInteger(revision) ? revision : Number(facts.sourceRevision ?? facts.revision);
  if (!Number.isInteger(sourceRevision) || sourceRevision < 0) throw projectionError(CONTEXT_PROJECTION_INVALID, 'source revision is invalid');
  const boundedMax = Number.isInteger(maxBytes) && maxBytes >= 512 ? Math.min(maxBytes, 1024 * 1024) : DEFAULT_MAX_BYTES;
  assertNoForbidden(facts);
  if (role !== 'EXECUTIVE' && !text(nodeId)) throw projectionError(CONTEXT_PROJECTION_INVALID, 'nodeId is required for this target role');
  if (role !== 'EXECUTIVE' && facts.targetNode && text(facts.targetNode.id) !== text(nodeId)) {
    throw projectionError(CONTEXT_PROJECTION_INVALID, 'target node does not match projection request', 403);
  }
  if (role === 'REVIEWER' && facts.canWrite === true) throw projectionError(CONTEXT_PROJECTION_FORBIDDEN, 'reviewer projection cannot carry write capability', 403);
  const projection = { ...baseProjection(facts, role, sourceRevision, boundedMax), ...buildRoleBody(facts, role, text(nodeId)) };
  const boundedProjection = trimToSize(projection, boundedMax);
  const digestInput = { ...boundedProjection };
  delete digestInput.generatedAt;
  const digest = `sha256:${createHash('sha256').update(canonicalJson(digestInput), 'utf8').digest('hex')}`;
  return { ...boundedProjection, digest };
}

export function projectionDigest(projection) {
  if (!plain(projection)) throw projectionError(CONTEXT_PROJECTION_INVALID, 'projection must be an object');
  const copy = { ...projection };
  delete copy.digest;
  delete copy.generatedAt;
  return `sha256:${createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex')}`;
}
