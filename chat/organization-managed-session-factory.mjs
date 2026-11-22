// Real managed-session factory for organization provisioning (S21).
//
// Turns a materialized organization node into a live managed Session with the
// S15 contract: sessionPlane 'organization', an explicit managed sessionClass,
// and complete lineage (organizationRootSessionId, organizationNodeId,
// roleInstanceId, organizationRevision, controllerSessionId). The factory is
// the only place that knows how a node becomes a Session; provisioning and
// replan orchestration consume it through the same injected `createManagedSession`
// interface, so the contract stays testable without a running provider.
//
// The module lazy-imports session-manager inside the factory call instead of at
// top level: session-manager already imports the organization leader ingress,
// and a static import here would create an ESM cycle. Dynamic import defers the
// edge until call time, by which point both modules are fully evaluated.
import { getApp } from './apps.mjs';
import { getOrganization } from './organization-store.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeManagedSessionName(role, stableKey) {
  const normalizedRole = text(role) || 'worker';
  const normalizedKey = text(stableKey) || 'node';
  return `org:${normalizedRole}:${normalizedKey}`;
}

export function inheritSessionRiskOptions(sourceSession) {
  const rawRiskMode = text(sourceSession?.riskMode);
  if (!rawRiskMode) return {};
  const explicitRisk = sourceSession?.riskModeExplicit === true;
  const riskMode = rawRiskMode === 'full-auto' && !explicitRisk ? 'recommended' : rawRiskMode;
  return {
    riskMode,
    ...(explicitRisk && riskMode === rawRiskMode ? { riskModeExplicit: true } : {}),
  };
}

