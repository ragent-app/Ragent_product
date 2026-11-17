// Collaboration policy (Execution-Scope slice 6, design section 9).
//
// The legacy workspacePolicy enum (shared-exclusive / git-worktree /
// read-only-review) is split into the two frozen orthogonal dimensions:
//   accessMode        : 'read' | 'write'
//   executionIsolation: 'shared' | 'worktree' | 'container'
//
// Additive compatibility: the new fields win when present; workspacePolicy is
// kept as a projection for legacy readers (read old -> write new). Reviewer
// role, prompt or empty writablePaths never constitute a read-only guarantee —
// read access is only granted by the runtime certification layer (S4).
const AGENT_CAPABILITIES = new Set(['read','write','manage','review','aggregate','input','run']);
export function normalizeExplicitAgentCapabilities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > AGENT_CAPABILITIES.size || value.some(item => typeof item !== 'string' || !AGENT_CAPABILITIES.has(item))) {
    throw Object.assign(new Error('Agent capabilities must be a non-empty list of supported lowercase capabilities'), { code: 'AGENT_CAPABILITIES_INVALID', statusCode: 400 });
  }
  if (new Set(value).size !== value.length) throw Object.assign(new Error('Duplicate Agent capability'), { code: 'AGENT_CAPABILITIES_INVALID', statusCode: 400 });
  return [...value].sort();
}

const ROLES = new Set(['manager', 'specialist', 'reviewer']);
const WORKSPACE_POLICIES = new Set(['shared-exclusive', 'git-worktree', 'read-only-review']);
const ACCESS_MODES = new Set(['read', 'write']);
const EXECUTION_ISOLATIONS = new Set(['shared', 'worktree', 'container']);
import { normalizeRuntimePolicy } from './organization-runtime-selection.mjs';

// Legacy -> split projection (design §9 compatibility table).
const WORKSPACE_POLICY_PROJECTION = {
  'shared-exclusive': { accessMode: 'write', executionIsolation: 'shared' },
  'read-only-review': { accessMode: 'read', executionIsolation: 'shared' },
  'git-worktree': { accessMode: 'write', executionIsolation: 'worktree' },
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value, fallback, max = 1000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function nonNegativeInt(value, fallback, max = 1_000_000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(trimString).filter(Boolean))].slice(0, 200);
}

/**
 * Project a legacy workspacePolicy label into the split dimensions.
 * Returns { accessMode, executionIsolation, workspacePolicy }.
 */
export function projectWorkspacePolicy(value) {
  const key = WORKSPACE_POLICIES.has(trimString(value).toLowerCase())
    ? trimString(value).toLowerCase()
    : 'shared-exclusive';
  return { ...WORKSPACE_POLICY_PROJECTION[key], workspacePolicy: key };
}

/**
 * Compat projection back to the legacy label (new fields win). container has
 * no legacy equivalent, so it projects to shared-exclusive for old readers.
 */
export function compatWorkspacePolicy(accessMode, executionIsolation) {
  const mode = ACCESS_MODES.has(accessMode) ? accessMode : 'write';
  const isolation = EXECUTION_ISOLATIONS.has(executionIsolation) ? executionIsolation : 'shared';
  if (mode === 'read') return 'read-only-review';
  if (isolation === 'worktree') return 'git-worktree';
  return 'shared-exclusive';
}

export function normalizeCollaborationPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const role = trimString(value.role).toLowerCase();
  if (!ROLES.has(role)) return null;
  const workspacePolicy = WORKSPACE_POLICIES.has(trimString(value.workspacePolicy).toLowerCase())
    ? trimString(value.workspacePolicy).toLowerCase()
    : 'shared-exclusive';
  const projected = projectWorkspacePolicy(workspacePolicy);
  const accessMode = ACCESS_MODES.has(trimString(value.accessMode).toLowerCase())
    ? trimString(value.accessMode).toLowerCase()
    : projected.accessMode;
  const executionIsolation = EXECUTION_ISOLATIONS.has(trimString(value.executionIsolation).toLowerCase())
    ? trimString(value.executionIsolation).toLowerCase()
    : projected.executionIsolation;
  let allowedCapabilities;
  if (Object.hasOwn(value, 'allowedCapabilities')) {
    try { allowedCapabilities = normalizeExplicitAgentCapabilities(value.allowedCapabilities); } catch { /* Legacy malformed input remains unconfigured. */ }
  }
  return {
    role,
    ...(allowedCapabilities ? { allowedCapabilities } : {}),
    canDelegate: value.canDelegate === true && role === 'manager',
    canWrite: value.canWrite !== false && role !== 'reviewer',
    canReview: value.canReview !== false,
    allowedAgentIds: normalizeStringList(value.allowedAgentIds),
    maxChildren: positiveInt(value.maxChildren, 16, 200),
    maxConcurrent: positiveInt(value.maxConcurrent, 4, 64),
    maxDepth: nonNegativeInt(value.maxDepth, 1, 8),
    tokenBudget: positiveInt(value.tokenBudget, 200_000, 10_000_000),
    workspacePolicy,
    accessMode,
    executionIsolation,
    runtimePolicy: normalizeRuntimePolicy(value.runtimePolicy || value.runtime || {}),
    allowedRoles: normalizeStringList(value.allowedRoles).filter((item) => ROLES.has(item)),
    revision: trimString(value.revision) || '1',
  };
}

export function defaultSpecialistPolicy() {
  return normalizeCollaborationPolicy({ role: 'specialist', canDelegate: false });
}

