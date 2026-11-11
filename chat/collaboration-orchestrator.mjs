import { randomBytes } from 'crypto';
import { compileCollaborationPlan, classifyAttemptOutcome } from './collaboration-plan.mjs';
import {
  assertManagerCanDelegate,
  buildEffectiveCapability,
  resolveSessionCollaborationPolicy,
} from './collaboration-policy.mjs';
import * as store from './collaboration-store.mjs';
import { getApp } from './apps.mjs';
import { buildAgentCapabilityProfile } from './agent-capability-registry.mjs';
import {
  resolveRuntimeSelection,
  ORGANIZATION_RUNTIME_TOOLS,
  runtimePolicyHasConstraints,
} from './organization-runtime-selection.mjs';
import {
  createSession,
  getSession,
  getRunState,
  sendMessage,
  loadRecentTurnHistory,
} from './session-manager.mjs';
import {
  getRun,
  getRunManifest,
  getRunResult,
  listRunIds,
  requestRunCancel,
} from './runs.mjs';
import { loadHistory } from './history.mjs';
import { createGitWorktree, validateWorkspacePlan } from './collaboration-workspace.mjs';
import { createExecutionPacket, getResultPacket } from './result-packets.mjs';
import { resultPacketPrompt } from './delegation-result.mjs';
import { decideGate, completePhase } from './phase-gates.mjs';
import {
  resolveRuntimeReadOnlyCapability,
  buildReviewerReadOnlySandbox,
  REVIEWER_RUNTIME_ID,
} from './runtime-adapter.mjs';
import { isBwrapPresent } from '../lib/runner-sandbox.mjs';
import { getProject } from './projects.mjs';
import { MANAGED_WRITER_ENABLED, REVIEWER_ENABLED } from '../lib/config.mjs';
import {
  createStagingWorkspace,
  commitStagingToCanonical,
  discardStaging,
  resolveStagingDiff,
} from './managed-writer.mjs';

const DEFAULT_POLL_MS = 1500;
const MAX_REPORT_CHARS = 12000;
const MAX_PROMPT_CHARS = 48000;
const RESULT_PACKET_FETCH_CONCURRENCY = 8;
const LEDGER_HEARTBEAT_MS = 60 * 1000;

