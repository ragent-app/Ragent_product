import { createHash, randomUUID } from 'node:crypto';
import { getRun, getRunManifest, listRunIndexEntries, updateRun } from './runs.mjs';
import { authorizeRootOrganizationCreate } from './collaboration-capability.mjs';
import { processRootLeadershipProposal, ORGANIZATION_PROPOSAL_START, ORGANIZATION_PROPOSAL_END } from './organization-leader-ingress.mjs';
import { getOrganizationByRootSession, listRevisions } from './organization-store.mjs';
import { canonicalJson } from './execution-scope.mjs';
import { resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';
import { collaborationCapabilityOperationsForRun } from './collaboration-capability.mjs';

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
  if (['completed', 'failed', 'rejected'].includes(claim.state)) {
    let repair = claim.repair || null;
    if (repair?.requestId && ['launching', 'unconfirmed'].includes(repair.state)) {
      const candidates = await listRunIndexEntries({ sessionId });
      const matches = candidates.filter((entry) => entry.requestId === repair.requestId);
      if (matches.length === 1) repair = { ...repair, runId: matches[0].id, observedState: matches[0].state };
      else repair = { ...repair, reason: matches.length ? 'ambiguous_runs' : 'reconciliation_required' };
    }
    if (repair) { const { grantId, ...visibleRepair } = repair; repair = visibleRepair; }
    return { state: claim.state, result: claim.result || null, ...(repair ? { repair } : {}) };
  }
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

export async function processOrganizationPlan({ session, runId, authorizationRunId = runId, proposal, source = 'marker', processor = processRootLeadershipProposal }) {
  if (!session || session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user' || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) {
    return { attempted: false, skipped: 'not_root_leadership' };
  }
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
    if (authorizationRunId !== runId) {
      const repairManifest = await getRunManifest(authorizationRunId);
      const repairRun = await getRun(authorizationRunId);
      const originalManifest = await getRunManifest(runId);
      if (!repairRun || repairRun.sessionId !== session.id || repairRun.state !== 'completed' ||
          repairManifest?.internalOperation !== 'organization_plan_repair' || repairManifest?.organizationPlanRootRunId !== runId ||
          repairManifest?.tool !== originalManifest?.tool || repairManifest?.runtimeFamily !== originalManifest?.runtimeFamily ||
          repairManifest?.options?.model !== originalManifest?.options?.model ||
          (repairManifest?.options?.providerProfile || '') !== (originalManifest?.options?.providerProfile || '') ||
          repairManifest?.options?.readOnlyRequired !== true ||
          repairManifest?.requestId !== run?.organizationPlanIngress?.repair?.requestId || repairRun.cancelRequested || run?.cancelRequested ||
          run?.organizationPlanIngress?.repair?.sessionId !== session.id || !run?.organizationPlanIngress?.repair?.grantId ||
          Date.now() >= run?.organizationPlanIngress?.repair?.expiresAt ||
          run?.organizationPlanIngress?.source !== 'marker' || run?.organizationPlanIngress?.repair?.sourceDigest !== run?.organizationPlanIngress?.digest ||
          !['launching', 'started', 'unconfirmed'].includes(run?.organizationPlanIngress?.repair?.state) ||
          (run.organizationPlanIngress.repair.runId && run.organizationPlanIngress.repair.runId !== authorizationRunId)) {
        throw Object.assign(new Error('Repair Run is not bound to this proposal'), { statusCode: 403 });
      }
    }
    if (!run || run.sessionId !== session.id || (source === 'tool' && ['failed', 'completed', 'cancelled'].includes(run.state))) throw Object.assign(new Error('Run is no longer active'), { statusCode: 409 });
    let conflict = false;
    let created = false;
    const requestedKey = String(proposal.idempotencyKey || proposal.proposalId || '').trim();
    const claimed = await updateRun(runId, (current) => {
      if (source === 'tool' && ['failed', 'completed', 'cancelled'].includes(current.state)) { conflict = true; return current; }
      const prior = current.organizationPlanIngress;
      if (prior && prior.digest !== digest) {
        if (prior.state !== 'rejected' || prior.result?.sideEffects !== 'none' || prior.result?.repairable !== true || prior.previousRejections?.length || !requestedKey || requestedKey !== prior.result?.nextProposalKey || requestedKey === prior.proposalKey || (authorizationRunId !== runId && !prior.repair)) { conflict = true; return current; }
        if (authorizationRunId !== runId) {
          // The automatic repair may correct schema details, but cannot change
          // the user's objective, acceptance, budget, runtime constraints, or order.
          const protectedFields = ['objective', 'acceptance', 'budget', 'resolver', 'order', 'metadata'];
          if (protectedFields.some((field) => canonicalJson(prior.proposal?.[field] ?? null) !== canonicalJson(proposal[field] ?? null))) {
            conflict = true;
            return current;
          }
        }
        created = true;
        return { ...current, organizationPlanIngress: { digest, state: 'claimed', proposal, proposalKey: requestedKey, source,
          ...(authorizationRunId !== runId ? { repair: prior.repair } : {}),
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
    const manifest = await getRunManifest(authorizationRunId);
    const authorization = { session, runId: authorizationRunId, turnId: manifest?.requestId, marker: source === 'marker' };
    let result;
    try {
      const authorizeRepair = async (consume = false) => {
        const { getSession } = await import('./session-manager.mjs');
        const { getApp } = await import('./apps.mjs');
        const fresh = await getSession(session.id);
        const repairRun = await getRun(authorizationRunId);
        const app = fresh?.templateId ? await getApp(fresh.templateId) : null;
        const policy = fresh && resolveSessionCollaborationPolicy(fresh, app);
        const goal = fresh?.goal;
        const budgetUnavailable = ['paused', 'cancelled', 'complete', 'completed', 'blocked'].includes(String(goal?.status || '').toLowerCase()) || (goal?.tokenBudget != null && (!Number.isFinite(goal.tokensUsed) || goal.tokensUsed >= goal.tokenBudget));
        if (budgetUnavailable || !fresh || fresh.sessionClass !== 'ROOT_LEADERSHIP' || (fresh.sessionPlane || 'user') !== 'user' ||
            fresh.userAddressable === false || fresh.parentSessionId || fresh.delegatedFromSessionId ||
            !collaborationCapabilityOperationsForRun({ policy }).includes('collaboration.create') ||
            Number(fresh.delegationDepth || 0) > Number(policy.maxDepth) || repairRun?.state !== 'completed' || repairRun.cancelRequested) {
          throw Object.assign(new Error('Repair authorization is unavailable'), { code: 'ORG_PLAN_FORBIDDEN' });
        }
        let accepted = false;
        await updateRun(runId, (value) => {
          const repair = value.organizationPlanIngress?.repair;
          if (value.cancelRequested || !repair?.grantId || repair.consumed || repair.sessionId !== session.id ||
              repair.requestId !== manifest?.requestId || repair.projectId !== (fresh.projectId || '') || Date.now() >= repair.expiresAt ||
              value.organizationPlanIngress?.digest !== digest) return value;
          accepted = true;
          return consume ? { ...value, organizationPlanIngress: { ...value.organizationPlanIngress, repair: { ...repair, consumed: true } } } : value;
        });
        if (!accepted) throw Object.assign(new Error('Repair authorization is unavailable'), { code: 'ORG_PLAN_FORBIDDEN' });
      };
      const authorize = authorizationRunId === runId
        ? (consume = false) => authorizeRootOrganizationCreate({ ...authorization, consume }) : authorizeRepair;
      await authorize();
      result = await processor({ session, assistantText: `${ORGANIZATION_PROPOSAL_START}\n${encoded}\n${ORGANIZATION_PROPOSAL_END}`,
        projectId: session.projectId || '', turnId: runId,
        afterValidation: () => authorize(true) });
    } catch (error) {
      await updateRun(runId, (current) => current.organizationPlanIngress?.digest === digest
        ? { ...current, organizationPlanIngress: { ...current.organizationPlanIngress, state: 'pending', lastErrorCode: String(error?.code || 'PROCESSING_ERROR').slice(0, 100) } } : current);
      throw error;
    }
    if (result?.repairable === true && result.sideEffects === 'none' && !claimed.organizationPlanIngress.previousRejections?.length) {
      result = { ...result, nextProposalKey: `repair:${randomUUID()}`, nextAction: 'Correct the proposal using nextProposalKey; inspect plan status before retrying an uncertain submission.' };
    }
    await updateRun(runId, (current) => current.organizationPlanIngress?.digest === digest
      ? { ...current, organizationPlanIngress: { ...current.organizationPlanIngress, digest,
        state: result?.state === 'frozen' ? 'completed' : result?.sideEffects === 'none' ? 'rejected' : 'failed', result, source } } : current);
    return result;
  })().finally(() => inFlight.delete(runId));
  inFlight.set(runId, { digest, promise });
  return promise;
}