// ROOT_LEADERSHIP is the canonical runtime boundary for the user's root
// session.  Do not require the absence of template/agent presentation
// metadata here: older persisted root sessions, and roots created through an
// Agent entry point, may retain those fields while still being the explicit
// user-plane root.  Lineage and session-plane checks remain mandatory so a
// managed child cannot inherit root delegation merely by copying metadata.
function isRootLeadershipSession(session) {
  return trimString(session?.sessionClass) === 'ROOT_LEADERSHIP'
    && trimString(session?.sessionPlane || 'user') === 'user'
    && session?.userAddressable !== false
    && !trimString(session?.delegatedFromSessionId)
    && !trimString(session?.parentSessionId);
}

export function defaultRootLeadershipPolicy() {
  return normalizeCollaborationPolicy({ role: 'manager', canDelegate: true });
}

export function normalizeSessionCollaborationOverrides(value, { strict = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw Object.assign(new Error('Overrides must be an object'), { statusCode: 400 });
    return {};
  }
  const limits = { maxChildren: [1, 200], maxConcurrent: [1, 64], maxDepth: [0, 8] };
  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if (key === 'canDelegate' && typeof input === 'boolean') {
      if (!input) result.canDelegate = false;
    } else if (limits[key] && Number.isInteger(input) && input >= limits[key][0] && input <= limits[key][1]) {
      result[key] = input;
    } else if (strict) {
      throw Object.assign(new Error(`Invalid collaboration override: ${key}`), { statusCode: 400 });
    }
  }
  return result;
}

export function resolveSessionCollaborationPolicy(session, app) {
  const base = normalizeCollaborationPolicy(app?.collaborationPolicy)
    || normalizeCollaborationPolicy(session?.collaborationPolicy)
    || (isRootLeadershipSession(session) ? defaultRootLeadershipPolicy() : null)
    || defaultSpecialistPolicy();
  const overrides = normalizeSessionCollaborationOverrides(session?.collaborationPolicyOverrides);
  return { ...base, ...overrides };
}

export function assertManagerCanDelegate(policy, { childCount = 0, depth = 0 } = {}) {
  if (!policy?.canDelegate || policy.role !== 'manager') {
    throw Object.assign(new Error('Collaboration delegation requires a manager Agent policy'), { code: 'COLLABORATION_POLICY_DENIED' });
  }
  if (depth > policy.maxDepth) {
    throw Object.assign(new Error(`Collaboration depth limit reached (${policy.maxDepth})`), { code: 'COLLABORATION_DEPTH_LIMIT' });
  }
  if (childCount >= policy.maxChildren) {
    throw Object.assign(new Error(`Collaboration child limit reached (${policy.maxChildren})`), { code: 'COLLABORATION_CHILD_LIMIT' });
  }
}

export function assertAgentAllowed(policy, agentId, role = 'specialist') {
  const normalizedAgentId = trimString(agentId);
  if (!normalizedAgentId) throw new Error('task agentId is required');
  if (policy.allowedAgentIds.length > 0 && !policy.allowedAgentIds.includes(normalizedAgentId)) {
    throw Object.assign(new Error(`Agent is not allowed by the manager policy: ${normalizedAgentId}`), { code: 'COLLABORATION_AGENT_DENIED' });
  }
  if (policy.allowedRoles.length > 0 && !policy.allowedRoles.includes(role)) {
    throw Object.assign(new Error(`Agent role is not allowed by the manager policy: ${role}`), { code: 'COLLABORATION_ROLE_DENIED' });
  }
}

export function buildEffectiveCapability({ systemPolicy = {}, managerPolicy, agentPolicy, grant = {}, workspacePolicy = {} } = {}) {
  const allowed = (value) => value !== false;
  const projected = projectWorkspacePolicy(trimString(workspacePolicy.mode) || managerPolicy?.workspacePolicy || 'shared-exclusive');
  const accessMode = ACCESS_MODES.has(trimString(workspacePolicy.accessMode).toLowerCase())
    ? trimString(workspacePolicy.accessMode).toLowerCase()
    : (ACCESS_MODES.has(managerPolicy?.accessMode) ? managerPolicy.accessMode : projected.accessMode);
  const executionIsolation = EXECUTION_ISOLATIONS.has(trimString(workspacePolicy.executionIsolation).toLowerCase())
    ? trimString(workspacePolicy.executionIsolation).toLowerCase()
    : (EXECUTION_ISOLATIONS.has(managerPolicy?.executionIsolation)
      ? managerPolicy.executionIsolation
      : projected.executionIsolation);
  return {
    canDelegate: [systemPolicy.canDelegate, managerPolicy?.canDelegate, agentPolicy?.canDelegate, grant.canDelegate].every(allowed),
    canWrite: [systemPolicy.canWrite, managerPolicy?.canWrite, agentPolicy?.canWrite, grant.canWrite].every(allowed),
    canReview: [systemPolicy.canReview, managerPolicy?.canReview, agentPolicy?.canReview, grant.canReview].every(allowed),
    workspacePolicy: trimString(workspacePolicy.mode) || managerPolicy?.workspacePolicy || 'shared-exclusive',
    accessMode,
    executionIsolation,
    writablePaths: normalizeStringList(grant.writablePaths),
    policyRevision: [trimString(managerPolicy?.revision), trimString(agentPolicy?.revision)].filter(Boolean).join(':') || '1',
  };
}

export { ROLES, WORKSPACE_POLICIES, ACCESS_MODES, EXECUTION_ISOLATIONS };
