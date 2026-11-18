import { withDatabase } from './collaboration-store.mjs';
import { getOrganization, getNode, getRevision, listRevisions, isOrganizationRevisionCompatible } from './organization-store.mjs';
import { getRun, getRunManifest } from './runs.mjs';
import { getLiveOrganizationSessionReference } from './organization-session-lifecycle.mjs';
import { verifyOrganizationDelegation } from './organization-delegation-authorization.mjs';

// The trigger key selects no authority: it only tells the caller to wait until
// its server-owned incident row has been attached to the new trigger.
export async function incidentContinuationRuntime(trigger, session, eventContext = null) {
  let incident = await withDatabase(db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_interruption_incidents'").get()) return null;
    return db.prepare(`SELECT i.*, c.policy_json FROM agent_interruption_incidents i
      LEFT JOIN collaboration_attempts a ON a.id=i.attempt_id AND a.run_id=i.run_id AND a.session_id=i.session_id
      LEFT JOIN collaboration_tasks t ON t.id=a.task_id
      LEFT JOIN collaborations c ON c.id=t.collaboration_id
      WHERE i.resolved_at IS NULL AND (i.trigger_id=? OR i.escalation_trigger_id=?)`).get(trigger.id, trigger.id);
  });
  if (!incident) {
    const native = await withDatabase(db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_member_interruptions'").get()) return null;
      return db.prepare('SELECT * FROM native_member_interruptions WHERE trigger_id=? AND resolved_at IS NULL').get(trigger.id);
    });
    if (native) {
      if (native.recipient_session_id !== session.id) return null;
      if (!native.organization_id) return { ordinary: true };
      const org = await getOrganization(native.organization_id);
      const live = await getLiveOrganizationSessionReference(session.id);
      if (!org || org.state === 'archived' || live?.organizationId !== org.id
          || native.root_session_id !== org.rootSessionId
          || (Number.isInteger(native.organization_revision)
            ? !await isOrganizationRevisionCompatible(org.id, native.organization_revision, org.currentRevision)
            : live.kind !== 'root' || native.host_session_id !== org.rootSessionId)) return null;
      const node = live.kind === 'node' ? await getNode(live.nodeId) : null;
      if (live.kind === 'node' && (!node || node.currentSessionId !== session.id || node.bindingGeneration !== live.bindingGeneration || node.retiredRevision !== null)) return null;
      if (live.kind === 'root' && org.rootSessionId !== session.id) return null;
      if (!['root','node'].includes(live.kind)) return null;
      let manifest = null;
      if (native.host_session_id === session.id) {
        const run = await getRun(native.run_id);
        const saved = await getRunManifest(native.run_id);
        if (run?.sessionId === session.id && saved?.sessionId === session.id) manifest = saved;
      }
      return { organization: org, node, manifest };
    }
  }
  if (!incident && eventContext?.type === 'run_terminal') {
    const { runId, sessionId, eventId } = eventContext.payload || {};
    if (!runId || !sessionId || eventId !== runId || trigger.eventFilter?.sessionId !== sessionId
        || trigger.dedupeKey !== `delegated-child-terminal:${session.id}:${sessionId}`) return null;
    const run = await getRun(runId);
    if (run?.sessionId !== sessionId || !['completed','failed','cancelled'].includes(run.state)) return null;
    const rows = await withDatabase(db => db.prepare(`SELECT a.id AS attempt_id,a.attempt_number,t.current_attempt,c.policy_json
      FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id
      JOIN collaborations c ON c.id=t.collaboration_id WHERE a.run_id=? AND a.session_id=?`).all(runId,sessionId));
    if (rows.length !== 1) {
      const { getSession } = await import('./session-manager.mjs');
      const child = await getSession(sessionId);
      return child && !child.organizationId && !child.organizationNodeId ? { ordinary: true } : null;
    }
    if (rows[0].attempt_number !== rows[0].current_attempt) return null;
    let policy; try { policy = JSON.parse(rows[0].policy_json || '{}'); } catch { return null; }
    if (!policy.organizationId) return { ordinary: true };
    const node = await getNode(policy.organizationNodeId);
    const org = await getOrganization(policy.organizationId);
    if (!node || !org || node.organizationId !== org.id || node.currentSessionId !== sessionId
        || node.bindingGeneration !== policy.organizationBindingGeneration || node.retiredRevision !== null) return null;
    const parent = node.parentNodeId ? await getNode(node.parentNodeId) : null;
    if (node.parentNodeId ? (!parent || parent.currentSessionId !== session.id || parent.retiredRevision !== null)
      : org.rootSessionId !== session.id) return null;
    incident = { organization_id: org.id, root_session_id: org.rootSessionId,
      organization_revision: policy.organizationPhaseDispatch?.revision, node_id: node.id,
      session_id: sessionId, binding_generation: node.bindingGeneration, policy_json: rows[0].policy_json,
      trigger_id: trigger.id, ancestors_json: JSON.stringify([{ sessionId: session.id,
        nodeId: parent?.id || '', bindingGeneration: parent?.bindingGeneration }]) };
  }
  if (!incident) {
    const live = await getLiveOrganizationSessionReference(session.id);
    return live ? null : { ordinary: true };
  }
  if (!incident.organization_id) return { ordinary: true };
  const org = await getOrganization(incident.organization_id);
  const live = await getLiveOrganizationSessionReference(session.id);
  if (!org || org.state === 'archived' || org.rootSessionId !== incident.root_session_id
      || live?.organizationId !== org.id
      || !await isOrganizationRevisionCompatible(org.id, incident.organization_revision, org.currentRevision)) return null;
  let ancestors;
  try { ancestors = JSON.parse(incident.ancestors_json || '[]'); } catch { return null; }
  const index = incident.trigger_id === trigger.id ? 0 : Number(incident.escalation_index);
  const recipient = ancestors[index];
  if (!recipient || recipient.sessionId !== session.id || (recipient.nodeId
    ? live.kind !== 'node' || live.nodeId !== recipient.nodeId || live.bindingGeneration !== recipient.bindingGeneration
    : live.kind !== 'root' || org.rootSessionId !== session.id)) return null;

  const recipientNode = live.kind === 'node' ? await getNode(live.nodeId) : null;
  if (live.kind === 'node' && (!recipientNode || recipientNode.currentSessionId !== session.id
      || recipientNode.bindingGeneration !== live.bindingGeneration || recipientNode.retiredRevision !== null)) return null;
  const context = { organization: org, node: recipientNode, manifest: null };

  if (live.kind === 'node') {
    // Only the immediate parent has an explicitly persisted parent Run binding.
    if (index !== 0) return context;
    let policy; try { policy = JSON.parse(incident.policy_json || '{}'); } catch { return context; }
    const delegation = policy.organizationDelegation;
    if (!delegation || delegation.parentSessionId !== session.id || delegation.parentNodeId !== live.nodeId) return context;
    try {
      const verified = await verifyOrganizationDelegation({ organizationId: org.id, childNodeId: incident.node_id, delegation, requireActiveRun: false });
      if (verified.child.currentSessionId !== incident.session_id || verified.child.bindingGeneration !== incident.binding_generation) return context;
      return { ...context, manifest: verified.manifest };
    } catch { return context; }
  }

  // A root's plan ingress and the frozen revision must independently agree on
  // the exact source Run and proposal key; a key by itself grants nothing.
  const manifest = await trustedRootContinuationManifest(org, session.id, incident.organization_revision);
  return manifest ? { ...context, manifest } : context;
}

