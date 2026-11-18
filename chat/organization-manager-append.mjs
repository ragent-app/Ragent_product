import { createHash } from 'node:crypto';
import { getApp } from './apps.mjs';
import { getRun, getRunManifest } from './runs.mjs';
import { assertAgentAllowed, assertManagerCanDelegate, resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';
import { canonicalJson, scopeContainsPath } from './execution-scope.mjs';
import { getOrganization, getNode, getRevision, listOrganizationNodes, appendFrozenManagerRevision,
  getManagerAppendOperation, updateManagerAppendOperation, isOrganizationRevisionCompatible } from './organization-store.mjs';
import { buildOrganizationAgentProfiles } from './organization-leader-ingress.mjs';
import { compileOrganizationProposal } from './organization-planner.mjs';
import { buildOrganizationRuntimeCatalog, resolveRuntimeSelection } from './organization-runtime-selection.mjs';
import { selectRuntimeConstraints, assertRuntimeConstraints } from './organization-runtime-decision.mjs';
import { readSessionRuntimeConstraints } from './session-collaboration-settings.mjs';
import { provisionFrozenRevision } from './organization-provisioning.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';

const error = (message, code = 'ORG_APPEND_CONFLICT') => Object.assign(new Error(message), { code, statusCode: 409 });
const text = (value) => typeof value === 'string' ? value.trim() : '';

// Entry is reachable only after organization.tools verifies the current Run.
export async function appendManagerSubtree({ authSession, scope, args = {} }) {
  const key = text(args.operationKey);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw error('operationKey must be 1-100 characters using only ASCII letters, digits, underscore, period, or hyphen', 'ORG_APPEND_INVALID');
  if (!Number.isInteger(args.expectedRevision)) throw error('expectedRevision must be an integer identifying the current frozen revision', 'ORG_APPEND_INVALID');
  if (!Array.isArray(args.nodes) || !args.nodes.length || args.nodes.length > 16) throw error('nodes must be an array of 1-16 new nodes', 'ORG_APPEND_INVALID');
  if (!Array.isArray(args.manages)) throw error('manages must be an array of parentKey/childKey edges', 'ORG_APPEND_INVALID');
  if (args.phases != null && !Array.isArray(args.phases)) throw error('phases must be an array when provided', 'ORG_APPEND_INVALID');
  const parent = await getNode(scope.nodeId);
  const organization = parent && await getOrganization(parent.organizationId);
  if (!parent || !organization || parent.organizationId !== scope.organizationId || parent.currentSessionId !== authSession.sessionId
      || parent.bindingGeneration !== scope.bindingGeneration || parent.retiredRevision !== null || parent.lifecycleState !== 'active'
      || parent.grant?.canDelegate !== true || !Number.isInteger(parent.grant.maxDepth) || parent.grant.maxDepth < 1) throw error('Manager authorization unavailable', 'ORG_APPEND_FORBIDDEN');
  const operationKey = `manager-append:${parent.id}:${key}`;
  const requestDigest = createHash('sha256').update(canonicalJson({ expectedRevision: args.expectedRevision,
    nodes: args.nodes, phases: args.phases || [], manages: args.manages })).digest('hex');
  const existing = await getManagerAppendOperation(organization.id, operationKey);
  if (existing) {
    if (existing.parentNodeId !== parent.id || existing.requestDigest !== requestDigest) throw error('Operation key belongs to a different request');
    if (existing.state === 'completed') return { state: 'dispatched', operationKey, revision: existing.revision, reason: 'already_dispatched' };
    if (existing.state === 'conflict') return { state: 'conflict', operationKey, revision: existing.revision, reason: 'replan_required' };
    return finishAppend({ organization, parent, authSession, scope, operationKey, revisionNumber: existing.revision,
      constraintsRevision: existing.constraintsRevision, newNodeKeys: existing.newNodeKeys });
  }
  if (organization.currentRevision !== args.expectedRevision) throw error('Organization revision changed');
  const revision = await getRevision(organization.id, args.expectedRevision);
  if (revision?.state !== 'frozen' || !revision.proposal || !revision.compiled) throw error('Frozen revision unavailable');
  const oldKeys = new Set((revision.proposal.nodes || []).map((node) => node.stableKey));
  if (args.nodes.some((node) => !node || oldKeys.has(node.stableKey))) throw error('Only new nodes may be added', 'ORG_APPEND_INVALID');
  const proposal = { ...revision.proposal, nodes: [...revision.proposal.nodes, ...args.nodes],
    phases: [...revision.proposal.phases, ...(args.phases || [])], manages: [...revision.proposal.manages, ...args.manages] };
  const { getSession } = await import('./session-manager.mjs');
  const rootSession = await getSession(organization.rootSessionId);
  if (!rootSession) throw error('Root policy unavailable', 'ORG_APPEND_FORBIDDEN');
  const managerSession = await getSession(authSession.sessionId);
  if (!managerSession) throw error('Manager policy unavailable', 'ORG_APPEND_FORBIDDEN');
  const managerApp = managerSession.templateId ? await getApp(managerSession.templateId) : null;
  const managerPolicy = resolveSessionCollaborationPolicy(managerSession, managerApp);
  assertManagerCanDelegate(managerPolicy, { depth: managerSession.delegationDepth || 0 });
  const rootApp = rootSession.templateId ? await getApp(rootSession.templateId) : null;
  const rootPolicy = resolveSessionCollaborationPolicy(rootSession, rootApp);
  assertManagerCanDelegate(rootPolicy, { depth: rootSession.delegationDepth || 0 });
  const ownerConstraints = await readSessionRuntimeConstraints(organization.rootSessionId);
  const catalog = await buildOrganizationRuntimeCatalog();
  const runtimeDecisionByNode = Object.fromEntries(proposal.nodes.map((node) => [node.stableKey, {
    constraints: selectRuntimeConstraints(ownerConstraints.constraints, ['organization', `node:${node.stableKey}`]), catalog,
  }]));
  const profiles = await buildOrganizationAgentProfiles();
  const frozenNodeByKey = Object.fromEntries(revision.compiled.nodes.map((node) => [node.stableKey, node]));
  const explicitRootPolicy = rootApp?.collaborationPolicy || rootSession.collaborationPolicy || rootSession.collaborationPolicyOverrides;
  const rootGrant = explicitRootPolicy
    ? { ...rootPolicy, accessMode: rootPolicy.canWrite === false ? 'read_only' : rootPolicy.accessMode } : {};
  const planned = await compileOrganizationProposal(proposal, { profiles, runtimeDecisionByNode, frozenNodeByKey, rootGrant });
  const oldCompiled = new Map(revision.compiled.nodes.map((node) => [node.stableKey, node]));
  planned.compiled.nodes = planned.compiled.nodes.map((node) => oldCompiled.get(node.stableKey) || node);
  const parentCapabilities = parent.grant.allowedCapabilities || [];
  const parentPaths = parent.grant.writablePaths || [];
  for (const node of planned.compiled.nodes.filter((node) => !oldKeys.has(node.stableKey))) {
    if ((node.grant?.allowedCapabilities || []).some((cap) => !parentCapabilities.includes(cap))) throw error('New node expands parent capabilities', 'ORG_APPEND_FORBIDDEN');
    for (const path of node.grant?.writablePaths || []) {
      if (!(await Promise.all(parentPaths.map((root) => scopeContainsPath(root, path)))).some(Boolean)) throw error('New node expands parent path scope', 'ORG_APPEND_FORBIDDEN');
    }
    if (!node.runtimeDecision?.selected) throw error('New node requires a resolved runtime', 'ORG_APPEND_INVALID');
    assertRuntimeConstraints(node.runtimeDecision.selected, selectRuntimeConstraints(ownerConstraints.constraints, ['organization', `node:${node.stableKey}`]));
    const profile = profiles.find((item) => (item.agentId || item.id) === node.agentId);
    if (!profile) throw error('Agent profile unavailable', 'ORG_APPEND_INVALID');
    const taskRole = node.role === 'reviewer' ? 'reviewer' : ['manager', 'phase_lead', 'executive'].includes(node.role) ? 'manager' : 'specialist';
    assertAgentAllowed(rootPolicy, node.agentId, taskRole);
    assertAgentAllowed(managerPolicy, node.agentId, taskRole);
    const requested = Object.fromEntries(['tool', 'provider', 'model', 'effort']
      .filter((field) => typeof node.runtimeDecision.selected[field] === 'string' && node.runtimeDecision.selected[field].trim())
      .map((field) => [field, node.runtimeDecision.selected[field]]));
    await resolveRuntimeSelection({ requested, profile, parentGrant: parent.grant });
  }
  planned.digest = createHash('sha256').update(canonicalJson(planned.compiled)).digest('hex');
  const recheck = async () => {
    const current = await readSessionRuntimeConstraints(organization.rootSessionId);
    const run = await getRun(authSession.runId);
    const manifest = await getRunManifest(authSession.runId);
    const channelScope = manifest?.options?.sessionControlChannel?.scope;
    if (!run || run.sessionId !== authSession.sessionId || ['completed','failed','cancelled'].includes(run.state)
        || manifest?.sessionId !== authSession.sessionId || channelScope?.nodeId !== parent.id
        || channelScope.organizationId !== organization.id || channelScope.bindingGeneration !== scope.bindingGeneration
        || channelScope.organizationRevision !== scope.organizationRevision) throw error('Run authorization changed', 'ORG_APPEND_FORBIDDEN');
    if (current.revision !== ownerConstraints.revision) throw error('Owner constraints changed; replan required', 'ORG_APPEND_CONSTRAINT_CHANGED');
  };
  await recheck();
  const frozen = await appendFrozenManagerRevision({ organizationId: organization.id, expectedRevision: args.expectedRevision,
    parentNodeId: parent.id, parentSessionId: authSession.sessionId, bindingGeneration: scope.bindingGeneration,
    proposal: planned.proposal, compiled: planned.compiled, digest: planned.digest, idempotencyKey: operationKey,
    constraintsRevision: ownerConstraints.revision, requestDigest });
  return finishAppend({ organization, parent, authSession, scope, operationKey, revisionNumber: frozen.revision,
    constraintsRevision: ownerConstraints.revision, newNodeKeys: args.nodes.map((node) => node.stableKey) });
}

async function finishAppend({ organization, parent, authSession, scope, operationKey, revisionNumber, constraintsRevision, newNodeKeys }) {
  const revision = await getRevision(organization.id, revisionNumber);
  if (revision?.state !== 'frozen') throw error('Frozen operation revision unavailable');
  const newKeys = new Set(newNodeKeys);
  const recheck = async () => {
    const current = await readSessionRuntimeConstraints(organization.rootSessionId);
    const freshOrg = await getOrganization(organization.id);
    const freshParent = await getNode(parent.id);
    const run = await getRun(authSession.runId);
    const manifest = await getRunManifest(authSession.runId);
    const channelScope = manifest?.options?.sessionControlChannel?.scope;
    if (!run || run.sessionId !== authSession.sessionId || ['completed','failed','cancelled'].includes(run.state)
        || manifest?.sessionId !== authSession.sessionId || channelScope?.nodeId !== parent.id
        || channelScope.organizationId !== organization.id || channelScope.bindingGeneration !== scope.bindingGeneration
        || channelScope.organizationRevision !== scope.organizationRevision) throw error('Run authorization changed', 'ORG_APPEND_FORBIDDEN');
    if (current.revision !== constraintsRevision) throw error('Owner constraints changed; replan required', 'ORG_APPEND_CONSTRAINT_CHANGED');
    if (!freshOrg || !freshParent || freshParent.currentSessionId !== authSession.sessionId
        || freshParent.bindingGeneration !== scope.bindingGeneration || freshParent.retiredRevision !== null
        || freshParent.lifecycleState !== 'active' || freshParent.grant?.canDelegate !== true
        || !await isOrganizationRevisionCompatible(organization.id, revisionNumber, freshOrg.currentRevision))
      throw error('Manager binding or revision changed', 'ORG_APPEND_CONFLICT');
  };
  try {
    const result = await provisionFrozenRevision({ organizationId: organization.id, revision: revisionNumber,
      createManagedSession: createManagedSessionForNode, beforeNode: recheck });
    const nodes = await listOrganizationNodes(organization.id);
    const newNodes = nodes.filter((node) => newKeys.has(node.stableKey));
    if (result.state !== 'provisioned' || newNodes.length !== newKeys.size
        || newNodes.some((node) => !node.currentSessionId || node.retiredRevision !== null || node.lifecycleState !== 'active'))
      throw error('Provisioning incomplete; reconciliation required', 'ORG_PROVISION_PENDING');
    const created = newNodes.map((node) => ({ nodeId: node.id, stableKey: node.stableKey, sessionId: node.currentSessionId }));
    const direct = newNodes.filter((node) => node.parentNodeId === parent.id);
    const expectedDirect = (revision.compiled.manages || []).filter((edge) => edge.parentKey === parent.stableKey && newKeys.has(edge.childKey)).length;
    if (!expectedDirect || direct.length !== expectedDirect) throw error('Direct child provisioning incomplete', 'ORG_PROVISION_PENDING');
    await updateManagerAppendOperation(organization.id, operationKey, 'provisioned');
    const dispatched = [];
    await updateManagerAppendOperation(organization.id, operationKey, 'dispatching');
    const { dispatchOrganizationPhase } = await import('./organization-phase-dispatch.mjs');
    for (const child of direct) {
      await recheck();
      const plan = revision.compiled.nodes.find((item) => item.stableKey === child.stableKey);
      const delegation = { parentNodeId: parent.id, parentSessionId: authSession.sessionId, parentRunId: authSession.runId,
        revision: scope.organizationRevision, bindingGeneration: scope.bindingGeneration };
      const dispatchKey = `manager:${parent.id}:revision:${revisionNumber}:child:${child.id}`;
      const { getCollaborationByIdempotencyKey } = await import('./collaboration-store.mjs');
      const previous = await getCollaborationByIdempotencyKey(organization.rootSessionId, `${dispatchKey}:${child.stableKey}`);
      if (previous) {
        const binding = previous.policy?.organizationDelegation;
        if (previous.policy?.organizationId !== organization.id || previous.policy?.organizationNodeId !== child.id
            || binding?.parentNodeId !== parent.id || binding?.bindingGeneration !== parent.bindingGeneration)
          throw error('Existing dispatch binding differs; reconciliation required');
        dispatched.push({ nodeId: child.id, state: previous.state, collaborationId: previous.id });
        if (['failed', 'cancelled'].includes(previous.state)) throw error('Existing dispatch requires reconciliation', 'ORG_DISPATCH_RECONCILIATION_REQUIRED');
        continue;
      }
      const outcome = await dispatchOrganizationPhase({ organizationId: organization.id, revision: revisionNumber,
        phaseId: plan.phaseId, idempotencyKey: dispatchKey, childNodeId: child.id, organizationDelegation: delegation });
      dispatched.push({ nodeId: child.id, state: outcome.state });
    }
    await updateManagerAppendOperation(organization.id, operationKey, 'completed');
    return { state: 'dispatched', operationKey, revision: revisionNumber, nodes: created, dispatched,
      message: 'Dispatch was accepted; Run startup and task completion are reported separately.', provision: { attempted: result.attempted, state: result.state } };
  } catch (cause) {
    if (cause?.code === 'ORG_APPEND_CONSTRAINT_CHANGED') await updateManagerAppendOperation(organization.id, operationKey, 'conflict');
    return { state: cause?.code === 'ORG_APPEND_CONSTRAINT_CHANGED' ? 'conflict' : 'pending', operationKey, revision: revisionNumber,
      reason: String(cause?.code || 'ORG_PROVISION_PENDING'), message: 'Revision is frozen; provisioning needs reconciliation.' };
  }
}
