import { withDatabase, getCollaborationByIdempotencyKey } from './collaboration-store.mjs';
import { getOrganization, getNode } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { getRun, getRunManifest, requestRunCancel } from './runs.mjs';
import { getDefaultCollaborationOrchestrator } from './collaboration-orchestrator.mjs';
import { getFactoryWorkItem, updateFactoryBinding } from './factory-control.mjs';
import { reserveFactoryBudget, settleFactoryBudget } from './organization-governor.mjs';
import { sealFactoryCandidate, verifyFactoryCandidate } from './factory-candidates.mjs';
import { forEachStoredEvent } from './history.mjs';

function refuse(message, code = 'FACTORY_CONFLICT') {
  throw Object.assign(new Error(message), { code, statusCode: 409 });
}
const text = (value) => typeof value === 'string' ? value.trim() : '';
function within(path, root) {
  const child = text(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const parent = text(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return !!child && !!parent && (child === parent || child.startsWith(`${parent}/`));
}
function budgetReservationFor(contract) {
  const explicit = contract?.budgetReservation;
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return explicit;
  const budget = contract?.budget;
  if (Number.isFinite(budget?.maxCost) && budget.maxCost > 0) return { cost: budget.maxCost };
  if (Number.isInteger(budget?.maxTokens) && budget.maxTokens > 0) return { tokens: budget.maxTokens };
  return null;
}

// Profiles constrain admission; they never create permissions or select a runtime.
function profileAllows(db, org, node) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_position_profiles'").get()) return true;
  const row = db.prepare('SELECT profile_json FROM organization_position_profiles WHERE organization_id=? AND node_id=? ORDER BY version DESC LIMIT 1').get(org.id, node.id);
  if (!row) return true;
  let profile, nodeGrant;
  try { profile = JSON.parse(row.profile_json); nodeGrant = JSON.parse(node.grant_json || '{}'); } catch { return false; }
  if (!Number.isInteger(profile?.capacity) || profile.capacity < 1 || !Array.isArray(profile.capabilityRequirements)) return false;
  for (const requirement of profile.capabilityRequirements) {
    if (!['run', 'write', 'review', 'delegate'].includes(requirement)) return false;
    if ((requirement === 'write' && nodeGrant.canWrite !== true)
        || (requirement === 'review' && nodeGrant.canReview !== true)
        || (requirement === 'delegate' && nodeGrant.canDelegate !== true)) return false;
    const grant = db.prepare(`SELECT allow,scope_json FROM organization_grants WHERE organization_id=? AND node_id=?
      AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1`).get(org.id, node.id, requirement, org.current_revision);
    if (!grant?.allow) return false;
    let scope;
    try { scope = JSON.parse(grant.scope_json || '{}'); } catch { return false; }
    if ((scope.projectId && scope.projectId !== org.project_id)
        || Object.keys(scope).some((key) => !['projectId', 'writablePaths'].includes(key))) return false;
  }
  // Existing atomic claim permits at most one active item per node.
  return true;
}

// Called immediately before the existing outbox sends a Factory task. A lease
// fences scheduling, while binding, authorization and reservation facts fence
// the task; none of these facts claim to terminate a previous process.
export async function assertFactoryExecutionFence(context) {
  const managedSession = context?.managedSessionId && await getSession(context.managedSessionId);
  if (!managedSession || managedSession.tool !== context.runtimeTool) refuse('Factory managed session runtime changed');
  return withDatabase((db) => {
    const item = db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(context?.workItemId, context?.organizationId);
    const binding = db.prepare('SELECT * FROM factory_execution_bindings WHERE dispatch_key=? AND work_item_id=?').get(context?.dispatchKey, context?.workItemId);
    const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(context?.organizationId);
    const node = item && db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assignee_node_id, context.organizationId);
    const lease = db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(context?.organizationId);
    const runtimeIdentity = binding && db.prepare('SELECT * FROM factory_binding_runtime_identity WHERE binding_id=?').get(binding.id);
    if (!item || !binding || !org || !node || !lease || lease.expires_at <= new Date().toISOString()
        || lease.owner_token !== context.leaseOwnerToken || lease.generation !== context.leaseGeneration
        || item.ownership !== 'active' || item.control_state !== 'none' || item.state !== 'claimed'
        || binding.status !== 'intent' || item.contract_revision !== context.contractRevision
        || item.execution_epoch !== context.executionEpoch || item.binding_generation !== context.bindingGeneration
        || binding.contract_revision !== context.contractRevision || binding.execution_epoch !== context.executionEpoch
        || binding.binding_generation !== context.bindingGeneration || node.binding_generation !== context.bindingGeneration
        || node.current_session_id !== context.managedSessionId || node.retired_revision !== null
        || ['archived', 'lifecycle_pending'].includes(org.state)
        || org.current_revision !== context.organizationRevision || !profileAllows(db, org, node)
        || !runtimeIdentity || runtimeIdentity.session_id !== context.managedSessionId
        || runtimeIdentity.tool !== context.runtimeTool) refuse('Factory dispatch fence or current authorization changed');
    const contractRow = db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?')
      .get(item.id, context.contractRevision);
    let contract, grant;
    try { contract = JSON.parse(contractRow?.contract_json || '{}'); grant = JSON.parse(node.grant_json || '{}'); }
    catch { refuse('Factory contract or grant is unreadable'); }
    const paths = contract.accessMode === 'read' ? [] : (Array.isArray(contract.allowedPaths) ? contract.allowedPaths : []);
    const granted = Array.isArray(grant.writablePaths) ? grant.writablePaths : [];
    if (contract.organizationRevision !== org.current_revision || org.project_id !== item.project_id
        || (paths.length && (grant.canWrite !== true || paths.some((path) => !granted.some((root) => within(path, root)))))) {
      refuse('Factory contract is outside the current organization grant');
    }
    for (const capability of paths.length ? ['run', 'write'] : ['run']) {
      const effective = db.prepare(`SELECT * FROM organization_grants WHERE organization_id=? AND node_id=?
        AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1`)
        .get(context.organizationId, node.id, capability, org.current_revision);
      if (!effective?.allow) refuse(`Factory ${capability} grant is missing or revoked`);
      let scope;
      try { scope = JSON.parse(effective.scope_json || '{}'); } catch { refuse('Factory grant scope is unreadable'); }
      if (scope.projectId && scope.projectId !== item.project_id) refuse('Factory grant project changed');
      if (capability === 'write' && Array.isArray(scope.writablePaths)
          && paths.some((path) => !scope.writablePaths.some((root) => within(path, root)))) refuse('Factory paths exceed the effective write grant');
      if (Object.keys(scope).some((key) => !['projectId', 'writablePaths'].includes(key))) refuse('Factory grant scope is not supported');
    }
    const counter = db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?')
      .get(context.organizationId, context.organizationRevision);
    let reservations = {};
    try { reservations = JSON.parse(counter?.reservations_json || '{}'); } catch { refuse('Budget reservation is unreadable'); }
    if (reservations[context.budgetKey]?.state !== 'reserved') refuse('Factory budget reservation is not active');
    return true;
  });
}

