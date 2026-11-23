// Reconciles and idempotently persists `phase.completed` events for
// review-optional phases (`reviewPolicy.required === false`) once all phase
// nodes complete without blockers, active tasks, or open/blocking gates.
import { createHash } from 'node:crypto';
import { listCollaborationRecords, withDatabase } from './collaboration-store.mjs';
import {
  appendOrganizationEvent,
  ensureOrganizationMessageEnvelopeSchema,
  listOrganizationEvents,
} from './organization-messaging.mjs';
import { isAppendOnlyRevisionCompatible } from './organization-revision-compatibility.mjs';
import { collectOrganizationStatus, isPhaseReviewRequired } from './organization-status-projection.mjs';
import {
  getOrganization,
  getRevision,
  listOrganizationGates,
  listOrganizationNodes,
} from './organization-store.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function phaseCompletedEventKey(organizationId, revision, phaseId) {
  const phaseDigest = createHash('sha256').update(phaseId).digest('hex').slice(0, 16);
  const safePhase = phaseId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'phase';
  return `phase-completed:${organizationId}:r${revision}:${safePhase}:${phaseDigest}`.slice(0, 255);
}

function latestCollaborationsByNode(collaborations = [], organizationId) {
  const byNode = new Map();
  for (const collaboration of Array.isArray(collaborations) ? collaborations : []) {
    if (collaboration?.policy?.organizationId !== organizationId) continue;
    const nodeId = text(collaboration?.policy?.organizationNodeId);
    if (!nodeId) continue;
    const current = byNode.get(nodeId);
    if (
      !current
      || timestamp(collaboration.updatedAt) > timestamp(current.updatedAt)
      || (timestamp(collaboration.updatedAt) === timestamp(current.updatedAt)
        && text(collaboration.id).localeCompare(text(current.id)) < 0)
    ) {
      byNode.set(nodeId, collaboration);
    }
  }
  return byNode;
}

export { isPhaseReviewRequired };

/**
 * Persists `phase.completed` idempotently for any frozen phase whose
 * `reviewPolicy.required === false`, that has no open/blocking review gate,
 * and whose nodes have all completed with zero blockers and zero active tasks.
 */
