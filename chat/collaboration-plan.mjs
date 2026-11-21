import { assertAgentAllowed, ROLES, projectWorkspacePolicy } from './collaboration-policy.mjs';
import { normalizeRuntimeSelection } from './organization-runtime-selection.mjs';

// C3: consultation tasks are read-only by construction. A plan that declares a
// write path on a consultation task is a read-only contract violation (403).
export const CONSULTATION_READONLY_VIOLATION = 'CONSULTATION_READONLY_VIOLATION';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map(trimString).filter(Boolean))] : [];
}

function normalizeRetry(value = {}) {
  const maxAttempts = Number.parseInt(String(value.maxAttempts ?? 1), 10);
  const retryOn = list(value.retryOn || ['transient']).filter((item) => (
    ['transient', 'unknown_outcome', 'deterministic_failure'].includes(item)
  ));
  return {
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 5) : 1,
    retryOn: retryOn.length > 0 ? retryOn : ['transient'],
  };
}

function normalizeTask(task, index) {
  const id = trimString(task?.id || task?.taskId || task?.key) || `task-${index + 1}`;
  const role = trimString(task?.role || 'specialist').toLowerCase();
  const taskKind = ['execution', 'consultation'].includes(trimString(task?.taskKind).toLowerCase())
    ? trimString(task?.taskKind).toLowerCase()
    : 'execution';
  let readOnlyRequired = task?.readOnlyRequired === true || task?.readOnlyRequired === 1;
  if (taskKind === 'consultation') {
    // Runtime 强制只读:consultation 任务不可降级为可写(read_only_required 恒为 1)。
    readOnlyRequired = true;
  }
  return {
    id,
    objective: trimString(task?.objective || task?.task),
    agentId: trimString(task?.agentId),
    role,
    taskKind,
    readOnlyRequired,
    dependsOn: list(task?.dependsOn),
    acceptance: list(task?.acceptance),
    writablePaths: list(task?.writablePaths),
    retry: normalizeRetry(task?.retry),
    timeoutMs: Number.isInteger(task?.timeoutMs) && task.timeoutMs > 0
      ? Math.min(task.timeoutMs, 24 * 60 * 60 * 1000)
      : 20 * 60 * 1000,
    workspaceMode: trimString(task?.workspaceMode),
    projectId: trimString(task?.projectId),
    // Organization Runtime may bind a task to a session that was already
    // provisioned from a Frozen Revision. This field is only consumed by the
    // server-side Organization phase dispatcher; ordinary collaboration input
    // cannot authorize a managed-session target by itself.
    managedSessionId: trimString(task?.managedSessionId),
    accessMode: ['read', 'write'].includes(trimString(task?.accessMode).toLowerCase())
      ? trimString(task?.accessMode).toLowerCase()
      : undefined,
    executionIsolation: ['shared', 'worktree', 'container'].includes(trimString(task?.executionIsolation).toLowerCase())
      ? trimString(task?.executionIsolation).toLowerCase()
      : undefined,
    runtime: task?.runtime === undefined ? {} : normalizeRuntimeSelection(task.runtime),
    runnerId: trimString(task?.runnerId) || undefined,
    runnerUnitScope: trimString(task?.runnerUnitScope) || undefined,
  };
}