export async function createManagedSessionForNode(input = {}) {
  const {
    organizationId,
    organizationRevision,
    organizationNodeId,
    roleInstanceId,
    stableKey,
    role,
    agentId,
    sessionClass,
    parentNodeId,
    parentSessionId,
    idempotencyKey,
    replacementKey,
    name,
    runtime = {},
  } = input;

  const org = await getOrganization(organizationId);
  if (!org) {
    const error = new Error(`organization ${organizationId} not found`);
    error.code = 'ORGANIZATION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  const rootSessionId = text(org.rootSessionId);
  if (!rootSessionId) {
    const error = new Error(`organization ${organizationId} has no root session`);
    error.code = 'ORG_PROVISIONING_ROOT_SESSION_MISSING';
    error.statusCode = 503;
    throw error;
  }

  // Resolve the provider tool for the selected Agent. The Agent is an app; its
  // tool is the provider runtime the managed Session runs on. A node that
  // resolved to an Agent without a provider cannot run and must fail closed.
  const app = await getApp(agentId);
  const tool = text(runtime?.tool || app?.tool);
  if (!tool) {
    const error = new Error(`agent ${agentId} has no provider tool`);
    error.code = 'ORG_PROVISIONING_AGENT_TOOL_MISSING';
    error.statusCode = 503;
    throw error;
  }

  const { createSession, getSession } = await import('./session-manager.mjs');
  const root = await getSession(rootSessionId);
  if (!root) {
    const error = new Error(`root session ${rootSessionId} not found`);
    error.code = 'ORG_PROVISIONING_ROOT_SESSION_NOT_FOUND';
    error.statusCode = 503;
    throw error;
  }
  const folder = text(root.folder);
  if (!folder) {
    const error = new Error(`root session ${rootSessionId} has no working folder`);
    error.code = 'ORG_PROVISIONING_ROOT_FOLDER_MISSING';
    error.statusCode = 503;
    throw error;
  }
  const controllerSessionId = text(parentSessionId) || rootSessionId;

  const session = await createSession(folder, tool, text(name) || normalizeManagedSessionName(role, stableKey), {
    sessionPlane: 'organization',
    sessionClass,
    organizationRootSessionId: rootSessionId,
    organizationId,
    organizationNodeId,
    roleInstanceId,
    organizationRevision,
    agentId: text(agentId),
    parentNodeId,
    parentSessionId: controllerSessionId,
    controllerSessionId,
    replacementKey: text(replacementKey) || undefined,
    idempotencyKey: text(idempotencyKey) || undefined,
    interactionMode: 'agent',
    userId: 'system',
    userName: 'Organization Runtime',
    description: `Managed ${text(role) || 'worker'} session for organization node ${text(stableKey) || ''}`,
    suppressBroadcast: true,
    ...inheritSessionRiskOptions(root),
    ...(text(runtime?.provider) || text(runtime?.providerProfile)
      ? { providerProfile: text(runtime?.provider || runtime?.providerProfile) }
      : {}),
    ...(text(runtime?.model) ? { model: text(runtime.model) } : {}),
    ...(text(runtime?.effort) ? { effort: text(runtime.effort) } : {}),
  });

  return {
    sessionId: text(session?.id) || text(session?.sessionId),
    runId: text(session?.runId),
    session,
  };
}

// Consultation V1 (C1): create a managed WORKER Session for a consultation
// expert. The expert runs on the managed organization plane but carries
// managedScope === 'consultation', so its lineage is rootSessionId +
// consultationRoundId + expertAssignmentId + controllerSessionId (no
// Organization node/role/revision required). Only the Consultation dispatch
// channel should call this — the produced session is not user-addressable and
// its input-bypass surfaces are rejected by the managed-input gate.
export async function createManagedSessionForConsultation(input = {}) {
  const {
    rootSessionId,
    consultationRoundId,
    expertAssignmentId,
    controllerSessionId,
    role,
    agentId,
    sessionClass = 'WORKER',
    name,
    idempotencyKey,
  } = input;

  // C1 consultation lineage is root + round + assignment + controller. Any
  // missing field is an incomplete consultation lineage (HTTP 409).
  function requireLineageField(value, fieldName) {
    const normalized = text(value);
    if (!normalized) {
      const error = new Error(`consultation lineage field ${fieldName} is required`);
      error.code = 'CONSULTATION_LINEAGE_INCOMPLETE';
      error.statusCode = 409;
      throw error;
    }
    return normalized;
  }
  const root = requireLineageField(rootSessionId, 'rootSessionId');
  const roundId = requireLineageField(consultationRoundId, 'consultationRoundId');
  const assignmentId = requireLineageField(expertAssignmentId, 'expertAssignmentId');
  const controller = requireLineageField(controllerSessionId, 'controllerSessionId');

  // Resolve the provider tool for the selected Agent, fail-closed when the
  // Agent has no provider (aligned with createManagedSessionForNode).
  const app = await getApp(agentId);
  const tool = text(app?.tool);
  if (!tool) {
    const error = new Error(`agent ${agentId} has no provider tool`);
    error.code = 'ORG_PROVISIONING_AGENT_TOOL_MISSING';
    error.statusCode = 503;
    throw error;
  }

  const { createSession, getSession } = await import('./session-manager.mjs');
  const rootSession = await getSession(root);
  if (!rootSession) {
    const error = new Error(`root session ${root} not found`);
    error.code = 'ORG_PROVISIONING_ROOT_SESSION_NOT_FOUND';
    error.statusCode = 503;
    throw error;
  }
  const folder = text(rootSession.folder);
  if (!folder) {
    const error = new Error(`root session ${root} has no working folder`);
    error.code = 'ORG_PROVISIONING_ROOT_FOLDER_MISSING';
    error.statusCode = 503;
    throw error;
  }

  const session = await createSession(folder, tool, text(name) || normalizeManagedSessionName(role, roundId), {
    sessionPlane: 'organization',
    sessionClass,
    managedScope: 'consultation',
    consultationRoundId: roundId,
    expertAssignmentId: assignmentId,
    rootSessionId: root,
    organizationRootSessionId: root,
    controllerSessionId: controller,
    parentSessionId: controller,
    interactionMode: 'agent',
    userId: 'system',
    userName: 'Consultation Runtime',
    description: `Managed consultation expert session for round ${roundId}`,
    suppressBroadcast: true,
    ...inheritSessionRiskOptions(rootSession),
    idempotencyKey: text(idempotencyKey) || undefined,
  });

  return {
    sessionId: text(session?.id) || text(session?.sessionId),
    runId: text(session?.runId),
    session,
  };
}