export async function reconcileReviewOptionalPhaseCompletions({
  organizationId,
  revision = null,
  phaseIds = null,
  allowPendingAggregation = false,
  organization = null,
  revisionRow = null,
  nodes = null,
  gates = null,
  collaborations = null,
  events = null,
  status = null,
  runResolver,
  resultPacketResolver,
} = {}) {
  const orgId = text(organizationId || organization?.id);
  if (!orgId) return [];
  const org = organization || await getOrganization(orgId);
  if (!org || ['archived', 'lifecycle_pending'].includes(org.state)) return [];

  const targetRevision = Number.isInteger(revision) && revision >= 1 ? revision : org.currentRevision;
  if (!Number.isInteger(targetRevision) || targetRevision < 1) return [];

  const rev = revisionRow || await getRevision(orgId, targetRevision);
  if (!rev || rev.state !== 'frozen') return [];

  const compiled = plain(rev.compiled) ? rev.compiled : {};
  const proposal = plain(rev.proposal) ? rev.proposal : {};
  const reviewPolicy = plain(compiled.reviewPolicy)
    ? compiled.reviewPolicy
    : (plain(proposal.reviewPolicy) ? proposal.reviewPolicy : null);
  if (!reviewPolicy || reviewPolicy.required !== false) return [];

  const compiledPhases = Array.isArray(compiled.phases) ? compiled.phases : [];
  const filterSet = Array.isArray(phaseIds) && phaseIds.length > 0
    ? new Set(phaseIds.map(text).filter(Boolean))
    : null;
  const candidatePhases = filterSet
    ? compiledPhases.filter((entry) => filterSet.has(text(entry?.phaseId)))
    : compiledPhases;
  if (candidatePhases.length === 0) return [];

  const alreadyCompleted = await withDatabase((db) => {
    ensureOrganizationMessageEnvelopeSchema(db);
    const rows = db.prepare(`SELECT phase_id, organization_revision FROM organization_events
      WHERE organization_id = ? AND organization_revision <= ? AND type IN ('phase.completed', 'phase_completed')`)
      .all(orgId, targetRevision);
    const completed = new Set();
    for (const row of rows) {
      const pid = text(row.phase_id);
      if (pid && isAppendOnlyRevisionCompatible(db, orgId, row.organization_revision, targetRevision)) {
        completed.add(pid);
      }
    }
    return completed;
  }, { mutate: true });

  const unresolvedPhases = candidatePhases.filter((entry) => {
    const pid = text(entry?.phaseId);
    return pid && !alreadyCompleted.has(pid);
  });
  if (unresolvedPhases.length === 0) return [];

  const [allNodes, allGates, allCollaborations, allEvents] = await Promise.all([
    nodes ?? listOrganizationNodes(orgId),
    gates ?? listOrganizationGates(orgId),
    collaborations ?? listCollaborationRecords({ activeOnly: false }),
    events ?? listOrganizationEvents(orgId, { limit: 5000, latest: true }),
  ]);

  const resolvedStatus = status || await collectOrganizationStatus({
    organizationId: orgId,
    organization: org,
    revision: rev,
    nodes: allNodes,
    events: allEvents,
    gates: allGates,
    collaborations: allCollaborations,
    ...(typeof runResolver === 'function' ? { runResolver } : {}),
    ...(typeof resultPacketResolver === 'function' ? { resultPacketResolver } : {}),
  });
  if (!resolvedStatus) return [];

  const collaborationByNode = allowPendingAggregation
    ? latestCollaborationsByNode(allCollaborations, orgId)
    : null;
  const compiledNodes = Array.isArray(compiled.nodes) ? compiled.nodes : [];
  const persisted = [];

  for (const compiledPhase of unresolvedPhases) {
    const phaseId = text(compiledPhase?.phaseId);
    if (!phaseId) continue;
    const phaseStatus = resolvedStatus.phases?.find((entry) => text(entry.phaseId) === phaseId);
    if (!phaseStatus) continue;
    const phaseNodes = (resolvedStatus.nodes || []).filter((entry) => text(entry.phaseId) === phaseId);
    if (isPhaseReviewRequired(compiled, proposal, compiledPhase, phaseNodes)) continue;

    const gateState = text(phaseStatus.gate?.state);
    if (gateState && ['open', 'decided', 'needs_changes'].includes(gateState)) continue;

    const total = Number(phaseStatus.progress?.total || 0);
    const blocked = Number(phaseStatus.progress?.blocked || 0);
    const activeTasks = Number(phaseStatus.progress?.activeTasks || 0);
    if (total <= 0 || phaseNodes.length === 0 || blocked > 0 || activeTasks > 0) continue;

    const expectedPhaseNodes = compiledNodes.filter((entry) => text(entry?.phaseId) === phaseId);
    if (
      expectedPhaseNodes.length === 0
      || !expectedPhaseNodes.every((entry) => phaseNodes.some((node) => node.displayName === text(entry.stableKey)))
    ) {
      continue;
    }

    let allNodesDone = true;
    let succeededWorkNodes = 0;
    for (const nodeStatus of phaseNodes) {
      if (nodeStatus.status === 'completed') {
        succeededWorkNodes += 1;
      } else if (nodeStatus.status === 'replaced') {
        continue;
      } else if (
        allowPendingAggregation
        && nodeStatus.status === 'waiting_children'
        && !nodeStatus.blocker
      ) {
        const collab = collaborationByNode?.get(text(nodeStatus.id));
        const tasks = Array.isArray(collab?.tasks) ? collab.tasks : [];
        if (
          collab
          && ['completed', 'waiting_aggregation', 'aggregating'].includes(collab.state)
          && tasks.length > 0
          && tasks.every((task) => task.state === 'succeeded')
        ) {
          succeededWorkNodes += 1;
        } else {
          allNodesDone = false;
          break;
        }
      } else {
        allNodesDone = false;
        break;
      }
    }
    if (!allNodesDone || succeededWorkNodes === 0) continue;

    const event = await appendOrganizationEvent({
      organizationId: orgId,
      eventKey: phaseCompletedEventKey(orgId, targetRevision, phaseId),
      type: 'phase.completed',
      organizationRevision: targetRevision,
      phaseId,
      payload: {
        phaseId,
        organizationRevision: targetRevision,
        autoCompleted: true,
        reviewRequired: false,
      },
    });
    persisted.push(event);
  }

  return persisted;
}