function pathOverlaps(left, right) {
  const a = trimString(left).replace(/\\/g, '/').replace(/\/+$/, '');
  const b = trimString(right).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw Object.assign(new Error(`Collaboration plan contains a dependency cycle at ${id}`), { code: 'COLLABORATION_PLAN_CYCLE' });
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw Object.assign(new Error(`Unknown task dependency: ${id}`), { code: 'COLLABORATION_PLAN_DEPENDENCY' });
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function compileCollaborationPlan(input = {}, policy) {
  if (!policy) throw Object.assign(new Error('Manager collaboration policy is required'), { code: 'COLLABORATION_POLICY_DENIED' });
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length === 0) throw Object.assign(new Error('Collaboration plan requires at least one task'), { code: 'COLLABORATION_PLAN_EMPTY' });
  if (rawTasks.length > policy.maxChildren) throw Object.assign(new Error(`Collaboration plan exceeds maxChildren (${policy.maxChildren})`), { code: 'COLLABORATION_CHILD_LIMIT' });

  const tasks = rawTasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw Object.assign(new Error(`Duplicate collaboration task id: ${task.id}`), { code: 'COLLABORATION_PLAN_DUPLICATE' });
    ids.add(task.id);
    if (!ROLES.has(task.role)) throw Object.assign(new Error(`Unknown collaboration task role: ${task.role}`), { code: 'COLLABORATION_PLAN_ROLE' });
    if (!task.objective) throw Object.assign(new Error(`Task objective is required: ${task.id}`), { code: 'COLLABORATION_PLAN_OBJECTIVE' });
    assertAgentAllowed(policy, task.agentId, task.role);
    if (task.role === 'reviewer' && task.writablePaths.length > 0) {
      throw Object.assign(new Error(`Reviewer task cannot declare writablePaths: ${task.id}`), { code: 'COLLABORATION_REVIEWER_WRITE' });
    }
    if (task.taskKind === 'consultation' && (task.writablePaths.length > 0 || task.accessMode === 'write')) {
      throw Object.assign(new Error(`Consultation task must be read-only: ${task.id}`), { code: CONSULTATION_READONLY_VIOLATION, statusCode: 403 });
    }
  }
  assertAcyclic(tasks);

  const gates = {
    independentReview: input.gates?.independentReview === true,
  };
  if (gates.independentReview && !tasks.some((task) => task.role === 'reviewer')) {
    throw Object.assign(new Error('Independent review gate requires at least one reviewer task'), { code: 'COLLABORATION_REVIEW_REQUIRED' });
  }

  // S6: writer rules key off the split dimensions (new fields win over the
  // legacy workspacePolicy projection). shared+write allows at most one
  // writer; read never allows a writer; worktree/container allow parallel
  // writers (their isolation provides the independent physical keys).
  const projected = projectWorkspacePolicy(policy.workspacePolicy);
  const accessMode = ['read', 'write'].includes(policy.accessMode) ? policy.accessMode : projected.accessMode;
  const executionIsolation = ['shared', 'worktree', 'container'].includes(policy.executionIsolation)
    ? policy.executionIsolation
    : projected.executionIsolation;
  const writers = tasks.filter((task) => task.writablePaths.length > 0);
  const taskWritesReadOnly = tasks.some((task) => task.accessMode === 'read' && task.writablePaths.length > 0);
  if (taskWritesReadOnly) {
    throw Object.assign(new Error('a read-only task cannot declare writablePaths'), { code: 'COLLABORATION_WORKSPACE_CONFLICT' });
  }
  if (accessMode === 'read' && writers.length > 0) {
    throw Object.assign(new Error('read-only-review does not permit writer tasks'), { code: 'COLLABORATION_WORKSPACE_CONFLICT' });
  }
  const sharedWriters = writers.filter((task) => (
    (task.executionIsolation || executionIsolation) === 'shared'
    && (task.accessMode || accessMode) === 'write'
  ));
  if (sharedWriters.length > 1) {
    throw Object.assign(new Error('shared-exclusive permits at most one writer task; use git-worktree for parallel writers'), { code: 'COLLABORATION_WORKSPACE_CONFLICT' });
  }
  // Realpath + relative containment is performed by the async workspace
  // validator. This synchronous compiler intentionally does not make a
  // lexical path decision that could diverge from the physical filesystem.

  return Object.freeze({
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    title: trimString(input.title) || 'Ragent collaboration',
    workspacePolicy: policy.workspacePolicy,
    accessMode,
    executionIsolation,
    gates,
    tasks: tasks.map((task) => Object.freeze({ ...task, dependsOn: [...task.dependsOn], acceptance: [...task.acceptance], writablePaths: [...task.writablePaths] })),
  });
}

export function classifyAttemptOutcome(run, result = null) {
  if (run?.state === 'completed') return { state: 'succeeded', failureKind: null, retryable: false };
  if (run?.state === 'cancelled' || run?.cancelRequested === true) return { state: 'cancelled', failureKind: 'cancelled', retryable: false };
  // A failed terminal Run is distinct from an ordinary tool error in a live
  // Run. Text supplied by a provider or model is not a trusted error code.
  // Even a known failure does not establish that external effects are safe
  // to repeat, so recovery must reconcile them before any new attempt.
  if (run?.state === 'failed' && result && result.synthesized !== true) {
    if (typeof result.signal === 'string' && result.signal.trim()) {
      return { state: 'failed', failureKind: 'process_signal', retryable: false };
    }
    if (Number.isInteger(result.exitCode) && result.exitCode !== 0) {
      return { state: 'failed', failureKind: 'process_exit', retryable: false };
    }
  }
  return { state: 'failed', failureKind: 'unknown_outcome', retryable: false };
}

export { pathOverlaps };
