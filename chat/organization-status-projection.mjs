// Runtime-derived organization status. This is deliberately a read model:
// Organization, Collaboration, Attempt, Run and Gate stores remain the
// authorities. No model-owned progress value is accepted here.
import { getRun } from './runs.mjs';
import { listCollaborationRecords } from './collaboration-store.mjs';

export const ORGANIZATION_STATUS_PROJECTION_SCHEMA_VERSION = 1;

const ACTIVE_TASK_STATES = new Set(['planned', 'ready', 'retrying', 'running']);
const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE_RUN_STATES = new Set(['queued', 'starting', 'running', 'awaiting_approval', 'cancelling']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value, fallback = 0) { return Number.isInteger(value) ? value : fallback; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function bounded(value, max = 128) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function publicRuntime(runtime) {
  if (!plain(runtime)) return null;
  const result = {};
  for (const key of ['tool', 'provider', 'providerProfile', 'model', 'effort']) {
    const value = bounded(runtime[key], 256);
    if (value) result[key === 'providerProfile' ? 'provider' : key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}
function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}
function latestTimestamp(values, fallback) {
  let candidate = fallback || null;
  let candidateTime = timestamp(candidate);
  for (const value of values) {
    if (!value) continue;
    const valueTime = timestamp(value);
    if (valueTime > candidateTime) {
      candidate = value;
      candidateTime = valueTime;
    }
  }
  return candidate;
}
function latestByNumber(entries, field = 'attemptNumber') {
  return [...entries].sort((left, right) => integer(right?.[field]) - integer(left?.[field]) || timestamp(right?.updatedAt) - timestamp(left?.updatedAt))[0] || null;
}
function safeReasonCode(value, fallback = '') {
  const normalized = text(value).replace(/[^A-Za-z0-9_.:-]/g, '_');
  return bounded(normalized, 96) || fallback;
}
function publicRun(run) {
  if (!run) return null;
  return {
    id: text(run.id),
    state: text(run.state) || 'unknown',
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
  };
}
function runSessionState(run, task, attempt) {
  const runState = text(run?.state);
  if (runState === 'awaiting_approval' || runState === 'waiting_approval') return 'waiting_approval';
  if (ACTIVE_RUN_STATES.has(runState)) return runState === 'queued' ? 'queued' : 'running';
  if (runState === 'completed') return 'completed';
  if (runState === 'cancelled') return 'cancelled';
  if (runState === 'failed') return 'failed';
  if (attempt?.state === 'running' || task?.state === 'running') return 'running';
  if (['planned', 'ready', 'retrying'].includes(task?.state)) return 'queued';
  if (task?.state === 'succeeded') return 'completed';
  if (task?.state === 'cancelled') return 'cancelled';
  if (task?.state === 'failed') return 'failed';
  return 'idle';
}

function nodePhase(node, compiledNodes) {
  const meta = compiledNodes.get(node.stableKey) || {};
  return text(meta.phaseId);
}

function taskForNode(collaboration) {
  const tasks = Array.isArray(collaboration?.tasks) ? collaboration.tasks : [];
  return [...tasks].sort((left, right) => {
    const rank = (task) => task?.state === 'running' ? 0
      : ['ready', 'retrying', 'planned'].includes(task?.state) ? 1
        : task?.state === 'failed' ? 2 : 3;
    return rank(left) - rank(right) || timestamp(right?.updatedAt) - timestamp(left?.updatedAt) || text(left?.id).localeCompare(text(right?.id));
  })[0] || null;
}

function attemptsForTask(collaboration, taskId) {
  return (Array.isArray(collaboration?.attempts) ? collaboration.attempts : [])
    .filter((attempt) => attempt?.taskId === taskId);
}

function publicAttempt(attempt, run) {
  if (!attempt) return null;
  return {
    id: text(attempt.id),
    number: integer(attempt.attemptNumber),
    state: text(attempt.state) || 'unknown',
    sessionId: text(attempt.sessionId),
    runId: text(attempt.runId),
    runState: text(run?.state) || null,
    resultPacketId: text(attempt.resultPacketId) || null,
    failureReasonCode: safeReasonCode(attempt.failureKind),
    startedAt: attempt.startedAt || null,
    completedAt: attempt.completedAt || null,
  };
}

function publicTask(task, attempt, run, phaseId) {
  if (!task) return null;
  return {
    taskId: text(task.id),
    state: text(task.state) || 'unknown',
    objective: bounded(task.objective, 512),
    phaseId: phaseId || null,
    attempt: integer(attempt?.attemptNumber) || integer(task.currentAttempt) || 0,
    sessionId: text(task.sessionId) || text(attempt?.sessionId),
    runId: text(task.runId) || text(attempt?.runId),
    runState: text(run?.state) || null,
  };
}

function deriveBlockers({ node, collaboration, task, attempt, run, events = [] }) {
  const blockers = [];
  if (task?.state === 'blocked') blockers.push({ kind: 'task', taskId: text(task.id), reasonCode: 'task_blocked' });
  if (task?.state === 'failed') blockers.push({
    kind: 'task', taskId: text(task.id), attemptId: text(attempt?.id), reasonCode: safeReasonCode(attempt?.failureKind, 'task_failed'),
  });
  if (run?.state === 'failed') blockers.push({ kind: 'run', taskId: text(task?.id), attemptId: text(attempt?.id), reasonCode: 'run_failed' });
  if (collaboration?.state === 'failed') blockers.push({ kind: 'collaboration', reasonCode: 'collaboration_failed' });
  const reported = events.filter((event) => ['blocker.reported', 'blocker.escalated'].includes(event.type));
  if (reported.length > 0) {
    blockers.push({ kind: 'reported', eventId: reported.at(-1).id, reasonCode: reported.at(-1).type.replace('.', '_') });
  }
  return blockers.slice(0, 8);
}

function deriveNodeState({ node, collaboration, task, run, blockers, gate }) {
  if (node.lifecycleState === 'retired') return 'replaced';
  if (collaboration?.state === 'cancelled' || task?.state === 'cancelled') return 'cancelled';
  if (blockers.length > 0) return 'blocked';
  if (gate && ['open', 'needs_changes', 'decided'].includes(gate.state)
    && node.nodeRole === 'reviewer' && !['passed', 'completed'].includes(gate.state)) return 'waiting_review';
  if (collaboration?.state && ['waiting_aggregation', 'aggregating'].includes(collaboration.state)) return 'waiting_children';
  if (run?.state && ACTIVE_RUN_STATES.has(run.state)) return run.state === 'awaiting_approval' ? 'waiting_review' : 'running';
  if (task?.state === 'running') return 'running';
  if (task?.state === 'succeeded' && collaboration?.state === 'completed') return 'completed';
  if (task && ACTIVE_TASK_STATES.has(task.state)) return task.state === 'running' ? 'running' : 'idle';
  if (task && TERMINAL_TASK_STATES.has(task.state)) return task.state === 'succeeded' ? 'completed' : task.state;
  return node.currentSessionId ? 'idle' : 'unbound';
}

function publicNodeStatus({ node, collaboration, task, attempt, run, phaseId, gate, organization, events = [], runtime, display = {} }) {
  const tasks = Array.isArray(collaboration?.tasks) ? collaboration.tasks : [];
  const completed = tasks.filter((entry) => entry.state === 'succeeded').length;
  const blockers = deriveBlockers({ node, collaboration, task, attempt, run, events });
  const state = deriveNodeState({ node, collaboration, task, run, blockers, gate });
  const attemptEntries = attemptsForTask(collaboration, task?.id);
  const lastChangedAt = latestTimestamp([
    collaboration?.updatedAt,
    task?.updatedAt,
    attempt?.updatedAt,
    run?.completedAt,
    run?.startedAt,
    ...events.map((event) => event.createdAt),
  ], organization.updatedAt);
  const reviewState = node.nodeRole !== 'reviewer' ? 'not_applicable'
    : gate?.state === 'needs_changes' ? 'needs_changes'
      : ['passed', 'completed'].includes(gate?.state) ? 'passed' : 'pending';
  // A recent task can belong to an older binding; never label it as the current session's state.
  const bindingStateVerified = !!node.currentSessionId
    && collaboration?.policy?.organizationId === organization.id
    && collaboration?.policy?.organizationNodeId === node.id
    && collaboration?.policy?.organizationBindingGeneration === node.bindingGeneration
    && attempt?.sessionId === node.currentSessionId
    && (!task?.sessionId || task.sessionId === node.currentSessionId)
    && (!attempt?.runId || (run?.id === attempt.runId && run?.sessionId === node.currentSessionId));
  // Node-wide events and gates are not binding-scoped; they cannot establish this session's state.
  const bindingState = bindingStateVerified ? deriveNodeState({
    node, collaboration, task, run,
    blockers: deriveBlockers({ node, collaboration, task, attempt, run, events: [] }),
    gate: null,
  }) : 'unknown';
  return {
    id: node.id,
    parentId: node.parentNodeId || null,
    role: node.nodeRole,
    currentBinding: { sessionId: node.currentSessionId || null, generation: node.bindingGeneration },
    bindingRuntimeState: bindingState,
    domain: typeof display.domain === 'string' && [...display.domain].length <= 160 ? display.domain : null,
    iconKey: typeof display.iconKey === 'string' && [...display.iconKey].length <= 64 ? display.iconKey : null,
    displayName: node.stableKey,
    phaseId: phaseId || null,
    sessionClass: node.sessionClass || '',
    status: state,
    sessionId: node.currentSessionId || text(task?.sessionId) || null,
    session: node.currentSessionId || task?.sessionId ? {
      id: node.currentSessionId || text(task?.sessionId),
      state: runSessionState(run, task, attempt),
    } : null,
    currentActivity: runSessionState(run, task, attempt),
    currentTask: publicTask(task, attempt, run, phaseId),
    attempt: publicAttempt(attempt, run),
    progress: {
      state,
      completed,
      total: tasks.length,
      epoch: integer(organization.progressEpoch),
    },
    blocker: blockers[0] || null,
    reviewState,
    ...(publicRuntime(runtime) ? { runtime: publicRuntime(runtime) } : {}),
    lastChangedAt,
    ...(attemptEntries.length > 1 ? { attemptCount: attemptEntries.length } : {}),
  };
}

function publicGate(gate) {
  if (!gate) return null;
  return {
    state: text(gate.state) || 'open',
    generation: integer(gate.generation),
    packetId: text(gate.packetId) || null,
    decidedAt: gate.decidedAt || null,
  };
}

function phaseState({ phase, phaseNodes, phaseTasks, gate, completedByEvent }) {
  if (completedByEvent || ['completed', 'passed'].includes(gate?.state) && phaseNodes.length > 0 && phaseNodes.every((node) => ['completed', 'replaced'].includes(node.status))) return 'completed';
  if (gate?.state === 'needs_changes' || phaseNodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (phaseNodes.some((node) => ['running', 'waiting_children'].includes(node.status)) || phaseTasks.some((task) => ACTIVE_TASK_STATES.has(task.state))) return 'running';
  if (gate && ['open', 'decided'].includes(gate.state)) return 'waiting_review';
  return 'planned';
}

// Organization status is a read projection, but a large collaboration can
// reference hundreds of historical Runs. Bound filesystem fan-out so a
// refresh cannot enqueue one status read per Attempt and compete with the
// interactive session path. Results stay in input order for deterministic
// projection output.
async function mapWithBoundedConcurrency(items, mapper, concurrency = 8) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];
  const workerCount = Math.max(1, Math.min(source.length, Number.isInteger(concurrency) ? concurrency : 8));
  const results = new Array(source.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= source.length) return;
      results[index] = await mapper(source[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function collectOrganizationStatus({
  organizationId,
  organization,
  revision,
  nodes = [],
  events = [],
  gates = [],
  collaborations = null,
  runResolver = getRun,
} = {}) {
  const orgId = text(organizationId || organization?.id);
  if (!orgId || !organization) return null;
  const compiled = revision?.compiled || {};
  const compiledNodes = new Map((Array.isArray(compiled.nodes) ? compiled.nodes : []).map((entry) => [text(entry.stableKey), entry]));
  const allCollaborations = collaborations || await listCollaborationRecords({ activeOnly: false });
  const relevant = allCollaborations.filter((entry) => entry?.policy?.organizationId === orgId);
  // Index the bounded event history once. The previous projection path ran a
  // full events.filter() for every node and phase, turning a 5k-event audit
  // tail into an O(nodes * events) refresh on every invalidation.
  const eventsByNode = new Map();
  const completedPhases = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const nodeId = text(event?.nodeId);
    if (nodeId) {
      const nodeEvents = eventsByNode.get(nodeId) || [];
      nodeEvents.push(event);
      eventsByNode.set(nodeId, nodeEvents);
    }
    if (['phase.completed', 'phase_completed'].includes(event?.type)) {
      const phaseId = text(event?.phaseId);
      if (phaseId) completedPhases.add(phaseId);
    }
  }
  // A node can have multiple historical collaboration records after replans.
  // Resolve the latest one once instead of filtering/sorting the same relevant
  // list for every node in the organization.
  const collaborationByNode = new Map();
  for (const collaboration of relevant) {
    const nodeId = text(collaboration?.policy?.organizationNodeId);
    if (!nodeId) continue;
    const current = collaborationByNode.get(nodeId);
    if (!current
      || timestamp(collaboration.updatedAt) > timestamp(current.updatedAt)
      || (timestamp(collaboration.updatedAt) === timestamp(current.updatedAt)
        && text(collaboration.id).localeCompare(text(current.id)) < 0)) {
      collaborationByNode.set(nodeId, collaboration);
    }
  }
  const runIds = new Set();
  for (const collaboration of relevant) {
    for (const attempt of collaboration.attempts || []) if (attempt.runId) runIds.add(attempt.runId);
    for (const task of collaboration.tasks || []) if (task.runId) runIds.add(task.runId);
  }
  const runEntries = await mapWithBoundedConcurrency([...runIds], async (runId) => {
    try { return [runId, await runResolver(runId)]; } catch { return [runId, null]; }
  });
  const runs = new Map(runEntries);
  const latestGates = new Map();
  for (const gate of gates) {
    const current = latestGates.get(gate.phaseId);
    if (!current || integer(gate.generation) > integer(current.generation)) latestGates.set(gate.phaseId, gate);
  }
  const statuses = nodes.map((node) => {
    const collaboration = collaborationByNode.get(text(node.id)) || null;
    const task = taskForNode(collaboration);
    const attempts = attemptsForTask(collaboration, task?.id);
    const attempt = latestByNumber(attempts);
    const run = runs.get(text(task?.runId) || text(attempt?.runId)) || null;
    const phaseId = nodePhase(node, compiledNodes);
    const compiledNode = compiledNodes.get(node.stableKey) || {};
    return publicNodeStatus({
      node,
      collaboration,
      task,
      attempt,
      run,
      phaseId,
      gate: latestGates.get(phaseId),
      organization,
      events: eventsByNode.get(text(node.id)) || [],
      runtime: compiledNode.runtime || task?.runtime,
      display: revision?.state === 'frozen' ? compiledNode : {},
    });
  });
  const statusById = new Map(statuses.map((entry) => [entry.id, entry]));
  const statusesByPhase = new Map();
  for (const node of statuses) {
    const phaseId = text(node.phaseId);
    if (!phaseId) continue;
    const phaseNodes = statusesByPhase.get(phaseId) || [];
    phaseNodes.push(node);
    statusesByPhase.set(phaseId, phaseNodes);
  }
  const phases = (Array.isArray(compiled.phases) ? compiled.phases : []).map((phase) => {
    const phaseNodes = statusesByPhase.get(text(phase.phaseId)) || [];
    const phaseTasks = phaseNodes.map((node) => node.currentTask).filter(Boolean);
    const gate = latestGates.get(phase.phaseId);
    const completedByEvent = completedPhases.has(text(phase.phaseId));
    const state = phaseState({ phase, phaseNodes, phaseTasks, gate, completedByEvent });
    return {
      phaseId: phase.phaseId,
      objective: bounded(phase.objective, 512),
      state,
      dependsOn: [...(phase.dependsOn || [])].map(text).filter(Boolean).sort(),
      acceptance: (Array.isArray(phase.acceptance) ? phase.acceptance : []).slice(0, 128).map((entry) => ({
        criterion: bounded(entry?.criterion, 512), evidenceRequired: entry?.evidenceRequired !== false,
      })).filter((entry) => entry.criterion),
      reviewRequired: phase.reviewRequired !== false,
      reviewState: gate?.state === 'needs_changes' ? 'needs_changes'
        : ['passed', 'completed'].includes(gate?.state) || completedByEvent ? 'complete' : 'pending',
      gate: publicGate(gate),
      progress: {
        completed: phaseNodes.filter((node) => ['completed', 'replaced'].includes(node.status)).length,
        total: phaseNodes.length,
        blocked: phaseNodes.filter((node) => node.status === 'blocked').length,
        activeTasks: phaseTasks.filter((task) => ACTIVE_TASK_STATES.has(task.state)).length,
      },
    };
  });
  const summary = {
    totalNodes: statuses.length,
    runningNodes: statuses.filter((node) => node.status === 'running').length,
    blockedNodes: statuses.filter((node) => node.status === 'blocked').length,
    completedNodes: statuses.filter((node) => node.status === 'completed').length,
    pendingReviews: [...latestGates.values()].filter((gate) => !['passed', 'completed', 'cancelled'].includes(gate.state)).length,
    activeTasks: relevant.reduce((count, collaboration) => count + (collaboration.tasks || []).filter((task) => ACTIVE_TASK_STATES.has(task.state)).length, 0),
  };
  const blockers = statuses.flatMap((node) => node.blocker ? [{ ...node.blocker, nodeId: node.id }] : []).slice(0, 128);
  const state = summary.blockedNodes > 0 ? 'blocked'
    : summary.runningNodes > 0 || summary.activeTasks > 0 ? 'running'
      : summary.pendingReviews > 0 ? 'waiting_review'
        : summary.totalNodes > 0 && summary.completedNodes === summary.totalNodes ? 'completed' : text(organization.state) || 'planning';
  return {
    schemaVersion: ORGANIZATION_STATUS_PROJECTION_SCHEMA_VERSION,
    state,
    summary,
    nodes: statuses,
    phases,
    blockers,
    // Kept private to the composition layer; this makes it easy to test the
    // derivation without leaking collaborations or run records to callers.
    statusById,
  };
}
