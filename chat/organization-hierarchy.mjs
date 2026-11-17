// S19: controlled hierarchy delegation and manager aggregation.
// This adapter composes the existing organization, collaboration, operation,
// messaging, and ResultPacket stores. It does not create a second task/run or
// copy child chat/result bodies into the organization database.
import { randomBytes } from 'crypto';
import { withDatabase } from './collaboration-store.mjs';
import {
  createCollaborationRecord,
  getCollaboration,
  markReadyTasks,
  claimTaskAttempt,
  cancelCollaboration,
} from './collaboration-store.mjs';
import {
  createRoleInstance,
  createNode,
  getNode,
  createDelegationGrant,
  createOrganizationEdge,
  listOrganizationEdges,
} from './organization-store.mjs';
import { organizationGrantForNode } from './organization-role-contract.mjs';
import {
  createOperation,
  getOperation,
  transitionOperation,
} from './organization-operations.mjs';
import {
  enqueueInternalEnvelope,
  appendOrganizationEvent,
} from './organization-messaging.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';

export const ORG_HIERARCHY_INVALID = 'ORG_HIERARCHY_INVALID';
export const ORG_HIERARCHY_CONFLICT = 'ORG_HIERARCHY_CONFLICT';
export const ORG_AGGREGATION_NOT_READY = 'ORG_AGGREGATION_NOT_READY';

const AGGREGATION_STATES = new Set(['pending', 'ready', 'claimed', 'completed', 'cancelled']);