async function executionAuthorityRevoked(organizationId, item, binding) {
  return withDatabase((db) => {
    const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
    const node = db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assigneeNodeId, organizationId);
    if (!org || ['archived', 'lifecycle_pending'].includes(org.state) || !node || node.retired_revision !== null
        || node.binding_generation !== binding.bindingGeneration || !node.current_session_id
        || org.current_revision !== item.contract?.organizationRevision || !profileAllows(db, org, node)) return true;
    const paths = item.contract?.accessMode === 'read' ? [] : (Array.isArray(item.contract?.allowedPaths) ? item.contract.allowedPaths : []);
    let nodeGrant;
    try { nodeGrant = JSON.parse(node.grant_json || '{}'); } catch { return true; }
    const nodePaths = Array.isArray(nodeGrant.writablePaths) ? nodeGrant.writablePaths : [];
    if (paths.length && (nodeGrant.canWrite !== true || paths.some((path) => !nodePaths.some((root) => within(path, root))))) return true;
    for (const capability of paths.length ? ['run', 'write'] : ['run']) {
      const grant = db.prepare(`SELECT * FROM organization_grants WHERE organization_id=? AND node_id=?
        AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1`).get(organizationId, node.id, capability, org.current_revision);
      if (!grant?.allow) return true;
      let scope;
      try { scope = JSON.parse(grant.scope_json || '{}'); } catch { return true; }
      if ((scope.projectId && scope.projectId !== item.projectId)
          || Object.keys(scope).some((key) => !['projectId', 'writablePaths'].includes(key))
          || (capability === 'write' && Array.isArray(scope.writablePaths)
            && paths.some((path) => !scope.writablePaths.some((root) => within(path, root))))) return true;
    }
    return false;
  });
}

