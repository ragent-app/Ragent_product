import { createHash } from 'node:crypto';
import { getRun, getRunManifest, updateRun } from './runs.mjs';
import { getApp } from './apps.mjs';
import { assertManagerCanDelegate, resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';
import { processRootLeadershipProposal, ORGANIZATION_PROPOSAL_START, ORGANIZATION_PROPOSAL_END } from './organization-leader-ingress.mjs';
import { getOrganizationByRootSession, listRevisions } from './organization-store.mjs';
import { canonicalJson } from './execution-scope.mjs';

const inFlight = new Map();
export async function getOrganizationPlanStatus({ authSession }) {
  if (authSession?.principalKind !== 'run_capability' || authSession.capabilityOperation !== 'session.organization.tools') throw Object.assign(new Error('Root Run required'), { statusCode: 403 });
  return inspectOrganizationPlan({ sessionId: authSession.sessionId, runId: authSession.runId });
}
export async function inspectOrganizationPlan({ sessionId, runId }) {
  const run = await getRun(runId);
  if (!run || run.sessionId !== sessionId) throw Object.assign(new Error('Run unavailable'), { statusCode: 403 });
  const claim = run.organizationPlanIngress;
  if (!claim) return { state: 'not_submitted' };
  if (['completed', 'failed', 'rejected'].includes(claim.state)) return { state: claim.state, result: claim.result || null };
  const key = String(claim.proposal?.idempotencyKey || claim.proposal?.proposalId || '').trim();
  const org = key ? await getOrganizationByRootSession(run.sessionId) : null;
  const revisions = org ? await listRevisions(org.id) : [];
  const expected = `leader:${run.sessionId}:turn:${run.id}:${key}`;
  const revision = revisions.find((entry) => entry.idempotencyKey === expected);
  if (revision?.state === 'frozen') {
    const result = { attempted: true, state: 'frozen', organizationId: org.id, revision: revision.revision,
      digest: revision.digest || null, provisioning: { attempted: false, state: 'unknown', reason: 'recovered_revision_only' } };
    await updateRun(run.id, (current) => current.organizationPlanIngress?.digest === claim.digest
      ? { ...current, organizationPlanIngress: { digest: claim.digest, state: 'completed', source: claim.source, result } } : current);
    return { state: 'completed', result };
  }
  return { state: claim.state, reason: claim.lastErrorCode || 'reconciliation_required',
    observed: revision ? { organizationId: org.id, revision: revision.revision, state: revision.state, digest: revision.digest || null } : null };
}
export async function submitOrganizationPlan({ authSession, proposal }) {
  if (authSession?.principalKind !== 'run_capability' || authSession.capabilityOperation !== 'session.organization.tools' ||
      !proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw Object.assign(new Error('An authorized root Run and proposal are required'), { statusCode: 403 });
  }
  const runId = authSession.runId;
  const { getSession } = await import('./session-manager.mjs');
  const session = await getSession(authSession.sessionId);
  if (!session || session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user' || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) {
    throw Object.assign(new Error('Root Leadership Run required'), { statusCode: 403 });
  }
  return processOrganizationPlan({ session, runId, proposal, source: 'tool' });
}

export async function processOrganizationPlan({ session, runId, proposal, source = 'marker', processor = processRootLeadershipProposal }) {
  if (!session || session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user' || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) {
    return { attempted: false, skipped: 'not_root_leadership' };
  }
  const manifest = await getRunManifest(runId);
  const granted = manifest?.sessionId === session.id && (manifest?.options?.collaborationCapabilities || []).some((cap) =>
    cap.operation === 'collaboration.create' && cap.resource?.type === 'session' && cap.resource.id === session.id
    && cap.selection?.runId === runId && cap.selection?.turnId === manifest.requestId
    && Date.parse(cap.expiresAt || '') > Date.now());
  if (!granted) throw Object.assign(new Error('Organization planning is not authorized for this Run'), { code: 'ORG_PLAN_FORBIDDEN', statusCode: 403 });
  const app = session.templateId ? await getApp(session.templateId) : null;
  assertManagerCanDelegate(resolveSessionCollaborationPolicy(session, app), { depth: session.delegationDepth || 0 });
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw Object.assign(new Error('Proposal is required'), { statusCode: 400 });
  const encoded = canonicalJson(proposal);
  if (Buffer.byteLength(encoded, 'utf8') > 128 * 1024) throw Object.assign(new Error('Proposal is too large'), { statusCode: 413 });
  const digest = createHash('sha256').update(encoded).digest('hex');
  const previous = inFlight.get(runId);
  if (previous) {
    if (previous.digest !== digest) throw Object.assign(new Error('A different proposal already owns this Run'), { statusCode: 409 });
    return previous.promise;
  }
  const promise = (async () => {
    const run = await getRun(runId);
    if (!run || run.sessionId !== session.id || (source === 'tool' && ['failed', 'completed', 'cancelled'].includes(run.state))) throw Object.assign(new Error('Run is no longer active'), { statusCode: 409 });
    let conflict = false;
    let created = false;
    const requestedKey = String(proposal.idempotencyKey || proposal.proposalId || '').trim();
    const claimed = await updateRun(runId, (current) => {
      if (source === 'tool' && ['failed', 'completed', 'cancelled'].includes(current.state)) { conflict = true; return current; }
      const prior = current.organizationPlanIngress;
      if (prior && prior.digest !== digest) {
        if (prior.state !== 'rejected' || prior.result?.sideEffects !== 'none' || !requestedKey || requestedKey === prior.proposalKey) { conflict = true; return current; }
        created = true;
        return { ...current, organizationPlanIngress: { digest, state: 'claimed', proposal, proposalKey: requestedKey, source,
          previousRejections: [...(prior.previousRejections || []), { digest: prior.digest, proposalKey: prior.proposalKey, code: prior.result?.code || null }].slice(-20) } };
      }
      if (current.organizationPlanIngress) return current;
      created = true;
      return { ...current, organizationPlanIngress: { digest, state: 'claimed', proposal, proposalKey: requestedKey, source } };
    });
    if (conflict || !claimed?.organizationPlanIngress) throw Object.assign(new Error('A different proposal already owns this Run'), { statusCode: 409 });
    if (['completed', 'failed', 'rejected'].includes(claimed.organizationPlanIngress.state)) return claimed.organizationPlanIngress.result;
    if (!created) return { attempted: true, state: 'pending', reason: 'reconciliation_required', message: 'The original proposal operation requires reconciliation.' };
    await updateRun(runId, (current) => current.organizationPlanIngress?.digest === digest
      ? { ...current, organizationPlanIngress: { ...current.organizationPlanIngress, state: 'pending' } } : current);
    let result;
    try {
      result = await processor({ session, assistantText: `${ORGANIZATION_PROPOSAL_START}\n${encoded}\n${ORGANIZATION_PROPOSAL_END}`,
        projectId: session.projectId || '', turnId: runId });
    } catch (error) {
      await updateRun(runId, (current) => current.organizationPlanIngress?.digest === digest
        ? { ...current, organizationPlanIngress: { ...current.organizationPlanIngress, state: 'pending', lastErrorCode: String(error?.code || 'PROCESSING_ERROR').slice(0, 100) } } : current);
      throw error;
    }
    await updateRun(runId, (current) => current.organizationPlanIngress?.digest === digest
      ? { ...current, organizationPlanIngress: { ...current.organizationPlanIngress, digest,
        state: result?.state === 'frozen' ? 'completed' : result?.sideEffects === 'none' ? 'rejected' : 'failed', result, source } } : current);
    return result;
  })().finally(() => inFlight.delete(runId));
  inFlight.set(runId, { digest, promise });
  return promise;
}