export async function trustedRootContinuationManifest(org, sessionId, sourceRevision) {
  const revisions = (await listRevisions(org.id)).reverse();
  for (const revision of revisions) {
    if (revision.state !== 'frozen' || revision.revision > sourceRevision
        || !await isOrganizationRevisionCompatible(org.id, revision.revision, sourceRevision)) continue;
    const prefix = `leader:${sessionId}:turn:`;
    if (!revision.idempotencyKey.startsWith(prefix)) continue;
    const runId = revision.idempotencyKey.slice(prefix.length).split(':', 1)[0];
    if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) continue;
    const run = await getRun(runId);
    const result = run?.organizationPlanIngress?.result;
    if (run?.sessionId !== sessionId || run.organizationPlanIngress?.state !== 'completed'
        || result?.state !== 'frozen' || result.organizationId !== org.id || result.revision !== revision.revision
        || result.idempotencyKey !== revision.idempotencyKey || result.digest !== revision.digest) continue;
    const manifest = await getRunManifest(runId);
    if (manifest?.sessionId === sessionId) return manifest;
  }
  return null;
}

export async function validateIncidentContinuationRuntime(context, session, tuple) {
  const { readSessionRuntimeConstraints } = await import('./session-collaboration-settings.mjs');
  const { selectRuntimeConstraints, applyRuntimeConstraints, assertRuntimeConstraints } = await import('./organization-runtime-decision.mjs');
  const { getSession } = await import('./session-manager.mjs');
  const root = await getSession(context.organization.rootSessionId);
  if (!root) throw new Error('Organization root is unavailable');
  const settings = await readSessionRuntimeConstraints(root.id);
  const scopes = context.node ? ['organization', `node:${context.node.stableKey}`] : ['root', 'organization'];
  const constraints = selectRuntimeConstraints(settings.constraints, scopes);
  const { getApp } = await import('./apps.mjs');
  const { buildAgentCapabilityProfile } = await import('./agent-capability-registry.mjs');
  const { resolveRuntimeSelection } = await import('./organization-runtime-selection.mjs');
  const { resolveSessionCollaborationPolicy } = await import('./collaboration-policy.mjs');
  const app = session.templateId ? await getApp(session.templateId) : null;
  if (session.templateId && !app) throw new Error('Session Agent policy is unavailable');
  if (context.node && !app) throw new Error('Manager Agent policy is unavailable');
  const profile = app ? await buildAgentCapabilityProfile(app) : {};
  const rootApp = root.templateId ? await getApp(root.templateId) : null;
  if (root.templateId && !rootApp) throw new Error('Root Agent policy is unavailable');
  const rootPolicy = resolveSessionCollaborationPolicy(root, rootApp);
  const parent = context.node?.parentNodeId ? await getNode(context.node.parentNodeId) : null;
  if (context.node?.parentNodeId && !parent) throw new Error('Manager parent grant is unavailable');
  let selected = applyRuntimeConstraints(tuple, constraints);
  for (const grant of [{ runtimePolicy: rootPolicy.runtimePolicy }, ...(parent ? [parent.grant] : []), ...(context.node ? [context.node.grant] : [])]) {
    const resolved = await resolveRuntimeSelection({ requested: selected, profile, parentGrant: grant || {} });
    for (const field of ['tool','provider','model','effort']) {
      if (selected[field] && selected[field] !== resolved[field]) throw new Error(`Continuation ${field} no longer matches current policy`);
    }
    selected = { tool: resolved.tool, provider: resolved.provider, model: resolved.model, effort: resolved.effort };
  }
  assertRuntimeConstraints(selected, constraints);
  return selected;
}

