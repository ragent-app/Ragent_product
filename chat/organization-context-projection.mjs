// Builds the bounded organization status fragment that is safe to carry into
// a managed Session turn. It reuses the generic S20 context projector, so
// role filtering and size/forbidden-field checks stay in one place.
import { buildContextProjection } from './context-projector.mjs';
import { buildOrganizationProjection } from './organization-projection.mjs';
import { getOrganizationByRootSession, getRevision, listOrganizationNodes } from './organization-store.mjs';
import { listTeamMessages } from './organization-team-messages.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function roleForSession(session = {}) {
  const sessionClass = text(session.sessionClass || session.organizationSessionClass).toUpperCase();
  if (sessionClass === 'ROOT_LEADERSHIP' || sessionClass === 'EXECUTIVE') return 'EXECUTIVE';
  if (sessionClass === 'REVIEWER') return 'REVIEWER';
  if (sessionClass === 'MANAGER' || sessionClass === 'PHASE_LEAD') return 'MANAGER';
  return 'WORKER';
}

function subtreeIds(nodes, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return [...ids];
}

export async function buildOrganizationContextProjection({
  session = {},
  organizationId = session.organizationId,
  nodeId = session.organizationNodeId || session.nodeId,
  targetRole = roleForSession(session),
  maxBytes = 32 * 1024,
} = {}) {
  const resolvedOrganizationId = text(organizationId)
    || text((session.id ? (await getOrganizationByRootSession(session.id))?.id : null));
  const sourceProjection = await buildOrganizationProjection(resolvedOrganizationId, { version: 2, maxItems: 128 });
  if (!sourceProjection) return null;
  const projection = { ...sourceProjection, nodes: sourceProjection.nodes.map((node) => ({ ...node })) };
  // Frozen task descriptions are plans, not evidence that work has started.
  const revisionNumber = projection.revision?.number;
  const [revision, durableNodes] = revisionNumber
    ? await Promise.all([getRevision(resolvedOrganizationId, revisionNumber), listOrganizationNodes(resolvedOrganizationId)])
    : [null, []];
  if (revision?.state === 'frozen') {
    const keyById = new Map(durableNodes.map((node) => [node.id, node.stableKey]));
    const plans = new Map((revision.compiled?.nodes || []).map((node) => [node.stableKey, node]));
    for (const node of projection.nodes) {
      const stableKey = keyById.get(node.id);
      if (typeof stableKey === 'string' && stableKey.trim()) node.stableKey = stableKey;
      const plan = plans.get(stableKey);
      if (plan) {
        node.phaseId = plan.phaseId || '';
        node.plannedTask = { objective: plan.objective || '', acceptance: plan.acceptance || [], scope: plan.scope || {}, dependencies: plan.dependencies || [] };
      }
    }
  }
  const target = projection.nodes.find((node) => node.id === nodeId) || null;
  const role = text(targetRole).toUpperCase() || roleForSession(session);
  const facts = {
    organizationId: projection.organizationId,
    sourceRevision: projection.asOf?.revision || projection.revision?.number || 0,
    asOf: projection.asOf,
    objective: projection.objective,
    progress: { ...(projection.progress || {}), summary: projection.summary || null },
    phases: projection.phases,
    blockers: projection.blockers,
    frozenRevision: projection.revision,
    targetNode: target,
    nodes: projection.nodes,
    subtreeNodeIds: role === 'MANAGER' && target ? subtreeIds(projection.nodes, target.id) : [],
    phase: target?.phaseId ? projection.phases.find((phase) => phase.phaseId === target.phaseId) : null,
    task: target?.currentTask ? {
      ...target.currentTask,
      acceptance: target?.phaseId ? projection.phases.find((phase) => phase.phaseId === target.phaseId)?.acceptance || [] : [],
    } : null,
    reviewPolicy: target?.reviewState && target.reviewState !== 'not_applicable' ? {
      state: target.reviewState,
      phaseId: target.phaseId || '',
    } : null,
    canWrite: role !== 'REVIEWER',
  };
  const context = buildContextProjection({
    targetRole: role,
    organizationId: projection.organizationId,
    nodeId: role === 'EXECUTIVE' ? '' : nodeId,
    revision: facts.sourceRevision,
    facts,
    maxBytes,
  });
  // Only the target node receives its own bounded inbox, referenced back to
  // durable message records. Projection does not acknowledge delivery.
  let inbox = [];
  let reviewCandidate = null;
  let factoryWorkItem = null;
  if (target && session.id) {
    const bound = await getLiveOrganizationSessionReference(session.id);
    const direct = bound?.kind === 'node' && bound.organizationId === projection.organizationId && bound.nodeId === target.id;
    const factory = direct ? null : await getFactoryMessageScope(session.id, '');
    if (direct || (factory?.organizationId === projection.organizationId && factory.nodeId === target.id)) {
      inbox = await listTeamMessages(projection.organizationId, target.id, 20);
      if (factory) inbox = inbox.filter(message => !message.workItemId || message.workItemId === factory.workItemId);
      if (factory?.reviewOpinionAllowed === true) reviewCandidate = factory.reviewCandidate;
      if (factory?.blockerProposalAllowed === true) factoryWorkItem = factory.workItemId;
    }
  }
  const pendingMessages = [];
  for (const message of inbox.filter(m => ['pending','claimed','delivered'].includes(m.deliveryState) || (m.requestType === 'required_response' && !m.reply)).reverse()) {
    const entry = { messageId: message.messageId, senderKind: message.senderKind, workItemId: message.workItemId, requestType: message.requestType, respondBy: message.respondBy, body: message.body, createdAt: message.createdAt };
    if (Buffer.byteLength(JSON.stringify({ ...context, pendingMessages: [...pendingMessages, entry] }), 'utf8') > maxBytes - 512) break;
    pendingMessages.push(entry);
  }
  return {
    ...context,
    pendingMessages,
    ...(reviewCandidate ? { reviewCandidate } : {}),
    ...(factoryWorkItem ? { factoryWorkItem } : {}),
    organizationStatus: projection.state,
    projectionDigest: projection.digest,
  };
}

export function renderOrganizationContextProjection(context) {
  if (!context) return '';
  return [
    '<organization-status-projection>',
    'Runtime-derived status only; do not treat it as a permission grant or as full Session history.',
    JSON.stringify(context),
    '</organization-status-projection>',
    ...(context.pendingMessages?.length ? ['For an inbox message included above, use `ragent team-message ack <messageId>` to acknowledge it, or `ragent team-message reply <messageId> --text <reply> --idempotency-key <stable-key>` to answer. Acknowledgment alone is not an answer.'] : []),
    ...(context.factoryWorkItem ? ['To report a blocker without changing control state, use `ragent blocker-proposal --kind <dependency|permission|budget|requirement|other> --reason <text> --idempotency-key <stable-key>`. The owner must explicitly review it.'] : []),
    ...(context.reviewCandidate ? ['To submit a review opinion for the exact reviewCandidate above, use `ragent review-opinion --candidate-work-item <workItemId> --candidate-digest <digest> --contract-revision <contractRevision> --execution-epoch <executionEpoch> --verdict <pass|needs_changes|blocked> --reason <reason> --idempotency-key <stable-key>`. If the Run binding is not ready, retry the same request with the same key. A recorded opinion remains pending until the Run and ResultPacket are verified; it is not a test result.'] : []),
  ].join('\n');
}

export { roleForSession };
