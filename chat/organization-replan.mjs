// S22: bounded plan amendments and managed-session replacement.
//
// Amendments are proposal-only until the runtime validates the current head.
// A frozen revision is never updated in place. Session replacement keeps the
// stable OrganizationNode and advances its binding generation with CAS.
import { parseOrganizationProposal, compileOrganizationProposal, parsePlanAmendment } from './organization-planner.mjs';
import { getOrganization, getRevision, createRevisionAtHead, freezeRevision, getNode, getNodeByStableKey, listOrganizationNodes, bindNodeSession, createNode, retireNode, createRoleInstance, bindRoleInstanceNode, createOrganizationEdge, createDelegationGrant } from './organization-store.mjs';
import { createOperation, getOperation, transitionOperation } from './organization-operations.mjs';
import { appendOrganizationEvent, enqueueInternalEnvelope } from './organization-messaging.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';
import { organizationGrantForNode } from './organization-role-contract.mjs';

export const ORG_PLAN_AMENDMENT_STALE_REVISION = 'ORG_PLAN_AMENDMENT_STALE_REVISION';
export const ORG_SESSION_BINDING_CONFLICT = 'ORG_SESSION_BINDING_CONFLICT';
export const ORG_REPLAN_INVALID = 'ORG_REPLAN_INVALID';

function error(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value, fallback = null) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableKey(value, label) {
  const normalized = text(value);
  if (!normalized || normalized.length > 255) throw error(ORG_REPLAN_INVALID, `${label} is required`, 400);
  return normalized;
}

async function transition(operation, nextState, result, operationError = undefined) {
  return transitionOperation(operation.operationId, {
    expectedState: operation.state,
    expectedVersion: operation.version,
    expectedGeneration: operation.generation,
    nextState,
    currentStep: nextState,
    result,
    operationError,
  });
}

function applyAmendmentToProposal(baseProposal, amendment) {
  const proposal = parseOrganizationProposal(baseProposal);
  const nodes = new Map(proposal.nodes.map((node) => [node.stableKey, clone(node)]));
  const removed = new Set();
  for (const operation of amendment.operations) {
    if (operation.operation === 'add') {
      if (nodes.has(operation.stableKey)) throw error(ORG_REPLAN_INVALID, `cannot add existing node ${operation.stableKey}`, 422);
      const contract = object(operation.contract);
      if (!text(contract.role) || !text(contract.agentId) || !text(contract.phaseId)) {
        throw error(ORG_REPLAN_INVALID, `add operation for ${operation.stableKey} requires a node contract`, 422);
      }
      nodes.set(operation.stableKey, { ...contract, stableKey: operation.stableKey });
    } else if (operation.operation === 'retire') {
      if (!nodes.has(operation.stableKey)) throw error(ORG_REPLAN_INVALID, `cannot retire unknown node ${operation.stableKey}`, 422);
      removed.add(operation.stableKey);
    } else if (operation.operation === 'replace') {
      if (!nodes.has(operation.stableKey)) throw error(ORG_REPLAN_INVALID, `cannot replace unknown node ${operation.stableKey}`, 422);
      const contract = object(operation.contract);
      if (Object.keys(contract).length > 0) nodes.set(operation.stableKey, { ...nodes.get(operation.stableKey), ...contract, stableKey: operation.stableKey });
    } else if (!nodes.has(operation.stableKey)) {
      throw error(ORG_REPLAN_INVALID, `cannot retain unknown node ${operation.stableKey}`, 422);
    }
  }
  for (const key of removed) nodes.delete(key);
  const activeKeys = new Set(nodes.keys());
  const manages = proposal.manages.filter((edge) => activeKeys.has(edge.parentKey) && activeKeys.has(edge.childKey));
  const next = {
    ...proposal,
    nodes: [...nodes.values()].map((node) => ({ ...node, dependsOn: (node.dependsOn || []).filter((dependency) => activeKeys.has(dependency)) })),
    manages,
    idempotencyKey: amendment.idempotencyKey,
    proposalId: `${proposal.proposalId}:amend:${amendment.idempotencyKey}`,
    metadata: { ...object(proposal.metadata), amendmentReason: amendment.reason, baseRevision: amendment.baseRevision },
  };
  return next;
}

