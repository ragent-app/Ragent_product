// Server-owned phase dispatch for a provisioned Organization Revision.
//
// Provisioning creates the managed Sessions, but does not itself inject work.
// This module creates one bounded collaboration per phase node and binds it to
// the already provisioned Session. The collaboration orchestrator remains the
// only controlled input channel, so managed-input enforcement still applies.
import { getDefaultCollaborationOrchestrator } from './collaboration-orchestrator.mjs';
import { getOrganization, getRevision, listOrganizationNodes } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { getModelsForTool } from './models.mjs';
import { assertRuntimeConstraints } from './organization-runtime-decision.mjs';
import { createHash } from 'crypto';
import { recoverOrganizationDispatchEvents } from './organization-dispatch-event-recovery.mjs';

function text(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map((entry) => text(entry)).filter(Boolean))] : [];
}

function dispatchError(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function phaseFor(compiled, phaseId) {
  return (Array.isArray(compiled?.phases) ? compiled.phases : [])
    .find((phase) => text(phase?.phaseId) === phaseId) || null;
}

function compiledNodeFor(compiled, stableKey) {
  return (Array.isArray(compiled?.nodes) ? compiled.nodes : [])
    .find((node) => text(node?.stableKey) === stableKey) || null;
}

function runtimeForSession(session) {
  const tool = text(session?.tool, 80).toLowerCase();
  const model = text(session?.model, 240);
  const effort = text(session?.effort, 80).toLowerCase();
  if (!tool || !model) {
    throw dispatchError(
      'ORG_PHASE_RUNTIME_INCOMPLETE',
      `managed Session ${text(session?.id)} is missing tool/model; refusing to start an unverified Run`,
      409,
    );
  }
  return { tool, model, ...(effort ? { effort } : {}) };
}

function runtimeMatches(compiledRuntime, actualRuntime) {
  const expected = object(compiledRuntime);
  for (const key of ['tool', 'provider', 'model', 'effort']) {
    const wanted = text(key === 'provider' ? expected.provider || expected.providerProfile : expected[key]);
    if (!wanted) continue;
    const actual = text(key === 'provider' ? actualRuntime.provider || actualRuntime.providerProfile : actualRuntime[key]);
    if (['tool', 'effort'].includes(key) ? wanted.toLowerCase() !== actual.toLowerCase() : wanted !== actual) return false;
  }
  return true;
}

async function validateSessionEffort(runtime) {
  if (runtime.effort) return;
  const catalog = await getModelsForTool(runtime.tool).catch(() => null);
  const entry = catalog?.models?.find((model) => model.id === runtime.model);
  const levels = entry?.effortLevels || catalog?.effortLevels;
  if (Array.isArray(levels) && levels.length > 0) {
    throw dispatchError('ORG_PHASE_RUNTIME_INCOMPLETE', 'Session requires a supported effort selection', 409);
  }
}

async function phaseDependenciesCompleted(organizationId, compiled, phase) {
  const dependencies = list(phase?.dependsOn);
  if (dependencies.length === 0) return;
  const events = await import('./organization-messaging.mjs').then(({ listOrganizationEvents }) => listOrganizationEvents(organizationId, { limit: 5000 }));
  for (const dependency of dependencies) {
    const complete = events.some((event) => event.phaseId === dependency
      && ['phase.completed', 'phase_completed'].includes(event.type));
    if (!complete) {
      throw dispatchError('ORG_PHASE_DEPENDENCY_BLOCKED', `phase ${phase.phaseId} depends on incomplete phase ${dependency}`, 409, {
        phaseId: phase.phaseId,
        dependency,
      });
    }
  }
}

// A phase fans out to multiple durable Collaborations. Record the parent
// cursor before and during that fan-out so restart recovery has one stable
// organization-level checkpoint in addition to each child's own Attempt log.
async function ensurePhaseExecution(organization, phase, revision, checkpoint = {}) {
  try {
    const ledger = await import('./orchestration-store.mjs');
    const execution = await ledger.ensureExecution({
      scopeKind: 'organization_phase',
      scopeId: `${organization.id}:${revision}:${phase.phaseId}`,
      rootSessionId: organization.rootSessionId,
      kind: 'organization_phase',
      state: 'ready',
      specRevision: revision,
      specDigest: `organization:${organization.id}:revision:${revision}:phase:${phase.phaseId}`,
      spec: {
        organizationId: organization.id,
        revision,
        phaseId: phase.phaseId,
        objective: phase.objective || '',
        acceptance: Array.isArray(phase.acceptance) ? phase.acceptance : [],
        dependsOn: Array.isArray(phase.dependsOn) ? phase.dependsOn : [],
      },
    });
    if (typeof ledger.syncExecutionSpec === 'function') {
      await ledger.syncExecutionSpec(execution.id, {
        specRevision: revision,
        specDigest: `organization:${organization.id}:revision:${revision}:phase:${phase.phaseId}`,
        spec: {
          organizationId: organization.id,
          revision,
          phaseId: phase.phaseId,
          objective: phase.objective || '',
          acceptance: Array.isArray(phase.acceptance) ? phase.acceptance : [],
          dependsOn: Array.isArray(phase.dependsOn) ? phase.dependsOn : [],
        },
      });
    }
    return ledger.checkpointExecution(execution.id, {
      state: checkpoint.state || 'running',
      checkpoint: { phaseId: phase.phaseId, revision, ...checkpoint },
      heartbeat: true,
      eventType: 'organization_phase_checkpoint_mirrored',
    });
  } catch (error) {
    // Phase-node Collaborations already own the authoritative dispatch outbox.
    // Keep this common ledger as an observational migration layer so a local
    // DB degradation cannot make an accepted organization phase disappear.
    console.warn(`[orchestration] organization phase ledger mirror failed for ${organization.id}/${phase.phaseId}: ${error?.message || String(error)}`);
    return null;
  }
}

export async function dispatchOrganizationPhase({
  organizationId,
  phaseId,
  revision = null,
  idempotencyKey,
  orchestrator = null,
} = {}) {
  const normalizedOrganizationId = text(organizationId, 160);
  const normalizedPhaseId = text(phaseId, 160);
  const normalizedKey = text(idempotencyKey, 240);
  if (!normalizedOrganizationId || !normalizedPhaseId || !normalizedKey) {
    throw dispatchError('ORG_PHASE_DISPATCH_INVALID', 'organizationId, phaseId and idempotencyKey are required', 400);
  }
  const organization = await getOrganization(normalizedOrganizationId);
  if (!organization) throw dispatchError('ORGANIZATION_NOT_FOUND', 'organization not found', 404);
  if (['archived','lifecycle_pending'].includes(organization.state)) throw dispatchError('ORGANIZATION_ARCHIVED', 'organization cannot dispatch during archive or rebind', 409);
  const targetRevision = Number.isInteger(revision) ? revision : organization.currentRevision;
  const revisionRow = await getRevision(organization.id, targetRevision);
  if (!revisionRow) throw dispatchError('REVISION_NOT_FOUND', 'organization revision not found', 404);
  if (revisionRow.state !== 'frozen') throw dispatchError('ORG_PHASE_REVISION_NOT_FROZEN', 'only a frozen revision can dispatch work', 409);
  const compiled = revisionRow.compiled || {};
  const phase = phaseFor(compiled, normalizedPhaseId);
  if (!phase) throw dispatchError('ORG_PHASE_NOT_FOUND', `phase ${normalizedPhaseId} not found`, 404);
  await phaseDependenciesCompleted(organization.id, compiled, phase);

  const nodes = await listOrganizationNodes(organization.id);
  const phaseNodes = nodes
    .map((node) => ({ node, compiled: compiledNodeFor(compiled, node.stableKey) }))
    .filter(({ compiled: node }) => text(node?.phaseId) === normalizedPhaseId);
  if (phaseNodes.length === 0) throw dispatchError('ORG_PHASE_NO_NODES', `phase ${normalizedPhaseId} has no compiled nodes`, 409);

  await ensurePhaseExecution(organization, phase, targetRevision, {
    stage: 'dispatching',
    nodeKeys: phaseNodes.map(({ node }) => node.stableKey),
  });

  const runtimeOrchestrator = orchestrator || getDefaultCollaborationOrchestrator();
  const dispatched = [];
  for (const { node, compiled: nodePlan } of phaseNodes) {
    if (!text(node.currentSessionId)) {
      throw dispatchError('ORG_PHASE_SESSION_MISSING', `node ${node.stableKey} has no provisioned managed Session`, 409, { stableKey: node.stableKey });
    }
    const session = await getSession(node.currentSessionId);
    if (!session || session.sessionPlane !== 'organization') {
      throw dispatchError('ORG_PHASE_SESSION_INVALID', `node ${node.stableKey} is not bound to a managed Session`, 409, { stableKey: node.stableKey });
    }
    const actualRuntime = runtimeForSession(session);
    await validateSessionEffort(actualRuntime);
    const provider = text(session.providerProfile, 160);
    const runtime = { ...actualRuntime, ...(provider ? { provider } : {}) };
    const { readSessionRuntimeConstraints } = await import('./session-collaboration-settings.mjs');
    const rootSession = await getSession(organization.rootSessionId);
    const currentSettings = rootSession?.sessionClass === 'ROOT_LEADERSHIP'
      ? await readSessionRuntimeConstraints(organization.rootSessionId) : { constraints: {} };
    const currentConstraints = Object.fromEntries(Object.entries(currentSettings.constraints).filter(([, constraint]) =>
      constraint.scope === 'organization' || constraint.scope === `node:${node.stableKey}`));
    const frozenConstraints = nodePlan?.runtimeDecision?.requestedConstraints || {};
    if (JSON.stringify(currentConstraints) !== JSON.stringify(frozenConstraints)) {
      throw dispatchError('ORG_PHASE_RUNTIME_CONSTRAINT_CHANGED', `node ${node.stableKey} runtime constraints changed; recompile the revision`, 409);
    }
    assertRuntimeConstraints(runtime, currentConstraints);
    // Recheck the trusted constraints frozen in this revision at admission.
    if (nodePlan?.runtimeDecision) {
      assertRuntimeConstraints(runtime, nodePlan.runtimeDecision.requestedConstraints);
      if (!runtimeMatches(nodePlan.runtimeDecision.selected, runtime)) {
        throw dispatchError('ORG_PHASE_RUNTIME_MISMATCH', `node ${node.stableKey} Session runtime differs from the frozen decision`, 409);
      }
    }
    if (!runtimeMatches(nodePlan?.runtime, runtime)) {
      throw dispatchError('ORG_PHASE_RUNTIME_MISMATCH', `node ${node.stableKey} Session runtime differs from the frozen plan`, 409, {
        stableKey: node.stableKey,
        runtime,
      });
    }
    const agentId = text(nodePlan?.resolver?.selectedAgentId || nodePlan?.agentId || session.templateId, 160);
    if (text(session.templateId) && agentId !== text(session.templateId)) {
      throw dispatchError('ORG_PHASE_AGENT_MISMATCH', `node ${node.stableKey} Session Agent differs from the frozen plan`, 409, { stableKey: node.stableKey });
    }
    const taskId = `org:${organization.id}:${targetRevision}:${normalizedPhaseId}:${node.stableKey}`;
    const taskRole = text(node.nodeRole).toLowerCase() === 'reviewer' ? 'reviewer' : 'specialist';
    const acceptance = [
      ...list(phase.acceptance),
      ...list(nodePlan?.acceptance),
    ];
    const writablePaths = list(nodePlan?.scope?.writablePaths);
    const eventKey = `phase-dispatch:${createHash('sha256').update(`${normalizedKey}:${node.stableKey}`).digest('hex')}`;
    const policy = {
      role: 'manager',
      canDelegate: true,
      canWrite: true,
      canReview: true,
      maxChildren: 1,
      maxConcurrent: 1,
      workspacePolicy: 'shared-exclusive',
      accessMode: 'write',
      executionIsolation: 'shared',
      allowedAgentIds: [agentId],
      allowedRoles: [taskRole],
      runtimePolicy: {
        allowedTools: [runtime.tool],
        allowedProviders: provider ? [provider] : [],
        allowedModels: [runtime.model],
        allowedEfforts: runtime.effort ? [runtime.effort] : [],
      },
      organizationId: organization.id,
      organizationRuntimeConstraints: currentConstraints,
      organizationNodeId: node.id,
      organizationBindingGeneration: node.bindingGeneration,
      organizationPhaseDispatch: { eventKey, phaseId: normalizedPhaseId, revision: targetRevision, taskId },
    };
    const result = await runtimeOrchestrator.dispatch({
      rootSessionId: organization.rootSessionId,
      title: `Organization phase ${normalizedPhaseId}: ${node.stableKey}`,
      projectId: organization.projectId || '',
      policy,
      idempotencyKey: `${normalizedKey}:${node.stableKey}`,
      plan: {
        version: 1,
        title: `Organization phase ${normalizedPhaseId}`,
        tasks: [{
          id: taskId,
          objective: text(nodePlan?.objective || phase.objective || organization.id, 4000),
          agentId,
          role: taskRole,
          acceptance,
          writablePaths,
          projectId: organization.projectId || '',
          runtime,
          managedSessionId: session.id,
          accessMode: 'write',
          executionIsolation: 'shared',
          retry: { maxAttempts: 1, retryOn: [] },
        }],
      },
    });
    // The committed collaboration plan is authoritative; a failed mirror can
    // be recovered on the next projection read without re-dispatching work.
    await recoverOrganizationDispatchEvents(organization).catch((error) => {
      console.warn('[organization] dispatch event mirror deferred:', error?.message || error);
    });
    dispatched.push({ stableKey: node.stableKey, sessionId: session.id, runtime, collaboration: result });
    await ensurePhaseExecution(organization, phase, targetRevision, {
      stage: 'dispatching',
      lastNodeKey: node.stableKey,
      dispatchedCollaborationIds: dispatched.map((entry) => entry.collaboration?.id).filter(Boolean),
    });
  }
  await ensurePhaseExecution(organization, phase, targetRevision, {
    stage: 'dispatched',
    dispatchedCollaborationIds: dispatched.map((entry) => entry.collaboration?.id).filter(Boolean),
  });
  return {
    state: 'dispatched',
    organizationId: organization.id,
    revision: targetRevision,
    phaseId: normalizedPhaseId,
    sessions: dispatched,
  };
}