function error(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function json(value, fallback = null) {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    return encoded === undefined ? JSON.stringify(fallback) : encoded;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureId(value, label) {
  const normalized = text(value);
  if (!normalized || normalized.length > 255) throw error(ORG_HIERARCHY_INVALID, `${label} is required`, 400);
  return normalized;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) throw error(ORG_HIERARCHY_INVALID, `${label} must be an array`, 400);
  return [...new Set(value.map(text).filter(Boolean))];
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_aggregations (
      aggregation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      manager_node_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      expected_child_node_ids_json TEXT NOT NULL,
      expected_packet_ids_json TEXT NOT NULL,
      received_packet_refs_json TEXT NOT NULL,
      state TEXT NOT NULL,
      claim_id TEXT,
      lease_until TEXT,
      aggregation_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, manager_node_id, aggregation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_manager_aggregations_ready
      ON manager_aggregations(organization_id, manager_node_id, state, generation);
  `);
}

function rowAggregation(row) {
  if (!row) return null;
  return {
    aggregationId: row.aggregation_id,
    organizationId: row.organization_id,
    managerNodeId: row.manager_node_id,
    generation: row.generation,
    expectedChildNodeIds: parseJson(row.expected_child_node_ids_json, []),
    expectedPacketIds: parseJson(row.expected_packet_ids_json, []),
    receivedPacketRefs: parseJson(row.received_packet_refs_json, []),
    state: row.state,
    claimId: row.claim_id || '',
    leaseUntil: row.lease_until || '',
    aggregationRunId: row.aggregation_run_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function read(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); });
}

async function mutate(fn) {
  return withDatabase((db) => { ensureSchema(db); return fn(db); }, { mutate: true });
}

function assertManager(parent) {
  if (!parent || !['manager', 'executive', 'phase_lead'].includes(text(parent.nodeRole).toLowerCase())) {
    throw error(ORG_HIERARCHY_INVALID, 'only a Manager/Executive/Phase Lead node may delegate', 403);
  }
  const grant = parent.grant && typeof parent.grant === 'object' ? parent.grant : {};
  if (grant.canDelegate !== true && grant.canDelegate !== 1) {
    throw error(ORG_HIERARCHY_INVALID, 'parent delegation grant is disabled', 403);
  }
}

function assertDepth(parent, requestedDepth, maxDepth = 3) {
  const depth = Number(parent.depth || 0) + 1;
  const ceiling = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : 3;
  if (depth > ceiling) throw error(ORG_HIERARCHY_INVALID, 'organization hierarchy depth exceeded', 422, { depth, maxDepth: ceiling });
  if (requestedDepth !== undefined && Number(requestedDepth) !== depth) {
    throw error(ORG_HIERARCHY_INVALID, 'child depth must be exactly one level below the parent', 422, { depth, requestedDepth });
  }
  return depth;
}

function assertCapabilitySubset(parent, capabilityProfile = {}, delegation = {}) {
  const parentGrant = parent.grant && typeof parent.grant === 'object' ? parent.grant : {};
  const allowed = new Set((parentGrant.allowedCapabilities || parentGrant.capabilities || []).map(text).filter(Boolean));
  const requested = (capabilityProfile.capabilities || delegation.allowedCapabilities || []).map(text).filter(Boolean);
  if (allowed.size > 0 && requested.some((capability) => !allowed.has(capability))) {
    throw error(ORG_HIERARCHY_INVALID, 'child capabilities exceed parent delegation grant', 403);
  }
  if (delegation.projectId && parentGrant.projectId && delegation.projectId !== parentGrant.projectId) {
    throw error(ORG_HIERARCHY_INVALID, 'child project differs from parent project', 403);
  }
}

async function transition(operation, nextState, result) {
  return transitionOperation(operation.operationId, {
    expectedState: operation.state,
    expectedVersion: operation.version,
    expectedGeneration: operation.generation,
    nextState,
    currentStep: nextState,
    result,
  });
}

async function findExistingDelegation({ organizationId, stableKey, idempotencyKey }) {
  const edges = await listOrganizationEdges(organizationId);
  const edge = edges.find((entry) => entry.stableKey === stableKey || entry.idempotencyKey === idempotencyKey);
  if (!edge) return null;
  const node = await getNode(edge.childNodeId);
  return node ? { node, edge } : null;
}

export async function delegateHierarchicalTask(input = {}, {
  createManagedSession,
  createRunId = () => id('run'),
} = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization delegation is disabled');
  if (typeof createManagedSession !== 'function') {
    throw error(ORG_HIERARCHY_INVALID, 'server managed-session factory is required', 503);
  }
  const organizationId = ensureId(input.organizationId, 'organizationId');
  const revision = Number.isInteger(input.revision) ? input.revision : 0;
  const parentNodeId = ensureId(input.parentNodeId, 'parentNodeId');
  const stableKey = ensureId(input.stableKey, 'stableKey');
  const taskId = ensureId(input.taskId || `task_${stableKey}`, 'taskId');
  const objective = text(input.objective);
  const idempotencyKey = ensureId(input.idempotencyKey, 'idempotencyKey');
  const role = text(input.role || input.childRole || 'worker').toLowerCase();
  const agentId = ensureId(input.agentId, 'agentId');
  if (!objective) throw error(ORG_HIERARCHY_INVALID, 'objective is required', 400);
  if (!['worker', 'specialist', 'writer', 'reviewer', 'manager', 'phase_lead'].includes(role)) throw error(ORG_HIERARCHY_INVALID, 'child role is invalid', 400);

  const parent = await getNode(parentNodeId);
  if (!parent || parent.organizationId !== organizationId) throw error(ORG_HIERARCHY_INVALID, 'parent node is not in organization', 400);
  assertManager(parent);
  const depth = assertDepth(parent, input.depth, input.maxDepth);
  assertCapabilitySubset(parent, input.capabilityProfile, input.delegation);
  const grant = organizationGrantForNode({
    role,
    capabilities: input.capabilityProfile?.capabilities || input.delegation?.allowedCapabilities || [],
    scope: {
      ...(input.capabilityProfile?.scope || {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(Array.isArray(input.writablePaths) ? { writablePaths: input.writablePaths } : {}),
    },
    maxDepth: input.maxDepth,
    maxChildren: input.maxChildren,
    maxConcurrent: input.maxConcurrent,
  }, parent.grant || {});

  const existing = await findExistingDelegation({ organizationId, stableKey, idempotencyKey });
  if (existing) {
    const operation = await getOperation(input.operationId || `op_${idempotencyKey}`.replace(/[^A-Za-z0-9_.:-]/g, '_')).catch(() => null);
    return { ...existing, operation: operation || null, replay: true };
  }

  const operation = await createOperation({
    operationId: input.operationId,
    organizationId,
    commandKind: 'delegateTask',
    idempotencyKey,
    actorNodeId: parentNodeId,
    actorSessionId: text(input.fromSessionId),
    revision,
    payload: { stableKey, taskId, role, agentId, objective },
  });
  if (operation.state === 'completed' && operation.result) return { ...operation.result, operation, replay: true };

  let current = operation;
  current = await transition(current, 'validated', { stableKey, taskId });

  const sessionResult = await createManagedSession({
    operationId: current.operationId,
    organizationId,
    organizationRevision: revision,
    parentNodeId,
    role,
    agentId,
    stableKey,
    taskId,
    depth,
    sessionClass: role === 'reviewer' ? 'REVIEWER' : role === 'worker' || role === 'specialist' ? 'WORKER' : 'MANAGER',
    projectId: text(input.projectId),
    parentSessionId: text(input.fromSessionId),
  });
  const sessionId = ensureId(sessionResult?.sessionId, 'managed sessionId');
  const runId = ensureId(sessionResult?.runId || createRunId(), 'managed runId');
  current = await transition(current, 'facts_created', { sessionId, runId });

  const roleInstance = await createRoleInstance({
    organizationId,
    organizationRevision: revision,
    stableKey,
    role,
    agentId,
    organizationNodeId: '',
    capabilityProfile: { ...(input.capabilityProfile || {}), grant },
    policy: { ...(input.policy || {}), organizationRole: role },
    budget: input.budget || {},
    idempotencyKey: `${idempotencyKey}:role`,
  });
  const node = await createNode({
    organizationId,
    stableKey,
    nodeRole: role,
    createdRevision: revision,
    parentNodeId,
    depth,
    roleInstanceId: roleInstance.id,
    sessionClass: roleInstance.role === 'reviewer' ? 'REVIEWER' : roleInstance.role === 'worker' || roleInstance.role === 'specialist' ? 'WORKER' : 'MANAGER',
    grant,
    currentSessionId: sessionId,
    idempotencyKey: `${idempotencyKey}:node`,
  });
  const edge = await createOrganizationEdge({
    organizationId,
    organizationRevision: revision,
    stableKey,
    edgeType: 'MANAGES',
    parentNodeId,
    childNodeId: node.id,
    idempotencyKey: `${idempotencyKey}:edge`,
  });
  const birthActorSession = text(input.fromSessionId);
  const verifiedBirthSession = birthActorSession && birthActorSession === text(parent.currentSessionId);
  await appendOrganizationEvent({ organizationId, eventKey: `node-created:${node.id}`, type: 'node.created', organizationRevision: revision, nodeId: node.id, actorNodeId: parentNodeId,
    ...(verifiedBirthSession ? { actorSessionId: birthActorSession, payload: { birthActorSource: 'hierarchical_session' } } : {}) });
  const delegationGrant = await createDelegationGrant({
    organizationId,
    organizationRevision: revision,
    parentNodeId,
    childNodeId: node.id,
    roleInstanceId: roleInstance.id,
    allowedCapabilities: grant.allowedCapabilities,
    scope: {
      writablePaths: grant.writablePaths,
      workspaceScope: grant.workspaceScope,
      projectId: grant.projectId,
    },
    accessMode: grant.accessMode,
    executionIsolation: grant.executionIsolation,
    maxDepth: grant.maxDepth,
    maxChildren: grant.maxChildren,
    maxConcurrent: grant.maxConcurrent,
    canDelegate: grant.canDelegate,
    idempotencyKey: `${idempotencyKey}:delegation`,
  });
  const taskCollaboration = await createCollaborationRecord({
    rootSessionId: text(input.rootSessionId || parent.currentSessionId || input.fromSessionId),
    title: `Organization task: ${objective}`,
    policy: { organizationId, organizationNodeId: node.id, organizationBindingGeneration: node.bindingGeneration, role },
    idempotencyKey: `${idempotencyKey}:collaboration`,
    plan: {
      version: 1,
      tasks: [{
        id: taskId,
        objective,
        agentId,
        role,
        projectId: text(input.projectId),
        dependsOn: [],
        acceptance: Array.isArray(input.acceptance) ? input.acceptance : [],
        writablePaths: Array.isArray(input.writablePaths) ? input.writablePaths : [],
        retry: input.retry || { maxAttempts: 1, retryOn: [] },
        timeoutMs: Number.isInteger(input.timeoutMs) ? input.timeoutMs : 600000,
      }],
    },
  });
  await markReadyTasks(taskCollaboration.id);
  const attempt = await claimTaskAttempt(taskId, { sessionId, runId });
  if (!attempt) throw error(ORG_HIERARCHY_CONFLICT, 'delegated task could not claim its first attempt', 409);
  current = await transition(current, 'external_effect_created', { nodeId: node.id, roleInstanceId: roleInstance.id, edgeId: edge.id, collaborationId: taskCollaboration.id, taskId, attemptId: attempt.id, sessionId, runId });
  const envelope = await enqueueInternalEnvelope({
    organizationId,
    organizationRevision: revision,
    type: 'TASK_ASSIGNED',
    fromNodeId: parentNodeId,
    fromSessionId: text(input.fromSessionId || parent.currentSessionId),
    toNodeId: node.id,
    toSessionId: sessionId,
    taskId,
    attemptId: attempt.id,
    payloadRef: { kind: 'task', taskId, attemptId: attempt.id, nodeId: node.id },
    subject: objective.slice(0, 240),
    idempotencyKey: `${idempotencyKey}:assigned`,
  });
  await appendOrganizationEvent({
    organizationId,
    eventKey: `${idempotencyKey}:delegated`,
    type: 'task.delegated',
    organizationRevision: revision,
    nodeId: node.id,
    taskId,
    attemptId: attempt.id,
    envelopeId: envelope.envelopeId,
    actorNodeId: parentNodeId,
    actorSessionId: text(input.fromSessionId || parent.currentSessionId),
    payloadRef: { kind: 'task', taskId, nodeId: node.id },
    payload: { role, collaborationId: taskCollaboration.id },
  });
  const result = { organizationId, operationId: current.operationId, roleInstance, node, edge, delegationGrant, collaboration: taskCollaboration, taskId, attempt, sessionId, runId, envelope };
  current = await transition(current, 'bound', result);
  current = await transition(current, 'completed', result);
  return { ...result, operation: current, replay: false };
}

export async function getManagerAggregation(aggregationId) {
  const idValue = ensureId(aggregationId, 'aggregationId');
  return read((db) => rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue)));
}

export async function listManagerAggregations(organizationId, { activeOnly = false, states = [], limit = 500 } = {}) {
  const orgId = ensureId(organizationId, 'organizationId');
  const boundedLimit = Math.max(1, Math.min(5000, Number.isInteger(limit) && limit > 0 ? limit : 500));
  const wantedStates = Array.isArray(states) ? [...new Set(states.map(text).filter(Boolean))] : [];
  return read((db) => {
    const clauses = ['organization_id = ?'];
    const params = [orgId];
    if (activeOnly) clauses.push("state NOT IN ('completed', 'cancelled')");
    if (wantedStates.length > 0) {
      clauses.push(`state IN (${wantedStates.map(() => '?').join(',')})`);
      params.push(...wantedStates);
    }
    params.push(boundedLimit);
    return db.prepare(`SELECT * FROM manager_aggregations WHERE ${clauses.join(' AND ')} ORDER BY updated_at, aggregation_id LIMIT ?`)
      .all(...params).map(rowAggregation);
  });
}

export async function reclaimExpiredManagerAggregation(aggregationId, { expectedGeneration, now = new Date() } = {}) {
  const idValue = ensureId(aggregationId, 'aggregationId');
  const nowText = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue);
      if (!current) throw error(ORG_AGGREGATION_NOT_READY, 'manager aggregation does not exist', 409);
      if (expectedGeneration !== undefined && Number(current.generation) !== Number(expectedGeneration)) {
        throw error(ORG_HIERARCHY_CONFLICT, 'aggregation generation is stale', 409);
      }
      if (current.state !== 'claimed' || !current.lease_until || current.lease_until > nowText) {
        db.exec('COMMIT');
        return { reclaimed: false, aggregation: rowAggregation(current) };
      }
      const changed = db.prepare(`UPDATE manager_aggregations SET state = 'ready', generation = generation + 1,
        claim_id = NULL, lease_until = NULL, updated_at = ?
        WHERE aggregation_id = ? AND state = 'claimed' AND generation = ? AND lease_until <= ?`)
        .run(nowIso(), idValue, current.generation, nowText);
      if (changed.changes !== 1) throw error(ORG_HIERARCHY_CONFLICT, 'aggregation recovery changed concurrently', 409);
      db.exec('COMMIT');
      return {
        reclaimed: true,
        aggregation: rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue)),
      };
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

async function ensureAggregation(input) {
  const organizationId = ensureId(input.organizationId, 'organizationId');
  const aggregationId = ensureId(input.aggregationId, 'aggregationId');
  const managerNodeId = ensureId(input.managerNodeId, 'managerNodeId');
  const childIds = ensureArray(input.expectedChildNodeIds, 'expectedChildNodeIds');
  const packetIds = ensureArray(input.expectedPacketIds, 'expectedPacketIds');
  if (childIds.length === 0 || childIds.length !== packetIds.length) throw error(ORG_HIERARCHY_INVALID, 'aggregation child and packet expectations must be paired', 400);
  const manager = await getNode(managerNodeId);
  if (!manager || manager.organizationId !== organizationId) throw error(ORG_HIERARCHY_INVALID, 'manager node is not in organization', 400);
  assertManager(manager);
  const edges = await listOrganizationEdges(organizationId);
  const directChildren = new Set(edges
    .filter((edge) => edge.parentNodeId === managerNodeId && edge.edgeType === 'MANAGES')
    .map((edge) => edge.childNodeId));
  if (childIds.some((childId) => !directChildren.has(childId))) {
    throw error(ORG_HIERARCHY_INVALID, 'aggregation children must be direct manager descendants', 400);
  }
  return mutate((db) => {
    const existing = db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(aggregationId);
    if (existing) {
      if (existing.organization_id !== organizationId || existing.manager_node_id !== managerNodeId) throw error(ORG_HIERARCHY_CONFLICT, 'aggregation identity conflict', 409);
      if (existing.expected_child_node_ids_json !== json(childIds, [])
        || existing.expected_packet_ids_json !== json(packetIds, [])) {
        throw error(ORG_HIERARCHY_CONFLICT, 'aggregation expectations are immutable', 409);
      }
      return rowAggregation(existing);
    }
    const timestamp = nowIso();
    db.prepare(`INSERT INTO manager_aggregations
      (aggregation_id, organization_id, manager_node_id, generation, expected_child_node_ids_json,
       expected_packet_ids_json, received_packet_refs_json, state, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, '[]', 'pending', ?, ?)`).run(
      aggregationId, organizationId, managerNodeId, json(childIds, []), json(packetIds, []), timestamp, timestamp);
    return rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(aggregationId));
  });
}

export async function ensureManagerAggregation(input = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization aggregation is disabled');
  return ensureAggregation(input);
}

export async function recordChildResultPacket({ aggregationId, childNodeId, packetId, sessionId = '' } = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization aggregation is disabled');
  const idValue = ensureId(aggregationId, 'aggregationId');
  const childId = ensureId(childNodeId, 'childNodeId');
  const packet = ensureId(packetId, 'packetId');
  const outcome = await mutate((db) => {
    const row = db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue);
    if (!row) throw error(ORG_AGGREGATION_NOT_READY, 'manager aggregation does not exist', 409);
    const expectedChildren = parseJson(row.expected_child_node_ids_json, []);
    const expectedPackets = parseJson(row.expected_packet_ids_json, []);
    if (!expectedChildren.includes(childId) || !expectedPackets.includes(packet)) throw error(ORG_HIERARCHY_INVALID, 'child or packet is not expected by this aggregation', 400);
    const child = db.prepare('SELECT id, organization_id, current_session_id FROM organization_nodes WHERE id = ?').get(childId);
    if (!child || child.organization_id !== row.organization_id) throw error(ORG_HIERARCHY_INVALID, 'child node is not in aggregation organization', 400);
    const refs = parseJson(row.received_packet_refs_json, []);
    if (!refs.some((ref) => ref.childNodeId === childId && ref.packetId === packet)) {
      refs.push({ childNodeId: childId, packetId: packet });
      refs.sort((a, b) => `${a.childNodeId}:${a.packetId}`.localeCompare(`${b.childNodeId}:${b.packetId}`));
    }
    const complete = expectedChildren.every((expectedChild) => refs.some((ref) => ref.childNodeId === expectedChild))
      && expectedPackets.every((expectedPacket) => refs.some((ref) => ref.packetId === expectedPacket));
    const state = row.state === 'pending' || row.state === 'ready' ? (complete ? 'ready' : 'pending') : row.state;
    db.prepare('UPDATE manager_aggregations SET received_packet_refs_json = ?, state = ?, updated_at = ? WHERE aggregation_id = ? AND generation = ?')
      .run(json(refs, []), state, nowIso(), idValue, row.generation);
    return {
      aggregation: rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue)),
      organizationId: row.organization_id,
      managerNodeId: row.manager_node_id,
      childSessionId: text(sessionId || child.current_session_id),
      packet,
    };
  });
  if (outcome.childSessionId) {
    const envelope = await enqueueInternalEnvelope({
      organizationId: outcome.organizationId,
      organizationRevision: 0,
      type: 'RESULT_AVAILABLE',
      fromNodeId: childId,
      fromSessionId: outcome.childSessionId,
      toNodeId: outcome.managerNodeId,
      taskId: '',
      payloadRef: { kind: 'result_packet', packetId: outcome.packet, aggregationId: idValue },
      subject: `Result available: ${outcome.packet}`.slice(0, 240),
      idempotencyKey: `${idValue}:result:${childId}:${outcome.packet}`,
    });
    await appendOrganizationEvent({
      organizationId: outcome.organizationId,
      eventKey: `${idValue}:result:${childId}:${outcome.packet}`,
      type: 'result.available',
      nodeId: childId,
      envelopeId: envelope.envelopeId,
      payloadRef: { kind: 'result_packet', packetId: outcome.packet, aggregationId: idValue },
      payload: { managerNodeId: outcome.managerNodeId },
    });
    return { ...outcome.aggregation, resultEnvelope: envelope };
  }
  return outcome.aggregation;
}

export async function claimManagerAggregation(input = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization aggregation is disabled');
  const aggregation = await ensureAggregation(input);
  const expectedGeneration = input.generation === undefined ? aggregation.generation : input.generation;
  const claimId = text(input.claimId) || id('claim');
  const leaseMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(input.leaseMs) || 300000));
  return mutate((db) => {
    const current = db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(aggregation.aggregationId);
    if (!current) throw error(ORG_AGGREGATION_NOT_READY, 'manager aggregation does not exist', 409);
    if (current.state === 'completed') return rowAggregation(current);
    if (Number(current.generation) !== Number(expectedGeneration)) throw error(ORG_HIERARCHY_CONFLICT, 'aggregation generation is stale', 409);
    if (current.state === 'claimed' && current.lease_until && current.lease_until > nowIso()) {
      if (current.claim_id === claimId) return rowAggregation(current);
      throw error(ORG_HIERARCHY_CONFLICT, 'aggregation is already claimed', 409);
    }
    const expectedChildren = parseJson(current.expected_child_node_ids_json, []);
    const expectedPackets = parseJson(current.expected_packet_ids_json, []);
    const refs = parseJson(current.received_packet_refs_json, []);
    if (!expectedChildren.every((child) => refs.some((ref) => ref.childNodeId === child)) || !expectedPackets.every((packet) => refs.some((ref) => ref.packetId === packet))) {
      throw error(ORG_AGGREGATION_NOT_READY, 'direct child result barrier is incomplete', 409);
    }
    const nextGeneration = Number(current.generation) + 1;
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const changed = db.prepare(`UPDATE manager_aggregations SET state = 'claimed', generation = ?, claim_id = ?, lease_until = ?, updated_at = ?
      WHERE aggregation_id = ? AND generation = ? AND state IN ('ready', 'claimed')`).run(
      nextGeneration, claimId, leaseUntil, nowIso(), current.aggregation_id, current.generation);
    if (changed.changes !== 1) throw error(ORG_HIERARCHY_CONFLICT, 'aggregation claim changed concurrently', 409);
    return rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(current.aggregation_id));
  });
}

export async function createBoundedAggregation({ aggregationId, expectedGeneration, createAggregationRun } = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization aggregation is disabled');
  if (typeof createAggregationRun !== 'function') throw error(ORG_HIERARCHY_INVALID, 'aggregation run factory is required', 503);
  const idValue = ensureId(aggregationId, 'aggregationId');
  const current = await getManagerAggregation(idValue);
  if (!current) throw error(ORG_AGGREGATION_NOT_READY, 'manager aggregation does not exist', 409);
  if (expectedGeneration !== undefined && Number(current.generation) !== Number(expectedGeneration)) {
    throw error(ORG_HIERARCHY_CONFLICT, 'aggregation generation is stale', 409, {
      actualGeneration: current.generation,
      expectedGeneration,
    });
  }
  if (current.state === 'completed' && current.aggregationRunId) return current;
  if (current.state !== 'claimed') throw error(ORG_AGGREGATION_NOT_READY, 'manager aggregation is not claimed', 409);
  const packetRefs = current.receivedPacketRefs.map((ref) => ({ ...ref }));
  const result = await createAggregationRun({ aggregationId: idValue, organizationId: current.organizationId, managerNodeId: current.managerNodeId, generation: current.generation, packetRefs });
  const runId = ensureId(result?.runId, 'aggregation runId');
  return mutate((db) => {
    const changed = db.prepare(`UPDATE manager_aggregations SET state = 'completed', aggregation_run_id = ?, lease_until = NULL, updated_at = ?
      WHERE aggregation_id = ? AND state = 'claimed' AND generation = ?`).run(runId, nowIso(), idValue, current.generation);
    if (changed.changes !== 1) throw error(ORG_HIERARCHY_CONFLICT, 'aggregation completion changed concurrently', 409);
    return rowAggregation(db.prepare('SELECT * FROM manager_aggregations WHERE aggregation_id = ?').get(idValue));
  });
}

export async function cancelOrganizationDescendants({ organizationId, rootNodeId, reason = 'organization cancelled' } = {}, { cancelManagedSession, cancelCollaboration: cancelCollab = cancelCollaboration } = {}) {
  assertOrganizationCapability('hierarchicalDelegation', 'hierarchical organization cancellation is disabled');
  const orgId = ensureId(organizationId, 'organizationId');
  const rootId = ensureId(rootNodeId, 'rootNodeId');
  if (typeof cancelManagedSession !== 'function') throw error(ORG_HIERARCHY_INVALID, 'managed-session cancel factory is required', 503);
  const root = await getNode(rootId);
  if (!root || root.organizationId !== orgId) throw error(ORG_HIERARCHY_INVALID, 'root node is not in organization', 400);
  const nodes = await read((db) => {
    const result = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const parent = queue.shift();
      const children = db.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? AND parent_node_id = ? ORDER BY id').all(orgId, parent);
      for (const child of children) { result.push(child); queue.push(child.id); }
    }
    return result;
  });
  const cancelled = [];
  for (const node of nodes) {
    const envelope = await enqueueInternalEnvelope({
      organizationId: orgId,
      organizationRevision: 0,
      type: 'CANCEL_REQUESTED',
      fromNodeId: rootId,
      fromSessionId: root.currentSessionId,
      toNodeId: node.id,
      toSessionId: node.currentSessionId,
      payloadRef: { kind: 'organization_cancel', rootNodeId: rootId },
      subject: text(reason).slice(0, 240) || 'Organization cancellation',
      idempotencyKey: `cancel:${orgId}:${rootId}:${node.id}`,
    });
    await cancelManagedSession({ organizationId: orgId, node, sessionId: node.currentSessionId, reason });
    if (typeof cancelCollab === 'function') await cancelCollab({ organizationId: orgId, nodeId: node.id, sessionId: node.currentSessionId, reason });
    cancelled.push({ nodeId: node.id, envelope });
  }
  await appendOrganizationEvent({ organizationId: orgId, eventKey: `cancel:${orgId}:${rootId}`, type: 'organization.cancel_requested', nodeId: rootId, actorNodeId: rootId, payloadRef: { kind: 'organization_cancel', rootNodeId: rootId }, payload: { reason: text(reason) || 'Organization cancellation', descendantCount: nodes.length } });
  return { organizationId: orgId, rootNodeId: rootId, cancelled };
}