export async function replaceManagedSession({ organizationId, nodeId, expectedBindingGeneration, replacementKey, rebindCommandId = '', reason = 'managed session replacement' } = {}, {
  createManagedSession,
} = {}) {
  assertOrganizationCapability('dynamicReplan', 'managed-session replacement is disabled');
  const orgId = stableKey(organizationId, 'organizationId');
  const org = await getOrganization(orgId);
  if (!org) throw error('ORGANIZATION_NOT_FOUND', `organization ${orgId} not found`, 404);
  if (['archived','lifecycle_pending'].includes(org.state)) throw error('ORGANIZATION_ARCHIVED', 'organization cannot replace sessions during archive or rebind', 409);
  const node = await getNode(stableKey(nodeId, 'nodeId'));
  if (!node || node.organizationId !== orgId) throw error(ORG_REPLAN_INVALID, 'node is not in organization', 400);
  const generation = Number(expectedBindingGeneration);
  if (!Number.isInteger(generation) || generation < 0) throw error(ORG_SESSION_BINDING_CONFLICT, 'expectedBindingGeneration is required', 409);
  const key = stableKey(replacementKey, 'replacementKey');
  if (typeof createManagedSession !== 'function') throw error(ORG_REPLAN_INVALID, 'managed session replacement factory is required', 503);
  const ensureIdle = async () => {
    const { assertNodeWorkQuiescent } = await import('./organization-session-lifecycle.mjs');
    await assertNodeWorkQuiescent(orgId,node.id,node.currentSessionId);
    if (node.currentSessionId) {
      const [{ getSession }, { getRun }] = await Promise.all([import('./session-manager.mjs'),import('./runs.mjs')]);
      const current = await getSession(node.currentSessionId);
      if (!current) throw error(ORG_SESSION_BINDING_CONFLICT, 'current managed session is unavailable; replacement requires reconciliation', 409);
      if (current.activeRunId) {
        const run = await getRun(current.activeRunId);
        if (!run || !['completed','failed','cancelled'].includes(run.state)) throw error(ORG_SESSION_BINDING_CONFLICT, 'stop or reconcile the current Run before replacement', 409);
      }
    }
  };
  await ensureIdle();
  let session;
  try {
    session = await createManagedSession({
      organizationId: orgId,
      organizationNodeId: node.id,
      organizationRevision: node.createdRevision,
      replacementKey: key,
      previousSessionId: node.currentSessionId,
      role: node.nodeRole,
    });
  } catch (cause) {
    throw error(ORG_REPLAN_INVALID, `managed session replacement failed for ${node.stableKey}`, 503, {
      reason: 'managed_session_replacement_failed',
      stableKey: node.stableKey,
      cause: { code: text(cause?.code), message: text(cause?.message) || String(cause) },
    });
  }
  const sessionId = stableKey(session?.sessionId, 'replacement sessionId');
  let bound;
  try {
    await ensureIdle();
    bound = await bindNodeSession(node.id, {
      expectedBindingGeneration: generation,
      sessionId,
      roleInstanceId: session?.roleInstanceId,
      rebindCommandId,
    });
  } catch (cause) {
    if (cause?.code === 'ORG_OPERATION_CONFLICT') throw error(ORG_SESSION_BINDING_CONFLICT, cause.message, 409, { cause });
    throw cause;
  }
  const event = await appendOrganizationEvent({
    organizationId: orgId,
    eventKey: `${node.id}:session-replaced:${key}`,
    type: 'node.session_replaced',
    organizationRevision: node.createdRevision,
    nodeId: node.id,
    actorNodeId: node.id,
    actorSessionId: sessionId,
    payloadRef: { kind: 'session_replacement', nodeId: node.id, replacementKey: key },
    payload: { oldSessionId: node.currentSessionId, newSessionId: sessionId, bindingGeneration: bound.bindingGeneration, reason: text(reason).slice(0, 240) },
  });
  return { node: bound, sessionId, runId: text(session?.runId), replacementKey: key, event, replay: false };
}

