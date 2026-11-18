import { createHash } from 'node:crypto';
import { canonicalJson } from './execution-scope.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';
import { getNode, isOrganizationRevisionCompatible } from './organization-store.mjs';
import { listBuiltinSkills, readBuiltinSkill } from './builtin-skills.mjs';
import { acknowledgeAgentInterruption, resolveAgentInterruption, getAgentInterruption, listAgentInterruptions } from './agent-interruption-notifications.mjs';

function stateResponse(projection, previousDigest) {
  const stable = projection && typeof projection === 'object' ? { ...projection } : projection;
  if (stable && typeof stable === 'object') delete stable.generatedAt;
  const digest = createHash('sha256').update(canonicalJson(stable)).digest('hex');
  return previousDigest === digest ? { unchanged: true, digest } : { unchanged: false, digest, projection };
}

const fail = () => Object.assign(new Error('A current scoped organization Run is required'), { statusCode: 403, code: 'ORG_TOOL_FORBIDDEN' });

export async function executeOrganizationControlTool({ authSession, action, args = {} }) {
  const scope = authSession?.organizationMessageScope;
  if (authSession?.principalKind !== 'run_capability') throw fail();
  if (authSession.capabilityOperation === 'session.organization.tools') {
    const { getSession } = await import('./session-manager.mjs');
    const session = await getSession(authSession.sessionId);
    if (!session || session.sessionPlane === 'organization') throw fail();
    const authorize = async ({ id }) => ['ragent:builtin:session-control', 'ragent:builtin:calendar'].includes(id) ||
      (session.sessionClass === 'ROOT_LEADERSHIP' && id === 'ragent:builtin:root');
    if (action === 'candidates.query') {
      const { queryAuthorizedRuntimeCandidates } = await import('./organization-candidate-query.mjs');
      return queryAuthorizedRuntimeCandidates({ authSession, session, args });
    }
    if (action === 'state.get') {
      if (session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user' ||
          session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) throw fail();
      const { buildOrganizationContextProjection } = await import('./organization-context-projection.mjs');
      return stateResponse(await buildOrganizationContextProjection({ session }), args.ifDigest);
    }
    if (action === 'plan.submit') {
      const { submitOrganizationPlan } = await import('./organization-plan-tool.mjs');
      return submitOrganizationPlan({ authSession, proposal: args.proposal });
    }
    if (action === 'plan.status') {
      const { getOrganizationPlanStatus } = await import('./organization-plan-tool.mjs');
      return getOrganizationPlanStatus({ authSession });
    }
    if (action === 'skills.list') return { skills: await listBuiltinSkills({ authorize }) };
    if (action === 'skills.read') {
      if (typeof args.id !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash || '')) throw Object.assign(new Error('Skill id and current content hash are required'), { statusCode: 400 });
      return readBuiltinSkill({ id: args.id, expectedHash: args.expectedHash, authorize });
    }
    if (action === 'incidents.list') return { incidents: await listAgentInterruptions({ authSession, limit: args.limit }) };
    if (action === 'incident.get') return getAgentInterruption({ incidentId: args.incidentId, authSession });
    if (action === 'incident.ack') return acknowledgeAgentInterruption({ incidentId: args.incidentId, authSession });
    if (action === 'incident.resolve') return resolveAgentInterruption({ incidentId: args.incidentId, authSession, summary: args.summary, evidence: args.evidence });
    throw Object.assign(new Error('Unknown organization tool'), { statusCode: 400 });
  }
  if (authSession.capabilityOperation !== 'organization.tools' || !scope) throw fail();
  const direct = await getLiveOrganizationSessionReference(authSession.sessionId);
  const current = direct?.kind === 'node' ? direct : await getFactoryMessageScope(authSession.sessionId, '');
  if (!current || current.organizationId !== scope.organizationId || current.nodeId !== scope.nodeId ||
      current.bindingGeneration !== scope.bindingGeneration ||
      (current.organizationRevision !== scope.organizationRevision && !await isOrganizationRevisionCompatible(scope.organizationId, scope.organizationRevision, current.organizationRevision)) ||
      (scope.attemptId && current.attemptId !== scope.attemptId)) throw fail();
  const node = await getNode(scope.nodeId);
  if (!node || node.organizationId !== scope.organizationId || node.bindingGeneration !== scope.bindingGeneration) throw fail();
  const role = ({ MANAGER: 'manager', PHASE_LEAD: 'manager', WORKER: 'worker', REVIEWER: 'reviewer', EXECUTIVE: 'root' })[String(node.sessionClass || '').toUpperCase()];
  const authorize = async ({ id }) => ['ragent:builtin:session-control', 'ragent:builtin:calendar'].includes(id) || (!!role && id === `ragent:builtin:${role}`);
  if (action === 'candidates.query') {
    const { getSession } = await import('./session-manager.mjs');
    const session = await getSession(authSession.sessionId);
    const { queryAuthorizedRuntimeCandidates } = await import('./organization-candidate-query.mjs');
    return queryAuthorizedRuntimeCandidates({ authSession, session, args });
  }
  if (action === 'subtree.append') {
    const { appendManagerSubtree } = await import('./organization-manager-append.mjs');
    return appendManagerSubtree({ authSession, scope, args });
  }
  if (action === 'node.dispatch') {
    const childNodeId = typeof args.childNodeId === 'string' ? args.childNodeId.trim() : '';
    if (!childNodeId || childNodeId.length > 160) throw Object.assign(new Error('Child node is required'), { statusCode: 400 });
    const delegation = { parentNodeId: node.id, parentSessionId: authSession.sessionId, parentRunId: authSession.runId,
      revision: scope.organizationRevision, bindingGeneration: scope.bindingGeneration };
    const { verifyOrganizationDelegation } = await import('./organization-delegation-authorization.mjs');
    const { child, organization } = await verifyOrganizationDelegation({ organizationId: scope.organizationId, childNodeId, delegation });
    const { getRevision } = await import('./organization-store.mjs');
    const revision = await getRevision(organization.id, organization.currentRevision);
    const plan = revision?.compiled?.nodes?.find((entry) => entry.stableKey === child.stableKey);
    if (!plan?.phaseId) throw fail();
    const { dispatchOrganizationPhase } = await import('./organization-phase-dispatch.mjs');
    return dispatchOrganizationPhase({ organizationId: organization.id, revision: organization.currentRevision,
      phaseId: plan.phaseId, idempotencyKey: `manager:${node.id}:revision:${organization.currentRevision}:child:${child.id}`, childNodeId, organizationDelegation: delegation });
  }
  if (action === 'state.get') {
    const { getSession } = await import('./session-manager.mjs');
    const session = await getSession(authSession.sessionId);
    if (!session || session.organizationId !== scope.organizationId || session.organizationNodeId !== scope.nodeId) throw fail();
    const { buildOrganizationContextProjection } = await import('./organization-context-projection.mjs');
    return stateResponse(await buildOrganizationContextProjection({ session }), args.ifDigest);
  }
  if (action === 'skills.list') return { skills: await listBuiltinSkills({ authorize }) };
  if (action === 'skills.read') {
    if (typeof args.id !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash || '')) throw Object.assign(new Error('Skill id and current content hash are required'), { statusCode: 400 });
    return readBuiltinSkill({ id: args.id, expectedHash: args.expectedHash, authorize });
  }
  if (action === 'incidents.list') return { incidents: await listAgentInterruptions({ authSession, limit: args.limit }) };
  if (action === 'incident.get') return getAgentInterruption({ incidentId: args.incidentId, authSession });
  if (action === 'incident.ack') return acknowledgeAgentInterruption({ incidentId: args.incidentId, authSession });
  if (action === 'incident.resolve') return resolveAgentInterruption({ incidentId: args.incidentId, authSession, summary: args.summary, evidence: args.evidence });
  throw Object.assign(new Error('Unknown organization tool'), { statusCode: 400 });
}