// Resolve only from the collaboration's frozen organization binding and its
// verified root plan Run; a child Run is never a source of root credentials.
export async function resolveAggregationContinuationRuntime(collaboration, session) {
  const policy = collaboration?.policy || {};
  if (!policy.organizationId) return null;
  const org = await getOrganization(policy.organizationId);
  const node = await getNode(policy.organizationNodeId);
  const sourceRevision = policy.organizationPhaseDispatch?.revision;
  if (!org || ['archived', 'lifecycle_pending'].includes(org.state) || org.rootSessionId !== session.id
      || !node || node.organizationId !== org.id || node.bindingGeneration !== policy.organizationBindingGeneration
      || node.retiredRevision !== null || !Number.isInteger(sourceRevision)
      || !await isOrganizationRevisionCompatible(org.id, sourceRevision, org.currentRevision)) {
    throw new Error('Aggregation organization binding or revision is unavailable');
  }
  const frozen = await getRevision(org.id, sourceRevision);
  if (frozen?.state !== 'frozen' || !frozen.compiled?.nodes?.some((entry) =>
    entry.stableKey === node.stableKey && entry.phaseId === policy.organizationPhaseDispatch?.phaseId))
    throw new Error('Aggregation frozen task binding is unavailable');
  const manifest = await trustedRootContinuationManifest(org, session.id, sourceRevision);
  const source = manifest ? { tool: manifest.tool, model: manifest.options?.model,
    provider: manifest.options?.providerProfile, effort: manifest.options?.effort } : {};
  const { parseScopedCodexModel } = await import('./models.mjs');
  const current = { tool: session.tool, model: session.model, provider: session.providerProfile, effort: session.effort };
  const tuple = Object.fromEntries(Object.entries(current).filter(([, value]) => typeof value === 'string' && value.trim()));
  const currentProvider = tuple.provider || (tuple.model ? parseScopedCodexModel(tuple.model).providerId : '');
  const sourceProvider = source.provider || (source.model ? parseScopedCodexModel(source.model).providerId : '');
  if (!tuple.model) {
    if (!source.model || !source.tool || (tuple.tool && tuple.tool !== source.tool)
        || (currentProvider && sourceProvider && currentProvider !== sourceProvider))
      throw new Error('Aggregation root model has no compatible verified source');
    tuple.tool ||= source.tool; tuple.model = source.model;
    tuple.provider ||= sourceProvider || undefined; tuple.effort ||= source.effort || undefined;
  }
  if (!tuple.tool || (!tuple.provider && !currentProvider)) {
    const compatible = source.tool && source.model && tuple.model === source.model
      && (!tuple.tool || tuple.tool === source.tool)
      && (!currentProvider || !sourceProvider || currentProvider === sourceProvider);
    if (compatible) {
      tuple.tool ||= source.tool;
      tuple.provider ||= sourceProvider || undefined;
    }
  }
  if (!tuple.tool || !tuple.model) throw new Error('Aggregation root runtime is incomplete');
  return validateIncidentContinuationRuntime({ organization: org, node: null }, session, tuple);
}