async function mapWithResultPacketConcurrency(items, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return Promise.all(list.map(mapper));
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(RESULT_PACKET_FETCH_CONCURRENCY, list.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value, max = MAX_REPORT_CHARS) {
  const text = trim(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function nowIso() {
  return new Date().toISOString();
}

function makeRequestId(collaborationId, taskId, attemptNumber) {
  return `collaboration:${collaborationId}:${taskId}:attempt:${attemptNumber}`;
}

function namespacePlanTaskIds(plan, usedTaskIds) {
  if (!plan.tasks.some((task) => usedTaskIds.has(task.id))) return plan;
  const namespace = `task_${randomBytes(6).toString('hex')}`;
  const ids = new Map(plan.tasks.map((task) => [task.id, `${namespace}:${task.id}`]));
  return Object.freeze({
    ...plan,
    tasks: plan.tasks.map((task) => Object.freeze({
      ...task,
      id: ids.get(task.id),
      dependsOn: task.dependsOn.map((dependency) => ids.get(dependency) || dependency),
    })),
  });
}

function isTerminal(state) {
  return ['completed', 'failed', 'cancelled'].includes(trim(state).toLowerCase());
}

function runLifecycleObservation(run) {
  return {
    runState: trim(run?.state),
    runnerStartedAt: trim(run?.runnerStartedAt),
  };
}

function taskById(collaboration, taskId) {
  return collaboration?.tasks?.find((task) => task.id === taskId) || null;
}

function attemptById(collaboration, attemptId) {
  return collaboration?.attempts?.find((attempt) => attempt.id === attemptId) || null;
}

function latestAssistantReport(history = []) {
  const event = [...history].reverse().find((item) => (
    item?.type === 'message' && item?.role === 'assistant' && trim(item.content)
  ));
  return {
    summary: clip(event?.content || ''),
    risks: [],
    blockers: [],
    acceptanceNotes: [],
  };
}

function buildEnvelope(run, result, manifest, attempt, session = null) {
  return {
    runId: trim(run?.id),
    sessionId: trim(run?.sessionId),
    taskId: trim(attempt?.taskId),
    attempt: attempt?.attemptNumber || null,
    state: trim(run?.state),
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    signal: trim(result?.signal),
    failureReason: clip(run?.failureReason || result?.error || '', 2000),
    changedFiles: Array.isArray(run?.changedFiles)
      ? run.changedFiles.map(trim).filter(Boolean).slice(0, 500)
      : Array.isArray(result?.changedFiles)
        ? result.changedFiles.map(trim).filter(Boolean).slice(0, 500)
        : [],
    tests: Array.isArray(run?.tests)
      ? run.tests.slice(0, 100)
      : Array.isArray(result?.tests) ? result.tests.slice(0, 100) : [],
    usage: run?.usage || result?.usage || null,
    artifacts: Array.isArray(run?.publishedResultAssets)
      ? run.publishedResultAssets.slice(0, 100)
      : Array.isArray(result?.artifacts) ? result.artifacts.slice(0, 100) : [],
    worktreeRef: trim(run?.worktreeRef || manifest?.worktreeRef || session?.sourceContext?.worktreeRef),
    completedAt: trim(result?.completedAt || run?.completedAt) || nowIso(),
    synthesized: result?.synthesized === true,
  };
}

function buildTaskPrompt(task, completedAttempts = []) {
  const inputs = completedAttempts.map((attempt) => ({
    taskId: attempt.taskId,
    state: attempt.state,
    envelope: attempt.envelope,
    report: attempt.report,
  }));
  return clip([
    'You are a bounded specialist in an AgentoC collaboration.',
    `Task: ${task.objective}`,
    `Task id: ${task.id}`,
    `Acceptance criteria: ${task.acceptance.join('; ') || 'Return a concise result and test evidence.'}`,
    `Writable paths: ${task.writablePaths.join(', ') || 'No implementation files declared.'}`,
    'Do not delegate further unless the frozen task explicitly grants it.',
    inputs.length > 0 ? `Completed dependency results:\n${JSON.stringify(inputs, null, 2)}` : '',
    'Return a bounded result report; do not include a full transcript or private provider error.',
    resultPacketPrompt({ role: task.role }),
  ].filter(Boolean).join('\n\n'), MAX_PROMPT_CHARS);
}

function boundedPacketProjection(packet) {
  if (!packet || typeof packet !== 'object') return null;
  return {
    packetId: trim(packet.packetId),
    digest: trim(packet.digest),
    kind: trim(packet.kind),
    state: trim(packet.state),
    producer: packet.producer || {},
    summary: clip(packet.summary || '', 4000),
    changedFiles: Array.isArray(packet.changedFiles) ? packet.changedFiles.slice(0, 100) : [],
    tests: Array.isArray(packet.tests) ? packet.tests.slice(0, 100) : [],
    acceptanceResults: Array.isArray(packet.acceptanceResults) ? packet.acceptanceResults.slice(0, 100) : [],
    decisions: Array.isArray(packet.decisions) ? packet.decisions.slice(0, 100) : [],
    blockers: Array.isArray(packet.blockers) ? packet.blockers.slice(0, 100) : [],
    risks: Array.isArray(packet.risks) ? packet.risks.slice(0, 100) : [],
    artifacts: Array.isArray(packet.artifacts) ? packet.artifacts.slice(0, 100) : [],
    provenance: packet.provenance || {},
  };
}

// S13 aggregation boundary (constitution §2.8 / §7): the Manager input is
// restricted to child ResultPackets (bounded v2 projections), gate decisions,
// the phase contract and the evidence projection. Full Agent reports, run
// envelopes and other Session-private content are never copied into the
// aggregation prompt. `context` carries the optional phase/gate inputs.
function buildAggregationPrompt(collaboration, packetProjections = [], context = {}) {
  const packets = packetProjections.map((entry) => ({
    attemptId: entry.attemptId,
    packet: entry.packet,
  }));
  return clip([
    'Collaboration resume: all frozen child tasks have reached a terminal result.',
    `Collaboration: ${collaboration.title} (${collaboration.id})`,
    'Review every child ResultPacket below. Do not claim completion when an acceptance criterion or independent review is missing.',
    JSON.stringify({ ...context, packets }, null, 2),
    'Return the manager result: decision, completed work, unresolved blockers, risks, and whether the collaboration is ready for independent QA/release.',
  ].join('\n\n'), MAX_PROMPT_CHARS);
}

function buildDefaultDependencies(overrides = {}) {
  return {
    createSession,
    getSession,
    getRunState,
    sendMessage,
    requestRunCancel,
    getApp,
    getRun,
    getRunManifest,
    getRunResult,
    listRunIds,
    loadHistory,
    loadRecentTurnHistory,
    createGitWorktree,
    getProject,
    resolveRuntimeReadOnlyCapability,
    // S12 certified read-only reviewer sandbox builder. Defaults to the
    // bubblewrap read-only variant and requires a bwrap binary; tests inject a
    // builder (or a failing one) via overrides.
    buildReviewerSandbox: (context) => {
      if (!isBwrapPresent()) {
        throw new Error('trusted system bwrap is unavailable; read-only reviewer sandbox cannot be built');
      }
      return buildReviewerReadOnlySandbox(context);
    },
    createExecutionPacket,
    getResultPacket,
    // S13 phase gate decisions + phase.completed CAS (injectable for tests).
    decideGate,
    completePhase,
    // S11 managed writer capabilities (injectable for tests).
    createStagingWorkspace,
    commitStagingToCanonical,
    discardStaging,
    resolveStagingDiff,
    // A collaboration may publish its terminal state to explicitly configured
    // event subscribers.  It must not manufacture a generic trigger for its
    // own parent session: that used to feed an internal completion notice back
    // through the user-message ingress and create a second, synthetic turn.
    // Keep the publisher lazy to avoid an import cycle with session-manager.
    emitTriggerEvent: async (type, payload) => (await import('./triggers.mjs')).emitTriggerEvent(type, payload),
    ...overrides,
  };
}

export function createCollaborationOrchestrator(options = {}) {
  const deps = buildDefaultDependencies(options.dependencies);
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs >= 250
    ? options.pollMs
    : DEFAULT_POLL_MS;
  // S11: managed writer staging. Off by default (old behavior); on for
  // organization-plane writer attempts. `options.managedWriterEnabled` lets
  // tests pin either side without touching the env.
  const managedWriterEnabled = typeof options.managedWriterEnabled === 'boolean'
    ? options.managedWriterEnabled
    : MANAGED_WRITER_ENABLED;
  // S12: certified read-only reviewer runtime. Off by default (old behavior);
  // on, reviewer tasks must execute through the certified read-only runtime
  // and a sandbox build failure refuses the run (READ_ONLY_RUNTIME_REFUSED).
  // `options.reviewerEnabled` lets tests pin either side without env.
  const reviewerEnabled = typeof options.reviewerEnabled === 'boolean'
    ? options.reviewerEnabled
    : REVIEWER_ENABLED;
  const activeOperations = new Map();
  // S13 NEEDS_CHANGES rework context: a collaboration opened by dispatchRework
  // is tagged with the org/phase it reworks and the packet it chains from, so
  // the rework attempt's ResultPacket v2 fields are derived server-side
  // (parentPacketIds references the old packet; §2.6/§2.7/§7).
  const reworkContext = new Map();
  let timer = null;

  async function exclusive(collaborationId, fn) {
    const previous = activeOperations.get(collaborationId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    activeOperations.set(collaborationId, next);
    try {
      return await next;
    } finally {
      if (activeOperations.get(collaborationId) === next) activeOperations.delete(collaborationId);
    }
  }

  async function loadRoot(collaboration) {
    const root = await deps.getSession(collaboration.rootSessionId);
    if (!root) {
      const error = new Error(`Root session not found: ${collaboration.rootSessionId}`);
      error.code = 'COLLABORATION_ROOT_SESSION_NOT_FOUND';
      throw error;
    }
    return root;
  }

  // The collaboration tables remain the execution authority during the
  // incremental migration, while the generic ledger gives collaboration and
  // organization one common, durable checkpoint vocabulary. Ledger failure is
  // deliberately observational here: it must never make an already-validated
  // user task disappear. The reconciler will repair a missed mirror on its
  // next pass.
  async function mirrorCollaborationExecution(collaboration, checkpoint = {}) {
    if (!collaboration?.id || !collaboration?.rootSessionId) return null;
    try {
      const ledger = await import('./orchestration-store.mjs');
      const execution = await ledger.ensureExecution({
        scopeKind: 'collaboration',
        scopeId: collaboration.id,
        rootSessionId: collaboration.rootSessionId,
        kind: 'collaboration',
        state: collaboration.state || 'ready',
        specRevision: Number(collaboration.planVersion) || 1,
        specDigest: `collaboration:${collaboration.id}:plan:${Number(collaboration.planVersion) || 1}`,
        spec: {
          title: collaboration.title || '',
          planVersion: Number(collaboration.planVersion) || 1,
          policy: collaboration.policy || {},
          tasks: (collaboration.tasks || []).map((task) => ({
            id: task.id,
            dependsOn: task.dependsOn || [],
            role: task.role || '',
            runtime: task.runtime || {},
          })),
        },
      });
      if (typeof ledger.syncExecutionSpec === 'function') {
        await ledger.syncExecutionSpec(execution.id, {
          specRevision: Number(collaboration.planVersion) || 1,
          specDigest: `collaboration:${collaboration.id}:plan:${Number(collaboration.planVersion) || 1}`,
          spec: {
            title: collaboration.title || '',
            planVersion: Number(collaboration.planVersion) || 1,
            policy: collaboration.policy || {},
            tasks: (collaboration.tasks || []).map((task) => ({
              id: task.id,
              dependsOn: task.dependsOn || [],
              role: task.role || '',
              runtime: task.runtime || {},
            })),
          },
        });
      }
      // Mirror the domain outbox into the common command vocabulary. The
      // collaboration table still performs the real sendMessage() effect;
      // these rows are read-only recovery evidence and are never claimed by a
      // generic worker during this migration phase.
      if (typeof store.listAttemptDispatchCommands === 'function') {
        const dispatchCommands = await store.listAttemptDispatchCommands({
          collaborationId: collaboration.id,
          limit: 2_000,
        });
        for (const command of dispatchCommands) {
          try {
            const step = await ledger.ensureStep({
              executionId: execution.id,
              stableKey: `attempt:${command.attemptId || command.id}`,
              kind: 'collaboration_attempt_dispatch',
              input: {
                domainCommandId: command.id,
                taskId: command.taskId,
                attemptId: command.attemptId,
              },
            });
            const projected = await ledger.enqueueCommand({
              executionId: execution.id,
              stepId: step.id,
              kind: 'collaboration_attempt_dispatch',
              idempotencyKey: `domain:${command.id}`,
              payload: {
                domainCommandId: command.id,
                collaborationId: collaboration.id,
                taskId: command.taskId,
                attemptId: command.attemptId,
                sessionId: command.sessionId,
                requestId: command.requestId,
              },
            });
            if (typeof ledger.observeCommandState === 'function') {
              const observedState = command.state === 'completed'
                ? 'completed'
                : command.state === 'cancelled' ? 'cancelled' : 'pending';
              await ledger.observeCommandState(projected.id, {
                state: observedState,
                externalEffectId: command.runId || '',
                failureReason: command.failureReason || '',
              });
            }
          } catch (error) {
            // A single malformed legacy outbox row must not hide the
            // collaboration checkpoint or block the real dispatcher.
            console.warn(`[orchestration] dispatch command mirror failed for ${collaboration.id}/${command.id}: ${error?.message || error}`);
          }
        }
      }
      const mirroredCheckpoint = {
        collaborationState: collaboration.state || 'ready',
        activeTaskIds: (collaboration.tasks || [])
          .filter((task) => ['ready', 'running', 'retrying'].includes(task.state))
          .map((task) => task.id),
        ...checkpoint,
      };
      if (!Object.hasOwn(checkpoint, 'stage') && execution.checkpoint?.stage) {
        mirroredCheckpoint.stage = execution.checkpoint.stage;
      }
      const heartbeatAge = Date.now() - Date.parse(execution.lastHeartbeatAt || '');
      // Reconciliation runs frequently. A checkpoint update carries durable
      // state, whereas a heartbeat only proves that the authority was still
      // reachable. Limit the latter to once/minute and keep it out of the
      // audit event log so an idle collaboration cannot cause write churn.
      const heartbeat = !Number.isFinite(heartbeatAge) || heartbeatAge >= LEDGER_HEARTBEAT_MS;
      const executionState = ['completed', 'failed', 'cancelled'].includes(collaboration.state)
        ? collaboration.state
        : (collaboration.state === 'ready' ? 'ready' : 'running');
      const checkpointUnchanged = execution.state === executionState
        && JSON.stringify(execution.checkpoint) === JSON.stringify(mirroredCheckpoint);
      return ledger.checkpointExecution(execution.id, {
        state: executionState,
        checkpoint: mirroredCheckpoint,
        heartbeat,
        recordEvent: !checkpointUnchanged,
        eventType: 'collaboration_checkpoint_mirrored',
      });
    } catch (error) {
      console.warn(`[orchestration] collaboration ledger mirror failed for ${collaboration.id}: ${error?.message || String(error)}`);
      return null;
    }
  }

  // Repair the generic read/recovery ledger from the authoritative
  // collaboration store. This has no child-session or provider side effect;
  // it exists specifically for a process crash between a domain mutation and
  // its observational mirror write.
  async function reconcileLedger({ activeOnly = true, limit = 500 } = {}) {
    const maximum = Math.max(1, Math.min(Number(limit) || 500, 2_000));
    // Fetch one extra row so the report accurately says whether a bounded
    // recovery pass left more active work for the following pass.
    const records = await store.listCollaborationRecords({ activeOnly, limit: maximum + 1 });
    const bounded = records.slice(0, maximum);
    let mirrored = 0;
    let failed = 0;
    for (const collaboration of bounded) {
      if (await mirrorCollaborationExecution(collaboration)) mirrored += 1;
      else failed += 1;
    }
    return { scanned: bounded.length, mirrored, failed, truncated: records.length > bounded.length };
  }

  async function publishCollaborationTerminal(collaborationId) {
    const collaboration = await store.getCollaboration(collaborationId, { includeEvents: true });
    if (!collaboration || !isTerminal(collaboration.state)) return false;
    const state = trim(collaboration.state);
    const finishedEvent = [...(collaboration.events || [])].reverse().find((event) => event.type === 'collaboration_finished');
    const failureReason = trim(finishedEvent?.payload?.reason || '');
    try {
      await deps.emitTriggerEvent('collaboration_terminal', {
        eventId: `collaboration:${collaboration.id}`,
        collaborationId: collaboration.id,
        rootSessionId: collaboration.rootSessionId,
        state,
        summary: failureReason || (state === 'completed' ? 'All collaboration work completed.' : `Collaboration ended with state ${state}.`),
        failureReason,
        completedAt: collaboration.updatedAt || nowIso(),
      });
      return true;
    } catch (error) {
      console.error(`[collaboration] terminal wake publication failed for ${collaboration.id}: ${error.message || String(error)}`);
      return false;
    }
  }

  // Compile every user/LLM plan through one side-effect-free gate first. The
  // same gate powers validation and real dispatch, so a plan cannot pass a
  // preview then fail later because it was interpreted differently.
  async function prepareRecord(input = {}) {
    const root = await loadRoot({ rootSessionId: input.rootSessionId });
    const policy = input.policy || resolveSessionCollaborationPolicy(root, await deps.getApp(root.templateId));
    assertManagerCanDelegate(policy, { childCount: Array.isArray(input.plan?.tasks) ? input.plan.tasks.length : 0, depth: root.delegationDepth || 0 });
    let plan = compileCollaborationPlan(input.plan, policy);
    // S6 project binding: the project always comes from the existing session
    // binding (root.projectId or an explicit dispatch projectId) — never
    // auto-created from an Agent selection. New-style tasks (declaring the
    // split dimensions or a projectId) require a binding; legacy plans without
    // a binding keep working unchanged.
    const projectBinding = trim(input.projectId) || trim(root.projectId);
    const tasksDeclareBinding = plan.tasks.some((task) => trim(task.projectId));
    const tasksDeclareNewStyle = plan.tasks.some((task) => task.accessMode || task.executionIsolation);
    if (!projectBinding && (tasksDeclareBinding || tasksDeclareNewStyle)) {
      const error = new Error('Collaboration tasks require a project binding; creating a Project from an Agent selection is not allowed');
      error.code = 'COLLABORATION_PROJECT_REQUIRED';
      throw error;
    }
    if (trim(root.projectId) && projectBinding && trim(root.projectId) !== projectBinding) {
      const error = new Error(`Root session project ${root.projectId} does not match collaboration project ${projectBinding}`);
      error.code = 'COLLABORATION_PROJECT_MISMATCH';
      throw error;
    }
    if (projectBinding) {
      if (typeof deps.getProject === 'function') {
        const bound = await deps.getProject(projectBinding).catch(() => null);
        if (!bound) {
          const error = new Error(`Project not found for collaboration binding: ${projectBinding}`);
          error.code = 'COLLABORATION_PROJECT_NOT_FOUND';
          throw error;
        }
      }
      for (const task of plan.tasks) {
        const declared = trim(task.projectId);
        if (declared && declared !== projectBinding) {
          const error = new Error(`Task ${task.id} declares project ${declared} but the collaboration binding is ${projectBinding}`);
          error.code = 'COLLABORATION_PROJECT_MISMATCH';
          throw error;
        }
      }
      plan = Object.freeze({
        ...plan,
        tasks: plan.tasks.map((task) => Object.freeze({ ...task, projectId: projectBinding })),
      });
    }
    await validateWorkspacePlan({
      rootPath: root.folder,
      mode: plan.workspacePolicy,
      accessMode: plan.accessMode,
      executionIsolation: plan.executionIsolation,
      tasks: plan.tasks,
    });
    const agentContracts = {};
    for (const task of plan.tasks) {
      const app = await deps.getApp(task.agentId);
      if (!app) {
        const error = new Error(`Agent not found: ${task.agentId}`);
        error.code = 'COLLABORATION_AGENT_NOT_FOUND';
        throw error;
      }
      const agentPolicy = resolveSessionCollaborationPolicy(null, app);
      const agentProfile = await buildAgentCapabilityProfile(app).catch(() => null);
      if (agentPolicy.role !== task.role) {
        const error = new Error(`Task role ${task.role} does not match Agent role ${agentPolicy.role}: ${task.agentId}`);
        error.code = 'COLLABORATION_AGENT_ROLE_MISMATCH';
        throw error;
      }
      const effective = buildEffectiveCapability({
        systemPolicy: { canWrite: true, canReview: true },
        managerPolicy: policy,
        agentPolicy,
        grant: {
          canWrite: task.writablePaths.length > 0,
          canReview: task.role === 'reviewer',
        },
        workspacePolicy: { mode: plan.workspacePolicy },
      });
      if (task.writablePaths.length > 0 && !effective.canWrite) {
        const error = new Error(`Agent cannot write task paths: ${task.agentId}`);
        error.code = 'COLLABORATION_CAPABILITY_DENIED';
        throw error;
      }
      if (task.role === 'reviewer' && !effective.canReview) {
        const error = new Error(`Agent cannot perform review tasks: ${task.agentId}`);
        error.code = 'COLLABORATION_CAPABILITY_DENIED';
        throw error;
      }
      let runtime = null;
      const requestedRuntime = task.runtime || {};
      const policyRuntime = policy.runtimePolicy || {};
      const childTool = trim(app.tool);
      const shouldResolveRuntime = Object.keys(requestedRuntime).length > 0
        || ORGANIZATION_RUNTIME_TOOLS.includes(childTool)
        || runtimePolicyHasConstraints(policyRuntime)
        || runtimePolicyHasConstraints(agentProfile?.runtimePolicy);
      if (shouldResolveRuntime) {
        try {
          runtime = await resolveRuntimeSelection({
            requested: requestedRuntime,
            profile: agentProfile || { toolId: childTool },
            parentGrant: { runtimePolicy: policyRuntime },
            getModels: deps.getModels,
            getProviders: deps.getProviders,
          });
        } catch (error) {
          error.code ||= 'COLLABORATION_RUNTIME_REJECTED';
          throw error;
        }
      }
      agentContracts[task.id] = {
        agentId: task.agentId,
        role: agentPolicy.role,
        agentRevision: agentPolicy.revision,
        policyRevision: `${policy.revision}:${agentPolicy.revision}`,
        capabilities: {
          canWrite: effective.canWrite,
          canReview: effective.canReview,
        },
        ...(runtime ? { runtime } : {}),
      };
    }
    plan = Object.freeze({
      ...plan,
      tasks: plan.tasks.map((task) => Object.freeze({
        ...task,
        ...(agentContracts[task.id]?.runtime ? { runtime: agentContracts[task.id].runtime } : {}),
      })),
    });
    const frozenPolicy = {
      ...policy,
      agentContracts,
      planGates: plan.gates,
    };
    return {
      root,
      policy: frozenPolicy,
      plan,
    };
  }

  async function createRecord(input = {}) {
    const prepared = await prepareRecord(input);
    const existing = await store.listCollaborationRecords({ activeOnly: false });
    const usedTaskIds = new Set(existing.flatMap((record) => record.tasks.map((task) => task.id)));
    const plan = namespacePlanTaskIds(prepared.plan, usedTaskIds);
    const collaboration = await store.createCollaborationRecord({
      rootSessionId: prepared.root.id,
      title: trim(input.title) || plan.title,
      policy: prepared.policy,
      plan,
      idempotencyKey: trim(input.idempotencyKey),
    });
    await mirrorCollaborationExecution(collaboration, { stage: 'plan_frozen' });
    return collaboration;
  }

  async function validate(input = {}) {
    const prepared = await prepareRecord(input);
    // Return a compact, serializable contract that a harness or a future
    // native tool-call can feed back to the model. Credentials, App bodies and
    // mutable Session fields are deliberately excluded.
    return {
      valid: true,
      rootSessionId: prepared.root.id,
      projectId: trim(input.projectId) || trim(prepared.root.projectId),
      plan: prepared.plan,
      policy: {
        revision: prepared.policy.revision,
        maxConcurrent: prepared.policy.maxConcurrent,
        workspacePolicy: prepared.policy.workspacePolicy,
        accessMode: prepared.policy.accessMode,
        executionIsolation: prepared.policy.executionIsolation,
      },
    };
  }

  // Delivery is intentionally separated from planning/admission. The store
  // owns a durable outbox row before session-manager is called, and the stable
  // requestId makes a replay safe if this process dies after the child accepts
  // the turn but before the Run id reaches the collaboration projection.
  async function drainDispatchCommands(collaborationId, { limit = 32 } = {}) {
    if (typeof store.claimPendingDispatchCommands !== 'function'
        || typeof store.completeAttemptDispatch !== 'function'
        || typeof store.deferAttemptDispatch !== 'function') return 0;
    const commands = await store.claimPendingDispatchCommands({ collaborationId, limit });
    let delivered = 0;
    for (const command of commands) {
      try {
        const outcome = await deps.sendMessage(command.sessionId, command.prompt, [], {
          ...command.options,
          requestId: command.requestId,
        });
        const runId = trim(outcome?.run?.id);
        if (!runId) throw new Error(`Child dispatch was not admitted to a Run: ${command.taskId}`);
        const bound = await store.completeAttemptDispatch(command.id, {
          claimToken: command.claimToken,
          runId,
        });
        // A lost claim means another recovered dispatcher owns the command.
        // Do not turn that benign race into a task failure.
        if (bound) delivered += 1;
      } catch (error) {
        await store.deferAttemptDispatch(command.id, {
          claimToken: command.claimToken,
          reason: error?.message || String(error),
        }).catch(() => {});
      }
    }
    return delivered;
  }

  async function reserveAttempt(task, root, collaboration) {
    const attemptNumber = Number(task.currentAttempt || 0) + 1;
    const externalTriggerId = `collaboration:${collaboration.id}:${task.id}:attempt:${attemptNumber}`;
    const app = await deps.getApp(task.agentId);
    if (!app) {
      const error = new Error(`Agent not found: ${task.agentId}`);
      error.code = 'COLLABORATION_AGENT_NOT_FOUND';
      throw error;
    }
    const contract = collaboration.policy?.agentContracts?.[task.id];
    const livePolicy = resolveSessionCollaborationPolicy(null, app);
    if (contract && (contract.agentRevision !== livePolicy.revision || contract.role !== livePolicy.role)) {
      const error = new Error(`Agent policy revision changed after plan freeze: ${task.agentId}`);
      error.code = 'COLLABORATION_POLICY_REVISION_MISMATCH';
      throw error;
    }
    // S6 reader certification dimensions are derived once per attempt (the
    // gate itself runs inside the try below so a refusal is audited as a
    // deterministic failed attempt instead of a zombie ready collaboration).
    const policyAccessMode = ['read', 'write'].includes(collaboration.policy?.accessMode)
      ? collaboration.policy.accessMode
      : 'write';
    const policyIsolation = ['shared', 'worktree', 'container'].includes(collaboration.policy?.executionIsolation)
      ? collaboration.policy.executionIsolation
      : 'shared';
    const taskAccessMode = ['read', 'write'].includes(task.accessMode) ? task.accessMode : policyAccessMode;
    const taskIsolation = ['shared', 'worktree', 'container'].includes(task.executionIsolation)
      ? task.executionIsolation
      : policyIsolation;
    const runtime = contract?.runtime || task.runtime || {};
    const childTool = trim(runtime.tool) || trim(app.tool) || trim(root.tool);
    const providerProfile = trim(runtime.provider || runtime.providerProfile);
    const managedSessionId = trim(task.managedSessionId);
    let managedTarget = null;
    if (managedSessionId) {
      // A pre-provisioned Organization Session may only be consumed by a
      // Runtime-created collaboration that is explicitly bound to the same
      // organization/node. Never let a caller select an arbitrary managed
      // Session through the generic collaboration API.
      managedTarget = await deps.getSession(managedSessionId);
      const expectedOrganizationId = trim(collaboration.policy?.organizationId);
      const expectedNodeId = trim(collaboration.policy?.organizationNodeId);
      if (!managedTarget
        || managedTarget.sessionPlane !== 'organization'
        || !expectedOrganizationId
        || trim(managedTarget.organizationId) !== expectedOrganizationId
        || (expectedNodeId && trim(managedTarget.organizationNodeId) !== expectedNodeId)) {
        const error = new Error(`Managed Session target is not bound to this Organization task: ${task.id}`);
        error.code = 'COLLABORATION_MANAGED_SESSION_BINDING_INVALID';
        error.statusCode = 409;
        throw error;
      }
      const activeRunState = trim(managedTarget.activity?.run?.state).toLowerCase();
      if (managedTarget.activeRunId || ['queued', 'starting', 'running', 'awaiting_approval', 'cancelling'].includes(activeRunState)) {
        const error = new Error(`Managed Session is already running: ${managedSessionId}`);
        error.code = 'COLLABORATION_MANAGED_SESSION_BUSY';
        error.statusCode = 409;
        throw error;
      }
    }
    // S11 managed writer: an organization-plane writer task running under
    // MANAGED_WRITER_ENABLED works on a private staging workspace instead of
    // the canonical root. The staging dir becomes the worker's cwd; on
    // completion completeRun() validates the diff and commits through
    // executeMutation(). Non-managed attempts keep the exact pre-S11 path.
    const managedWriter = managedWriterEnabled
      && root?.sessionPlane === 'organization'
      && taskAccessMode !== 'read'
      && task.role !== 'reviewer'
      && Array.isArray(task.writablePaths) && task.writablePaths.length > 0;
    // Claim before creating a worktree, staging area or Session. If this
    // process dies after the claim, the bounded dispatch phase is recoverable;
    // if it dies before the claim, it has made no durable scheduling decision.
    // This materially narrows the former orphan-child window.
    const reserveBeforeRun = typeof store.bindAttemptRun === 'function';
    const reserved = reserveBeforeRun
      ? await store.claimTaskAttempt(task.id, { sessionId: managedTarget?.id || '' })
      : null;
    if (reserveBeforeRun && !reserved) return null;
    let staging = null;
    let worktreeRef = '';
    let child = null;
    try {
      if (managedWriter && typeof deps.createStagingWorkspace === 'function') {
        staging = await deps.createStagingWorkspace({
          canonicalCwd: root.folder,
          writablePaths: task.writablePaths,
        });
      } else if (collaboration.policy?.workspacePolicy === 'git-worktree') {
      // The worktree path is derived from (collaborationId, taskId). Without
      // the attempt number a retried attempt would collide with the previous
      // attempt's path and `git worktree add` would fail with "already a
      // working tree". Scoping the path to the attempt keeps every retry on
      // its own isolated worktree while the child session's sourceContext
      // still carries the logical task id.
        worktreeRef = await deps.createGitWorktree({
          rootPath: root.folder,
          collaborationId: collaboration.id,
          taskId: `${task.id}:attempt:${attemptNumber}`,
        });
      }
      const childFolder = staging?.stagingDir || worktreeRef || root.folder;
    // A managed writer child is bound to the staging workspace, so its session
    // must not be forced back onto the canonical project root (session-manager
    // would rewrite the folder from a projectId). The attempt itself still
    // carries the canonical project via claimTaskAttempt -> task.project_id.
      const sourceContext = staging
      ? {
          collaborationId: collaboration.id,
          taskId: task.id,
          policyRevision: contract?.policyRevision || '',
          managedWriter: {
            stagingDir: staging.stagingDir,
            canonicalCwd: staging.mapping.canonicalCwd,
            writablePaths: staging.mapping.writablePaths,
          },
        }
      : worktreeRef
        ? {
            collaborationId: collaboration.id,
            taskId: task.id,
            worktreeRef,
            policyRevision: contract?.policyRevision || '',
          }
        : null;
      child = managedTarget || await deps.createSession(childFolder, childTool, `${collaboration.title} · ${task.id}`, {
      ...(managedWriter ? {} : { projectId: task.projectId || root.projectId || '' }),
      templateId: app.id,
      templateName: app.name,
      sourceId: root.sourceId || '',
      sourceName: root.sourceName || '',
      delegatedFromSessionId: root.id,
      delegationDepth: Number(root.delegationDepth || 0) + 1,
      externalTriggerId,
      group: root.group || '',
      description: `Collaboration task ${task.id}`,
      ...(sourceContext ? { sourceContext } : {}),
      ...(providerProfile ? { providerProfile } : {}),
      ...(trim(runtime.model) ? { model: trim(runtime.model) } : {}),
      ...(trim(runtime.effort) ? { effort: trim(runtime.effort) } : {}),
    });
      if (!child?.id) throw new Error(`Unable to create child session for task ${task.id}`);
    // S12: under REVIEWER_ENABLED a reviewer task always executes through the
    // certified read-only runtime — its workspace must be mounted read-only.
    // The access mode is forced to 'read' regardless of the policy projection
    // so a reviewer can never silently become a writer.
    const reviewerReadOnlyRequired = reviewerEnabled && task.role === 'reviewer';
    const effectiveTaskAccessMode = reviewerReadOnlyRequired ? 'read' : taskAccessMode;
    const requestedRunnerId = reviewerReadOnlyRequired
      ? (trim(task.runnerId) || REVIEWER_RUNTIME_ID)
      : (trim(task.runnerId) || null);
      // S6/S12 reader certification: a read task must be backed by a runtime
      // that declares supportsReadOnlyFilesystem (S4 runtime-adapter). Role,
      // prompt or empty writablePaths never constitute a read-only guarantee;
      // without certification the reader is refused instead of silently
      // becoming a writer. shared writer concurrency is left to the
      // WorkspaceLease, which already gates every project-bound Run.
      // S12 reviewers are refused with READ_ONLY_RUNTIME_REFUSED (503) — never
      // downgraded; S6 readers keep READ_ONLY_RUNTIME_UNAVAILABLE (409).
      if (effectiveTaskAccessMode === 'read' && typeof deps.resolveRuntimeReadOnlyCapability === 'function') {
        const capability = await deps.resolveRuntimeReadOnlyCapability({
          toolId: childTool,
          runnerId: requestedRunnerId,
          envOverrides: null,
          runnerUnitScope: trim(task.runnerUnitScope) || null,
          platform: process.platform,
        });
        if (!capability || capability.supportsReadOnlyFilesystem !== true) {
          const errorCode = reviewerReadOnlyRequired ? 'READ_ONLY_RUNTIME_REFUSED' : 'READ_ONLY_RUNTIME_UNAVAILABLE';
          const error = new Error(`${errorCode}: ${reviewerReadOnlyRequired
            ? `reviewer task ${task.id} has no certified read-only runtime; refusing to start`
            : `Read-only runtime is not available for reader task ${task.id}; refusing to start a writer`}`);
          error.code = errorCode;
          if (reviewerReadOnlyRequired) error.statusCode = 503;
          throw error;
        }
        // S12 sandbox pre-flight: the read-only sandbox must be constructible
        // (and bwrap present) before the reviewer run is dispatched. A failure
        // refuses the reviewer run — the orchestrator never downgrades to an
        // unsandboxed execution.
        if (reviewerReadOnlyRequired && typeof deps.buildReviewerSandbox === 'function') {
          try {
            await deps.buildReviewerSandbox({
              command: childTool,
              cwd: root.folder,
              runnerHome: trim(process.env.HOME) || '',
            });
          } catch (sandboxError) {
            const refusal = new Error(`READ_ONLY_RUNTIME_REFUSED: reviewer sandbox for task ${task.id} could not be built: ${sandboxError?.message || String(sandboxError)}`);
            refusal.code = 'READ_ONLY_RUNTIME_REFUSED';
            refusal.statusCode = 503;
            throw refusal;
          }
        }
      }
      const requestId = makeRequestId(collaboration.id, task.id, reserved?.attemptNumber || Number(task.currentAttempt || 0) + 1);
      const prompt = buildTaskPrompt(task, collaboration.attempts.filter((item) => (
        item.state === 'succeeded' && collaboration.tasks.some((candidate) => candidate.id === item.taskId && task.dependsOn.includes(candidate.id))
      )));
      const options = {
        templateId: app.id,
        tool: childTool,
        ...(providerProfile ? { providerProfile } : {}),
        ...(trim(runtime.model) ? { model: trim(runtime.model) } : {}),
        ...(trim(runtime.effort) ? { effort: trim(runtime.effort) } : {}),
        internalOperation: 'collaboration_task',
        // A worker prompt is provider input, not an owner message.  Keeping it
        // out of the user transcript also prevents auto-naming, user-intent
        // routing and follow-up UI from treating the dispatch as user activity.
        recordUserMessage: false,
        skipSessionContinuation: true,
        sourceContext: {
          kind: 'collaboration_dispatch',
          collaborationId: collaboration.id,
          taskId: task.id,
          rootSessionId: root.id,
        },
        collaborationCapability: {
          resourceType: 'collaboration',
          resourceId: collaboration.id,
          rootSessionId: root.id,
        },
        accessMode: effectiveTaskAccessMode,
        executionIsolation: taskIsolation,
        ...(effectiveTaskAccessMode === 'read' ? { readOnlyRequired: true } : {}),
        ...(requestedRunnerId ? { runnerId: requestedRunnerId } : {}),
        ...(trim(task.runnerUnitScope) ? { runnerUnitScope: trim(task.runnerUnitScope) } : {}),
      };
      if (typeof store.enqueueAttemptDispatch === 'function') {
        const command = await store.enqueueAttemptDispatch({
          collaborationId: collaboration.id,
          taskId: task.id,
          attemptId: reserved.id,
          sessionId: child.id,
          requestId,
          prompt,
          options,
        });
        if (!command) throw new Error(`Unable to persist child dispatch for task ${task.id}`);
        return { attempt: reserved, child, queued: true };
      }
      // Compatibility path for deployments that are upgraded piecemeal. New
      // databases always use the durable outbox above.
      const outcome = await deps.sendMessage(child.id, prompt, [], { ...options, requestId });
      const runId = trim(outcome?.run?.id);
      if (!runId) throw new Error(`Child task did not produce a Run: ${task.id}`);
      if (typeof store.bindAttemptRun === 'function') await store.bindAttemptRun(reserved.id, { sessionId: child.id, runId });
      return { attempt: reserved, child, run: outcome.run };
    } catch (error) {
      // A staging workspace created for a managed writer must never be left
      // behind when the attempt does not reach a terminal run.
      if (staging) await deps.discardStaging(staging.stagingDir).catch(() => {});
      if (reserved) {
        // S6/S12 typed admission failures: a reader/reviewer without a
        // certified read-only runtime (or a reviewer whose read-only sandbox
        // cannot be built) is a deterministic refusal (no retry); a
        // WorkspaceLease conflict is transient (the holder finishes and
        // reconcile retries).
        const leaseConflict = error?.code === 'WORKSPACE_LEASE_CONFLICT';
        const readOnlyUnavailable = error?.code === 'READ_ONLY_RUNTIME_UNAVAILABLE'
          || error?.code === 'READ_ONLY_RUNTIME_REFUSED';
        const failureKind = readOnlyUnavailable
          ? 'deterministic_failure'
          : leaseConflict ? 'transient' : 'unknown_outcome';
        const policyAllows = (kind) => reserved.attemptNumber < Number(task.retry?.maxAttempts || 1)
          && Array.isArray(task.retry?.retryOn)
          && task.retry.retryOn.includes(kind);
        const retry = failureKind === 'unknown_outcome'
          ? policyAllows('unknown_outcome')
          : failureKind === 'transient' ? policyAllows('transient') : false;
        await store.completeAttempt(reserved.id, {
          state: 'failed',
          failureKind,
          failureReason: error.message || String(error),
          retry,
          envelope: { taskId: task.id, sessionId: child?.id || '', attempt: reserved.attemptNumber },
          report: { summary: '', risks: [], blockers: [error.message || String(error)], acceptanceNotes: [] },
        }).catch(() => {});
        await store.refreshBarrier(collaboration.id).catch(() => {});
        await publishCollaborationTerminal(collaboration.id);
      }
      return null;
    }
  }

  async function dispatchReady(collaborationId) {
    return exclusive(collaborationId, async () => {
      let collaboration = await store.getCollaboration(collaborationId);
      if (!collaboration || ['completed', 'failed', 'cancelled'].includes(collaboration.state)) return collaboration;
      await store.markReadyTasks(collaborationId);
      collaboration = await store.getCollaboration(collaborationId);
      const running = collaboration.tasks.filter((task) => task.state === 'running').length;
      const maxConcurrent = Number(collaboration.policy?.maxConcurrent || 1);
      const slots = Math.max(0, maxConcurrent - running);
      const ready = collaboration.tasks.filter((task) => task.state === 'ready').slice(0, slots);
      const root = await loadRoot(collaboration);
      for (const task of ready) {
        await reserveAttempt(task, root, collaboration);
      }
      await drainDispatchCommands(collaborationId);
      const refreshed = await store.getCollaboration(collaborationId);
      await mirrorCollaborationExecution(refreshed, { stage: 'dispatch_ready' });
      return refreshed;
    });
  }

  // S13 NEEDS_CHANGES chain (constitution §2.6/§2.14): never mutates the old
  // packet or gate. Records the needs_changes decision as a fresh gate
  // generation (CAS), then opens a new collaboration whose attempts rework the
  // phase. The rework attempt's ResultPacket v2 chains to the old packet via
  // parentPacketIds (see completeRun). The caller may then re-decide the gate
  // (passed) on the new packet to move the phase forward.
  async function dispatchRework({
    rootSessionId,
    plan,
    projectId = '',
    organizationId,
    phaseId,
    parentPacketId,
    nodeId = '',
    revision,
    fromGateGeneration = null,
    decidedByNodeId = '',
    acceptance = [],
    idempotencyKey = '',
  } = {}) {
    if (!trim(organizationId) || !trim(phaseId) || !trim(parentPacketId)) {
      const error = new Error('dispatchRework requires organizationId, phaseId and parentPacketId');
      error.code = 'BAD_REQUEST';
      throw error;
    }
    const gate = await deps.decideGate({
      organizationId,
      phaseId,
      fromGeneration: fromGateGeneration,
      decision: 'needs_changes',
      decidedByNodeId,
      packetId: parentPacketId,
      acceptance,
    });
    const collaboration = await createRecord({ rootSessionId, plan, projectId, idempotencyKey });
    reworkContext.set(collaboration.id, {
      organizationId: trim(organizationId),
      phaseId: trim(phaseId),
      parentPacketId: trim(parentPacketId),
      nodeId: trim(nodeId),
      revision: Number.isInteger(revision) ? revision : undefined,
    });
    await dispatchReady(collaboration.id);
    return {
      collaboration: await store.getCollaboration(collaboration.id, { includeEvents: true }),
      gate,
    };
  }

  async function completeRun(runId) {
    const attempt = await store.findAttemptByRunId(runId);
    if (!attempt) return false;
    // Attempts now carry their owning collaboration from the durable join.
    // Avoid hydrating every collaboration (and every child report) on each
    // runner poll; that load was especially harmful while capacity was tight.
    const taskCollaboration = attempt.collaborationId
      ? await store.getCollaboration(attempt.collaborationId)
      : (await store.listCollaborationRecords()).find((item) => item.tasks.some((task) => task.id === attempt.taskId));
    if (!taskCollaboration) return false;
    const completed = await exclusive(taskCollaboration.id, async () => {
      const currentAttempt = await store.findAttemptByRunId(runId);
      if (!currentAttempt || !['running', 'failed'].includes(currentAttempt.state)) return false;
      const recoverableExpiredAttempt = currentAttempt.state === 'failed'
        && currentAttempt.failureKind === 'unknown_outcome';
      if (currentAttempt.state !== 'running' && !recoverableExpiredAttempt) return false;
      const task = taskById(taskCollaboration, currentAttempt.taskId);
      const run = await deps.getRunState(runId) || await deps.getRun(runId);
      if (!run) return false;
      if (!isTerminal(run.state)) {
        if (currentAttempt.state === 'running' && typeof store.observeAttemptRun === 'function') {
          await store.observeAttemptRun(currentAttempt.id, runLifecycleObservation(run));
        }
        return false;
      }
      const result = await deps.getRunResult(runId) || run.result || null;
      const manifest = await deps.getRunManifest(runId);
      const outcome = classifyAttemptOutcome(run, result);
      const reportLoader = typeof deps.loadRecentTurnHistory === 'function'
        ? deps.loadRecentTurnHistory
        : deps.loadHistory;
      const report = latestAssistantReport(await reportLoader(run.sessionId, { includeBodies: true }).catch(() => []));
      const session = await deps.getSession(currentAttempt.sessionId).catch(() => null);
      const envelope = buildEnvelope(run, result, manifest, currentAttempt, session);
      const packetProjectId = trim(task?.projectId) || trim(manifest?.projectId) || trim(manifest?.executionScope?.projectId);
      const canRetry = outcome.retryable
        && currentAttempt.attemptNumber < task.retry.maxAttempts
        && task.retry.retryOn.includes(outcome.failureKind);
      // S11 managed writer finalization: an organization writer attempt ran
      // against its private staging workspace. Resolve the diff (fail-closed
      // on any writablePaths escape), commit through executeMutation(), then
      // surface the committed files on the envelope. A MANAGED_WRITE_ESCAPE
      // (409) fails the attempt deterministically and never reaches a packet.
      const managedWriter = session?.sourceContext?.managedWriter || null;
      if (managedWriter) {
        let committed = null;
        try {
          committed = await deps.commitStagingToCanonical({
            stagingDir: managedWriter.stagingDir,
            canonicalCwd: managedWriter.canonicalCwd,
            writablePaths: managedWriter.writablePaths,
            resourceKeys: Array.isArray(managedWriter.resourceKeys) ? managedWriter.resourceKeys : null,
            runId,
          });
        } catch (error) {
          const isEscape = error?.code === 'MANAGED_WRITE_ESCAPE';
          const label = isEscape ? 'MANAGED_WRITE_ESCAPE' : (error?.code || 'error');
          await store.completeAttempt(currentAttempt.id, {
            state: 'failed',
            failureKind: 'deterministic_failure',
            failureReason: `Managed writer commit failed (${label}): ${error?.message || String(error)}`,
            retry: false,
            envelope: { ...envelope, resultPacketId: '' },
            report: {
              ...report,
              blockers: [...(report.blockers || []), `Managed writer commit failed (${label}): ${error?.message || String(error)}`],
            },
          });
          await store.refreshBarrier(taskCollaboration.id);
          await publishCollaborationTerminal(taskCollaboration.id);
          return true;
        }
        if (committed?.committed && Array.isArray(committed.changes)) {
          const changed = committed.changes.map((change) => change.path).filter(Boolean);
          envelope.changedFiles = [...new Set([...(envelope.changedFiles || []), ...changed])];
        }
      }
      // S6 result handoff: worker results are closed to a canonical
      // ResultPacket (S5). The attempt stores only the rsp_ reference — the
      // packet content is never copied into the collaboration store.
      let resultPacketId = '';
      try {
        // S13: a rework attempt (opened via dispatchRework) derives its
        // ResultPacket v2 org/phase fields and chains the previous packet via
        // parentPacketIds. Non-rework attempts pass nothing, keeping the packet
        // shape and digest semantics identical to S5.
        const rework = reworkContext.get(taskCollaboration.id) || null;
        const packet = await deps.createExecutionPacket({
          runId,
          projectId: packetProjectId,
          sessionId: trim(run?.sessionId) || trim(currentAttempt.sessionId),
          taskId: currentAttempt.taskId,
          attemptId: currentAttempt.id,
          organizationId: rework?.organizationId || '',
          nodeId: rework?.nodeId || '',
          revision: rework?.revision,
          phaseId: rework?.phaseId || '',
          parentPacketIds: rework?.parentPacketId ? [rework.parentPacketId] : [],
          deps: {
            getRun: deps.getRun,
            getRunManifest: deps.getRunManifest,
            getRunResult: deps.getRunResult,
          },
        });
        resultPacketId = packet?.packetId || '';
        if (packetProjectId && !resultPacketId) throw new Error('Execution ResultPacket was not created for a project-bound Attempt');
      } catch (error) {
        if (packetProjectId) {
          await store.completeAttempt(currentAttempt.id, {
            state: 'failed',
            failureKind: 'deterministic_failure',
            failureReason: `ResultPacket creation failed: ${error?.message || String(error)}`,
            retry: false,
            envelope: { ...envelope, resultPacketId: '' },
            report: {
              ...report,
              blockers: [...(report.blockers || []), `ResultPacket creation failed: ${error?.message || String(error)}`],
            },
          });
          await store.refreshBarrier(taskCollaboration.id);
          await publishCollaborationTerminal(taskCollaboration.id);
          return true;
        }
      }
      const settled = await store.completeAttempt(currentAttempt.id, {
        ...outcome,
        allowRecovery: outcome.state === 'succeeded',
        retry: canRetry,
        failureReason: outcome.failureKind ? envelope.failureReason : '',
        resultPacketId,
        envelope: { ...envelope, resultPacketId },
        report,
      });
      if (!settled) return false;
      await store.refreshBarrier(taskCollaboration.id);
      return true;
    });
    if (completed) {
      await dispatchReady(taskCollaboration.id);
      await maybeAggregate(taskCollaboration.id);
      await publishCollaborationTerminal(taskCollaboration.id);
      await mirrorCollaborationExecution(await store.getCollaboration(taskCollaboration.id), {
        stage: 'run_terminalized',
        runId,
      });
    }
    return completed;
  }

  async function maybeAggregate(collaborationId) {
    const collaboration = await store.getCollaboration(collaborationId);
    if (!collaboration || collaboration.state !== 'waiting_aggregation') return null;
    const generation = await store.claimAggregation(collaborationId);
    if (generation === null || generation === undefined) return null;
    const root = await loadRoot(collaboration);
    try {
      const packetProjections = await mapWithResultPacketConcurrency(collaboration.attempts, async (attempt) => {
        if (!attempt.resultPacketId || typeof deps.getResultPacket !== 'function') return null;
        const packet = await deps.getResultPacket(attempt.resultPacketId).catch(() => null);
        return packet ? { attemptId: attempt.id, packet: boundedPacketProjection(packet) } : null;
      });
      const missingProjectPackets = collaboration.attempts.some((attempt) => attempt.projectId && !packetProjections.find((entry) => entry?.attemptId === attempt.id));
      if (missingProjectPackets) {
        throw new Error('Project-bound collaboration is missing a canonical ResultPacket');
      }
      const outcome = await deps.sendMessage(root.id, buildAggregationPrompt(collaboration, packetProjections.filter(Boolean)), [], {
        requestId: `collaboration:${collaboration.id}:aggregation:${generation}`,
        recordUserMessage: false,
        internalOperation: 'collaboration_resume',
        // Never put a manager aggregation behind owner follow-ups.  A busy
        // root returns a non-mutating deferral; the collaboration state machine
        // will claim this generation again after the owner turn terminalizes.
        queueIfBusy: false,
        deferIfBusy: true,
        skipSessionContinuation: true,
        sourceContext: {
          kind: 'collaboration_aggregation',
          collaborationId: collaboration.id,
          aggregationGeneration: generation,
        },
      });
      if (outcome?.deferred === true) {
        await store.deferAggregation(collaboration.id, {
          generation,
          reason: 'Root session is busy with another turn',
        });
        return null;
      }
      const runId = trim(outcome?.run?.id);
      if (!runId) throw new Error('Manager aggregation did not produce a Run');
      await store.setAggregationRun(collaboration.id, runId);
      return runId;
    } catch (error) {
      await store.finishCollaboration(collaboration.id, 'failed', error.message || String(error));
      await publishCollaborationTerminal(collaboration.id);
      return null;
    }
  }

  async function completeAggregation(runId) {
    const collaboration = (await store.listCollaborationRecords()).find((item) => item.aggregationRunId === runId);
    if (!collaboration) return false;
    const run = await deps.getRunState(runId) || await deps.getRun(runId);
    if (!run || !isTerminal(run.state)) return false;
    await store.finishCollaboration(collaboration.id, run.state === 'completed' ? 'completed' : run.state, run.failureReason || '');
    await publishCollaborationTerminal(collaboration.id);
    return true;
  }

  async function reconcile() {
    const active = await store.listCollaborationRecords({ activeOnly: true });
    // Read expiring Attempts once per sweep. The previous per-collaboration
    // query multiplied SQLite work by the number of active collaborations and
    // made the control plane increasingly busy exactly when a backlog formed.
    const expiredByCollaboration = new Map();
    for (const attempt of await store.listExpiredAttempts(new Date())) {
      const list = expiredByCollaboration.get(attempt.collaborationId) || [];
      list.push(attempt);
      expiredByCollaboration.set(attempt.collaborationId, list);
    }
    for (const collaboration of active) {
      // Observe/terminalize durable Run truth before considering any timeout.
      // This ordering closes the race that orphaned successful children: an
      // arriving result always wins over a same-poll deadline scan.
      for (const task of collaboration.tasks) {
        if (task.runId) await completeRun(task.runId).catch(() => {});
      }
      const expired = expiredByCollaboration.get(collaboration.id) || [];
      for (const attempt of expired) {
        const fresh = await store.getCollaboration(collaboration.id);
        const task = taskById(fresh, attempt.taskId);
        // The store remains the single authority for frozen retry policy.  A
        // timeout never creates a second child unless that policy explicitly
        // permits an unknown outcome; otherwise the exact Run remains eligible
        // for bounded late-success recovery below.
        const retry = !!task
          && attempt.attemptNumber < Number(task.retry?.maxAttempts || 1)
          && Array.isArray(task.retry?.retryOn)
          && task.retry.retryOn.includes('unknown_outcome');
        await store.requeueExpiredAttempt(attempt.id, {
          retry,
          failureKind: 'unknown_outcome',
          reason: `Attempt ${attempt.lifecyclePhase || 'running'} deadline expired before a terminal result was observed`,
        }).catch(() => {});
      }
      await store.refreshBarrier(collaboration.id).catch(() => {});
      await publishCollaborationTerminal(collaboration.id);
      if (collaboration.aggregationRunId) await completeAggregation(collaboration.aggregationRunId).catch(() => {});
      await dispatchReady(collaboration.id).catch(() => {});
      await maybeAggregate(collaboration.id).catch(() => {});
      await mirrorCollaborationExecution(await store.getCollaboration(collaboration.id), { stage: 'reconcile' });
    }
    // A failed collaboration is normally terminal, but a just-expired
    // unknown-outcome Attempt may already have a successful Run result on
    // disk.  Re-read that bounded recovery set so it is repaired instead of
    // becoming an invisible orphan.  This is provider/harness agnostic.
    if (typeof store.listRecoverableAttemptRuns === 'function') {
      for (const attempt of await store.listRecoverableAttemptRuns()) {
        await completeRun(attempt.runId).catch(() => {});
      }
    }
    return active.length;
  }

  async function start() {
    if (timer) return;
    if (typeof store.initializeCollaborationStore === 'function') await store.initializeCollaborationStore();
    await reconcile();
    timer = setInterval(() => { void reconcile().catch(() => {}); }, pollMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function dispatch(input) {
    const collaboration = input?.id
      ? await store.getCollaboration(input.id)
      : await createRecord(input);
    if (!collaboration) return null;
    await dispatchReady(collaboration.id);
    await publishCollaborationTerminal(collaboration.id);
    return store.getCollaboration(collaboration.id, { includeEvents: true });
  }

  async function cancel(collaborationId, reason = 'cancelled by manager') {
    const collaboration = await store.getCollaboration(collaborationId);
    if (!collaboration) return false;
    for (const attempt of collaboration.attempts.filter((item) => item.state === 'running')) {
      if (attempt.runId) await deps.requestRunCancel(attempt.runId).catch(() => {});
    }
    const cancelled = await store.cancelCollaboration(collaborationId, reason);
    if (cancelled) await publishCollaborationTerminal(collaborationId);
    return cancelled;
  }

  async function retry(collaborationId, reason = 'manual retry requested') {
    const collaboration = await store.getCollaboration(collaborationId);
    if (!collaboration) return null;
    if (collaboration.state === 'completed' || collaboration.state === 'cancelled') {
      const error = new Error(`Collaboration is ${collaboration.state} and cannot be retried`);
      error.code = 'COLLABORATION_NOT_RETRYABLE';
      throw error;
    }
    // Deterministic action: only failed attempts that the frozen retry policy
    // still allows are re-queued. Each candidate is evaluated individually so a
    // partial batch stays auditable and a repeat call converges to retried 0.
    const candidates = collaboration.attempts.filter((item) => item.state === 'failed');
    const retryable = [];
    let retried = 0;
    for (const attempt of candidates) {
      const queued = await store.retryFailedAttempt(attempt.id, { reason });
      retryable.push({
        attemptId: attempt.id,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        failureKind: attempt.failureKind,
        retryable: Boolean(queued),
        reason: queued ? 'queued for retry' : 'not retryable under frozen retry policy',
      });
      if (queued) retried += 1;
    }
    if (retried > 0) {
      await store.refreshBarrier(collaborationId).catch(() => {});
      await dispatchReady(collaborationId);
    }
    return {
      retried,
      retryable,
      collaboration: await store.getCollaboration(collaborationId, { includeEvents: true }),
    };
  }

  return {
    cancel,
    completeAggregation,
    completeRun,
    createRecord,
    dispatch,
    dispatchReady,
    dispatchRework,
    get: (id) => store.getCollaboration(id, { includeEvents: true }),
    list: (options) => store.listCollaborationRecords(options),
    maybeAggregate,
    reconcile,
    reconcileLedger,
    retry,
    start,
    stop,
    validate,
  };
}

let defaultOrchestrator = null;

export function getDefaultCollaborationOrchestrator(options = {}) {
  if (!defaultOrchestrator) defaultOrchestrator = createCollaborationOrchestrator(options);
  return defaultOrchestrator;
}