async function reconcileReplacement(operation, amendment, options) {
  const replacements = [];
  for (const item of amendment.operations.filter((entry) => entry.operation === 'replace')) {
    const node = await getNodeByStableKey(amendment.organizationId, item.stableKey);
    if (!node) throw error(ORG_REPLAN_INVALID, `replacement node ${item.stableKey} is missing`, 422);
    const replacement = await replaceManagedSession({
      organizationId: amendment.organizationId,
      nodeId: node.id,
      expectedBindingGeneration: node.bindingGeneration,
      replacementKey: item.replacementKey || `${amendment.idempotencyKey}:${item.stableKey}`,
      reason: item.reason || amendment.reason,
    }, options);
    replacements.push(replacement);
  }
  return replacements;
}

function sessionClassForRole(role) {
  return role === 'reviewer' ? 'REVIEWER' : ['worker', 'specialist'].includes(role) ? 'WORKER' : 'MANAGER';
}

function profileForNode(compiled, stableKey) {
  const node = (compiled?.nodes || []).find((entry) => entry.stableKey === stableKey) || {};
  return {
    role: node.role || 'worker',
    agentId: node.agentId || node.resolver?.selectedAgentId || '',
    capabilities: node.capabilities || [],
    scope: node.scope || {},
    scopes: node.scopes || {},
    parentKey: node.parentKey || '',
    maxChildren: node.maxChildren,
    maxConcurrent: node.maxConcurrent,
    grant: node.grant || {},
  };
}

async function reconcileAddedNodes({ organizationId, revision, proposal, compiled, operations, options }) {
  const added = [];
  const addOperations = operations.filter((entry) => entry.operation === 'add');
  if (addOperations.length > 0 && typeof options.createManagedSession !== 'function') {
    throw error(ORG_REPLAN_INVALID, 'managed session factory is required for add operations', 503);
  }
  const createEdge = typeof options.createOrganizationEdge === 'function'
    ? options.createOrganizationEdge
    : createOrganizationEdge;
  const nodeByKey = new Map();
  for (const node of await listOrganizationNodes(organizationId)) {
    nodeByKey.set(node.stableKey, node);
  }
  for (const item of addOperations) {
    const contract = object(item.contract);
    const profile = profileForNode(compiled, item.stableKey);
    const parent = proposal.nodes.find((node) => node.stableKey === profile.parentKey || node.stableKey === contract.parentKey);
    const parentNode = parent ? nodeByKey.get(parent.stableKey) : null;
    if (!parentNode) throw error(ORG_REPLAN_INVALID, `add operation for ${item.stableKey} requires an existing parent node`, 422);
    const grant = organizationGrantForNode({ ...profile, ...contract }, parentNode.grant || {});
    const roleInstance = await createRoleInstance({
      organizationId,
      organizationRevision: revision,
      stableKey: item.stableKey,
      role: profile.role,
      agentId: profile.agentId,
      capabilityProfile: { capabilities: profile.capabilities, scope: profile.scope, scopes: profile.scopes, grant },
      policy: { ...object(contract.policy), organizationRole: profile.role },
      budget: object(contract.budget),
      idempotencyKey: `${options.idempotencyKey}:add:${item.stableKey}:role`,
    });
    const node = await createNode({
      organizationId,
      stableKey: item.stableKey,
      nodeRole: profile.role,
      createdRevision: revision,
      parentNodeId: parentNode.id,
      depth: Number(parentNode.depth || 0) + 1,
      roleInstanceId: roleInstance.id,
      sessionClass: sessionClassForRole(profile.role),
      grant,
      currentSessionId: '',
      idempotencyKey: `${options.idempotencyKey}:add:${item.stableKey}:node`,
    });
    let session = node.currentSessionId ? { sessionId: node.currentSessionId, runId: '' } : null;
    if (!session) {
      try {
        session = await options.createManagedSession({
          organizationId,
          organizationRevision: revision,
          organizationNodeId: node.id,
          roleInstanceId: roleInstance.id,
          stableKey: item.stableKey,
          role: profile.role,
          agentId: profile.agentId,
          sessionClass: sessionClassForRole(profile.role),
          parentNodeId: parentNode.id,
          parentSessionId: parentNode.currentSessionId,
          idempotencyKey: `${options.idempotencyKey}:add:${item.stableKey}:session`,
          replacementKey: `${options.idempotencyKey}:add:${item.stableKey}`,
        });
      } catch (cause) {
        throw error(ORG_REPLAN_INVALID, `managed session creation failed for ${item.stableKey}`, 503, {
          reason: 'managed_session_factory_failed',
          stableKey: item.stableKey,
          cause: { code: text(cause?.code), message: text(cause?.message) || String(cause) },
        });
      }
    }
    const sessionId = text(session?.sessionId);
    if (!sessionId) throw error(ORG_REPLAN_INVALID, `add operation for ${item.stableKey} did not produce a managed session`, 503);
    const bound = node.currentSessionId
      ? node
      : await bindNodeSession(node.id, {
        expectedBindingGeneration: node.bindingGeneration,
        sessionId,
        roleInstanceId: roleInstance.id,
      });
    await bindRoleInstanceNode(roleInstance.id, node.id);
    let edge;
    try {
      edge = await createEdge({
        organizationId,
        organizationRevision: revision,
        stableKey: `${parentNode.stableKey}:${item.stableKey}`,
        edgeType: 'MANAGES',
        parentNodeId: parentNode.id,
        childNodeId: node.id,
        idempotencyKey: `${options.idempotencyKey}:add:${item.stableKey}:edge`,
      });
    } catch (cause) {
      throw error(ORG_REPLAN_INVALID, `organization edge creation failed for ${item.stableKey}`, 503, {
        reason: 'organization_edge_writer_failed',
        stableKey: item.stableKey,
        cause: { code: text(cause?.code), message: text(cause?.message) || String(cause) },
      });
    }
    const delegationGrant = await createDelegationGrant({
      organizationId,
      organizationRevision: revision,
      parentNodeId: parentNode.id,
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
      idempotencyKey: `${options.idempotencyKey}:add:${item.stableKey}:delegation`,
    });
    nodeByKey.set(item.stableKey, bound);
    added.push({ roleInstance, node: bound, edge, delegationGrant, sessionId, runId: text(session?.runId) });
  }
  return added;
}