export function createFactoryExecutionAdapter({ organizationId, actor, orchestrator = getDefaultCollaborationOrchestrator() } = {}) {
  if (!organizationId || !actor) throw new Error('Factory adapter requires an organization and trusted actor');
  async function admit(item) {
    const [org, node] = await Promise.all([getOrganization(organizationId), getNode(item.assigneeNodeId)]);
    if (!org || ['archived', 'lifecycle_pending'].includes(org.state) || !node || item.projectId !== org.projectId || item.contract?.organizationRevision !== org.currentRevision
        || node.organizationId !== organizationId || !node.currentSessionId || node.retiredRevision !== null) return { allowed: false, reason: 'binding_changed' };
    const session = await getSession(node.currentSessionId);
    const profileAllowed = await withDatabase((db) => {
      const currentOrg = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
      const currentNode = db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assigneeNodeId, organizationId);
      return !!currentOrg && !!currentNode && profileAllows(db, currentOrg, currentNode);
    });
    if (!profileAllowed) return { allowed: false, reason: 'position_capability_requirements_unmet' };
    const paths = item.contract.accessMode !== 'read' && Array.isArray(item.contract.allowedPaths) ? item.contract.allowedPaths : [];
    const granted = Array.isArray(node.grant?.writablePaths) ? node.grant.writablePaths : [];
    if (!session || session.sessionPlane !== 'organization' || !session.templateId || !session.tool || !session.model || !session.effort
        || (paths.length && (node.grant?.canWrite !== true || paths.some((path) => !granted.some((root) => within(path, root)))))) {
      return { allowed: false, reason: 'runtime_or_grant_unavailable' };
    }
    if (!budgetReservationFor(item.contract)) return { allowed: false, reason: 'budget_reservation_required' };
    return { allowed: true };
  }
  async function dispatch({ item, binding }, lease) {
    if (!lease?.ownerToken || !Number.isInteger(lease.generation)) refuse('Current scheduler lease is required');
    const [org, node] = await Promise.all([getOrganization(organizationId), getNode(item.assigneeNodeId)]);
    const session = node && await getSession(node.currentSessionId);
    if (!(await admit(item)).allowed || !session) refuse('Factory admission changed');
    const budgetKey = `factory:${binding.id}`;
    await reserveFactoryBudget({ organizationId, revision: item.contract.organizationRevision, reservationId: budgetKey,
      idempotencyKey: budgetKey, delta: { ...budgetReservationFor(item.contract), runs: 1 } });
    const detail = (await getFactoryWorkItem(organizationId, item.id, actor)).item;
    const candidateInputs = detail.dependencies.filter((dependency) => dependency.milestone === 'candidate_ready');
    let validationWorkspace = null;
    const { findFactoryCombinationValidation, prepareFactoryCombinationValidation } = await import('./factory-integration-queue.mjs');
    const combination = await findFactoryCombinationValidation(organizationId,item.id,actor);
    if (combination && candidateInputs.length) refuse('Combination validation cannot reuse a single-candidate dependency');
    if (combination) {
      validationWorkspace = await prepareFactoryCombinationValidation({ organizationId, workItemId: item.id, binding, actor });
    } else if (candidateInputs.length) {
      const { prepareFactoryValidationWorkspace } = await import('./factory-validation-workspace.mjs');
      validationWorkspace = await prepareFactoryValidationWorkspace({ organizationId, workItemId: item.id, binding, actor });
    }
    const context = { organizationId, workItemId: item.id, contractRevision: binding.contractRevision,
      executionEpoch: binding.executionEpoch, bindingGeneration: binding.bindingGeneration,
      dispatchKey: binding.dispatchKey, managedSessionId: node.currentSessionId,
      organizationRevision: item.contract.organizationRevision, budgetKey,
      leaseOwnerToken: lease.ownerToken, leaseGeneration: lease.generation, runtimeTool: session.tool,
      ...(validationWorkspace ? { validationWorkspace } : {}) };
    await assertFactoryExecutionFence(context);
    const role = text(node.nodeRole).toLowerCase() === 'reviewer' ? 'reviewer' : 'specialist';
    const paths = item.contract.accessMode === 'read' ? [] : (item.contract.allowedPaths || []);
    const runtime = { tool: session.tool, model: session.model, effort: session.effort,
      ...(session.providerProfile ? { provider: session.providerProfile } : {}) };
    const policy = { role: 'manager', canDelegate: true, canWrite: node.grant?.canWrite === true,
      canReview: node.grant?.canReview === true, maxChildren: 1, maxConcurrent: 1,
      workspacePolicy: 'shared-exclusive', accessMode: paths.length ? 'write' : 'read',
      executionIsolation: node.grant?.executionIsolation || 'shared', allowedAgentIds: [session.templateId],
      allowedRoles: [role], organizationId, organizationNodeId: node.id, organizationBindingGeneration: node.bindingGeneration };
    const collaboration = await orchestrator.dispatchFactory({ rootSessionId: org.rootSessionId, projectId: org.projectId,
      idempotencyKey: binding.dispatchKey, policy, plan: { version: 1, title: item.contract.objective,
        tasks: [{ id: item.id, objective: item.contract.objective, agentId: session.templateId, role,
          acceptance: item.contract.acceptanceCriteria.map((criterion) => text(criterion.description || criterion.id)),
          writablePaths: paths, projectId: org.projectId, managedSessionId: node.currentSessionId,
          accessMode: paths.length ? 'write' : 'read', executionIsolation: node.grant?.executionIsolation || 'shared',
          runtime, retry: { maxAttempts: 1, retryOn: [] } }] } }, context);
    return reconcile(item, collaboration, lease);
  }
  async function reconcile(item, known = null, lease = null) {
    const latest = (await getFactoryWorkItem(organizationId, item.id, actor)).item;
    const binding = latest.bindings.find((entry) => entry.contractRevision === latest.contractRevision
      && entry.executionEpoch === latest.executionEpoch && entry.bindingGeneration === latest.bindingGeneration);
    if (!binding) return null;
    const revoked = ['intent', 'running', 'unknown'].includes(binding.status)
      && await executionAuthorityRevoked(organizationId, latest, binding);
    const org = await getOrganization(organizationId);
    const collaboration = known || (binding.collaborationId ? await orchestrator.get(binding.collaborationId)
      : await getCollaborationByIdempotencyKey(org.rootSessionId, binding.dispatchKey));
    if (!collaboration && binding.status === 'intent' && latest.controlState === 'none' && lease && !revoked) {
      return dispatch({ item: latest, binding }, lease);
    }
    if (!collaboration) {
      if (revoked && binding.status !== 'unknown') return updateFactoryBinding({ organizationId, workItemId: latest.id,
        expectedVersion: latest.rowVersion, contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch,
        bindingGeneration: binding.bindingGeneration, action: 'block', payload: { reason: { code: 'authorization_revoked' } } }, actor);
      return null;
    }
    const attempt = collaboration.attempts.find((entry) => entry.runId);
    if (revoked && !attempt?.runId && binding.status !== 'unknown') {
      return updateFactoryBinding({ organizationId, workItemId: latest.id, expectedVersion: latest.rowVersion,
        contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch, bindingGeneration: binding.bindingGeneration,
        action: 'block', payload: { reason: { code: 'authorization_revoked' } } }, actor);
    }
    const actualRun = attempt?.runId ? await getRun(attempt.runId) : null;
    if (actualRun && ['completed', 'failed', 'cancelled'].includes(actualRun.state)
        && collaboration.policy?.factoryExecution?.budgetKey) {
      let usage = null;
      await forEachStoredEvent(attempt.sessionId, (event) => {
        if (event.runId === attempt.runId && event.type === 'usage' && event.usageScope === 'provider_turn_total'
            && event.costSource === 'provider_reported' && Number.isFinite(event.costUsd) && event.costUsd >= 0
            && Number.isInteger(event.usageAccountingTokens) && event.usageAccountingTokens >= 0
            && Number.isInteger(event.seq) && (!usage || event.seq > usage.seq)) usage = event;
      }, { strict: true });
      if (usage) {
        const context = collaboration.policy.factoryExecution;
        await settleFactoryBudget({ organizationId, revision: context.organizationRevision,
          reservationId: context.budgetKey, idempotencyKey: context.budgetKey,
          backendUsage: { runs: 1, tokens: usage.usageAccountingTokens, cost: usage.costUsd } });
      }
      // Absence of a provider-total record is unknown, not zero: keep reserved.
    }
    if ((latest.controlState === 'cancel_requested' || latest.controlState === 'pause_requested' || revoked) && attempt?.runId) {
      const run = actualRun;
      if (run?.state === 'cancelled' && attempt.state === 'cancelled') {
        return updateFactoryBinding({ organizationId, workItemId: latest.id, expectedVersion: latest.rowVersion,
          contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch,
          bindingGeneration: binding.bindingGeneration, action: 'confirm_stopped',
          payload: { stopEvidenceRef: `run:${attempt.runId}` } }, actor, {
          verifyTerminal: ({ db, binding: current, payload }) => {
            const actual = db.prepare('SELECT state,run_id FROM collaboration_attempts WHERE id=? AND task_id=?')
              .get(attempt.id, attempt.taskId);
            return actual?.state === 'cancelled' && actual.run_id === attempt.runId
              && (!current.runId || current.runId === attempt.runId) && payload.stopEvidenceRef === `run:${attempt.runId}`;
          },
        });
      }
      if (run && !['completed', 'failed', 'cancelled'].includes(run.state) && !run.cancelRequested) await requestRunCancel(attempt.runId);
      if (revoked && binding.status !== 'unknown') {
        await updateFactoryBinding({ organizationId, workItemId: latest.id, expectedVersion: latest.rowVersion,
          contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch, bindingGeneration: binding.bindingGeneration,
          action: 'block', payload: { reason: { code: 'authorization_revoked', runId: attempt.runId } } }, actor);
      }
      return { cancellationRequested: true, runId: attempt.runId, terminalState: run?.state || 'unknown' };
    }
    if (binding.status === 'intent' && attempt?.runId) {
      const bound = await updateFactoryBinding({ organizationId, workItemId: latest.id, expectedVersion: latest.rowVersion,
        contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch,
        bindingGeneration: binding.bindingGeneration, action: 'bind_run', payload: {
          collaborationId: collaboration.id, taskId: attempt.taskId, attemptId: attempt.id, runId: attempt.runId,
        } }, actor);
      if (collaboration.policy?.factoryExecution?.validationWorkspace) {
        const { bindFactoryValidationWorkspace } = await import('./factory-validation-workspace.mjs');
        await bindFactoryValidationWorkspace({ organizationId, item: bound.item, binding: bound.binding, attempt, actor });
      }
      try {
        const { recordAcceptedTeamMessageInputs } = await import('./organization-team-messages.mjs');
        await recordAcceptedTeamMessageInputs({ sessionId: attempt.sessionId, runId: attempt.runId, manifest: await getRunManifest(attempt.runId) });
      } catch (error) { console.error('[factory] Team message receipt pending:', error?.message || String(error)); }
      return bound;
    }
    if (binding.status === 'running' && attempt?.runId === binding.runId) {
      if (collaboration.policy?.factoryExecution?.validationWorkspace) {
        const { bindFactoryValidationWorkspace } = await import('./factory-validation-workspace.mjs');
        await bindFactoryValidationWorkspace({ organizationId, item: latest, binding, attempt, actor });
      }
      try {
        const { recordAcceptedTeamMessageInputs } = await import('./organization-team-messages.mjs');
        await recordAcceptedTeamMessageInputs({ sessionId: attempt.sessionId, runId: attempt.runId, manifest: await getRunManifest(attempt.runId) });
      } catch (error) { console.error('[factory] Team message receipt pending:', error?.message || String(error)); }
    }
    if (binding.status === 'running' && attempt?.state === 'succeeded' && attempt.runId === binding.runId) {
      const session = await getSession(attempt.sessionId);
      const workspace = session?.sourceContext?.managedWriter;
      if (!workspace || !collaboration.policy?.factoryExecution) return { state: 'candidate_unavailable' };
      const sealed = await sealFactoryCandidate({ context: collaboration.policy.factoryExecution, workspace, runId: attempt.runId });
      return updateFactoryBinding({ organizationId, workItemId: latest.id, expectedVersion: latest.rowVersion,
        contractRevision: binding.contractRevision, executionEpoch: binding.executionEpoch,
        bindingGeneration: binding.bindingGeneration, action: 'submit_candidate', payload: sealed }, actor,
      { verifyCandidate: verifyFactoryCandidate });
    }
    return { collaborationId: collaboration.id, runId: attempt?.runId || '' };
  }
  return { admit, dispatch, reconcile };
}