export async function applyPlanAmendment({ organizationId, amendment, expectedCurrentRevision = undefined } = {}, options = {}) {
  assertOrganizationCapability('dynamicReplan', 'organization plan amendments are disabled');
  const orgId = stableKey(organizationId, 'organizationId');
  const normalized = parsePlanAmendment(amendment);
  const operationId = `op_${normalized.idempotencyKey}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
  const existing = await getOperation(operationId).catch(() => null);
  if (existing?.state === 'completed' && existing.result) return { ...existing.result, operation: existing, replay: true };
  const org = await getOrganization(orgId);
  if (!org) throw error('ORGANIZATION_NOT_FOUND', `organization ${orgId} not found`, 404);
  if (['archived','lifecycle_pending'].includes(org.state)) throw error('ORGANIZATION_ARCHIVED', 'organization cannot be revised during archive or rebind', 409);
  if (existing && existing.organizationId !== orgId) {
    throw error(ORG_REPLAN_INVALID, `operation ${operationId} belongs to another organization`, 409);
  }
  const journalRevision = Number(existing?.result?.revision?.revision || 0);
  const resumingFacts = existing?.state === 'facts_created'
    && journalRevision > 0
    && Number(org.currentRevision) === journalRevision;
  if (Number(org.currentRevision) !== Number(normalized.baseRevision)
    && !resumingFacts
    || (expectedCurrentRevision !== undefined && Number(expectedCurrentRevision) !== Number(org.currentRevision))) {
    throw error(ORG_PLAN_AMENDMENT_STALE_REVISION, `organization ${orgId} is at revision ${org.currentRevision}, amendment requires ${normalized.baseRevision}`, 409, { currentRevision: org.currentRevision, baseRevision: normalized.baseRevision });
  }
  const base = await getRevision(orgId, normalized.baseRevision);
  if (!base || base.state !== 'frozen') throw error(ORG_REPLAN_INVALID, 'amendment base revision must be frozen', 409);
  let compiled;
  let frozen;
  if (resumingFacts) {
    // The frozen candidate is the compile source of truth after facts_created.
    // Recompiling the base amendment can introduce unrelated budget/resolver
    // failures and hide the runtime effect that needs recovery.
    frozen = await getRevision(orgId, journalRevision);
    if (!frozen || frozen.state !== 'frozen' || !frozen.compiled) {
      throw error(ORG_REPLAN_INVALID, `journal revision ${journalRevision} is not a frozen compiled revision`, 409);
    }
    compiled = { proposal: frozen.proposal, compiled: frozen.compiled, digest: frozen.digest };
  } else {
    const nextProposal = applyAmendmentToProposal(base.proposal, normalized);
    compiled = await compileOrganizationProposal(nextProposal, { ...options, budget: { ...object(org.budget), ...normalized.requestedBudgetDelta } });
  }
  const operation = await createOperation({
    operationId,
    organizationId: orgId,
    commandKind: 'applyPlanAmendment',
    idempotencyKey: normalized.idempotencyKey,
    actorNodeId: text(options.actorNodeId),
    actorSessionId: text(options.actorSessionId),
    revision: normalized.baseRevision,
    payload: normalized,
  });
  let current = operation;
  if (current.state === 'completed' && current.result) return { ...current.result, operation: current, replay: true };
  if (current.state === 'requested' || current.state === 'reconciled') {
    current = await transition(current, 'validated', { baseRevision: normalized.baseRevision, digest: compiled.digest });
  }
  if (current.state === 'validated') {
    const revision = await createRevisionAtHead(orgId, {
      expectedCurrentRevision: normalized.baseRevision,
      proposal: compiled.proposal,
      compiled: compiled.compiled,
      digest: compiled.digest,
      idempotencyKey: normalized.idempotencyKey,
    });
    frozen = await freezeRevision(orgId, revision.revision);
    current = await transition(current, 'facts_created', { revision: frozen });
  } else if (current.state === 'facts_created') {
    // `frozen` was loaded above and must remain immutable during recovery.
  } else {
    throw error(ORG_REPLAN_INVALID, `amendment operation ${current.operationId} cannot resume from ${current.state}`, 409);
  }
  const added = await reconcileAddedNodes({
    organizationId: orgId,
    revision: frozen.revision,
    proposal: compiled.proposal,
    compiled: compiled.compiled,
    operations: normalized.operations,
    options: { ...options, idempotencyKey: normalized.idempotencyKey },
  });
  const retired = [];
  for (const item of normalized.operations.filter((entry) => entry.operation === 'retire')) {
    const node = await getNodeByStableKey(orgId, item.stableKey);
    if (node) retired.push(await retireNode(node.id, { retiredRevision: frozen.revision }));
  }
  const replacements = await reconcileReplacement({ ...current, operationId: current.operationId }, { ...normalized, organizationId: orgId }, options);
  current = await transition(current, 'external_effect_created', { revision: frozen, added, retired, replacements });
  const event = await appendOrganizationEvent({
    organizationId: orgId,
    eventKey: `${normalized.idempotencyKey}:plan-amended`,
    type: 'plan.amended',
    organizationRevision: frozen.revision,
    actorNodeId: text(options.actorNodeId),
    actorSessionId: text(options.actorSessionId),
    payloadRef: { kind: 'revision', revision: frozen.revision, baseRevision: normalized.baseRevision },
    payload: { baseRevision: normalized.baseRevision, digest: compiled.digest, operationCount: normalized.operations.length },
  });
  current = await transition(current, 'bound', { revision: frozen, added, retired, replacements, event });
  current = await transition(current, 'completed', { revision: frozen, added, retired, replacements, event });
  return { organizationId: orgId, revision: frozen, added, retired, replacements, event, operation: current, replay: false };
}

export async function replanOrganization(input = {}, options = {}) {
  return applyPlanAmendment(input, options);
}
