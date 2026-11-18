// Organization roles are Revision facts, not AgentTemplate permissions.
// Agent capabilities still form the upper ceiling; this module computes the
// organization-side grant that is materialized into Node/DelegationGrant facts.

const ROLE_CONTRACTS = Object.freeze({
  manager: Object.freeze({ canDelegate: true, canWrite: true, canReview: true, accessMode: 'writer', maxChildren: 16, maxConcurrent: 4, maxDepth: 3 }),
  phase_lead: Object.freeze({ canDelegate: true, canWrite: true, canReview: true, accessMode: 'writer', maxChildren: 16, maxConcurrent: 4, maxDepth: 3 }),
  specialist: Object.freeze({ canDelegate: false, canWrite: true, canReview: false, accessMode: 'writer', maxChildren: 0, maxConcurrent: 1, maxDepth: 0 }),
  worker: Object.freeze({ canDelegate: false, canWrite: true, canReview: false, accessMode: 'writer', maxChildren: 0, maxConcurrent: 1, maxDepth: 0 }),
  writer: Object.freeze({ canDelegate: false, canWrite: true, canReview: false, accessMode: 'writer', maxChildren: 0, maxConcurrent: 1, maxDepth: 0 }),
  reviewer: Object.freeze({ canDelegate: false, canWrite: false, canReview: true, accessMode: 'read_only', maxChildren: 0, maxConcurrent: 1, maxDepth: 0 }),
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].sort();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integer(value, fallback, max = 1_000_000) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function fail(message, code = 'ORG_CAPABILITY_ESCALATION') {
  return Object.assign(new Error(message), { code, statusCode: 422 });
}

function normalizePath(value) {
  const path = text(value).replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (path === '..' || path.startsWith('../') || path.includes('/../')) return null;
  return path;
}

function pathWithin(child, parent) {
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  return !!childPath && !!parentPath
    && (childPath === parentPath || childPath.startsWith(`${parentPath === '/' ? '' : parentPath}/`));
}

function pathsWithin(requested, parent) {
  const parents = list(parent);
  return list(requested).every((path) => parents.some((base) => pathWithin(path, base)));
}

function roleName(role) {
  return text(role).toLowerCase();
}

export function getOrganizationRoleContract(role) {
  const normalized = roleName(role);
  return ROLE_CONTRACTS[normalized] ? { role: normalized, ...ROLE_CONTRACTS[normalized] } : null;
}

export function deriveOrganizationGrant({
  role,
  capabilities = [],
  profileCapabilities = [],
  agentProfile = null,
  parentGrant = {},
  scope = {},
  scopes = {},
  maxDepth = null,
  maxChildren = null,
  maxConcurrent = null,
  runtimePolicy = null,
} = {}) {
  const contract = getOrganizationRoleContract(role);
  if (!contract) throw fail(`unknown organization role: ${role}`, 'ORG_ROLE_NOT_ALLOWED');
  const requested = list(capabilities).map((value) => value.toLowerCase());
  const profile = list(profileCapabilities).map((value) => value.toLowerCase());
  const selected = requested.length > 0 ? requested : profile;
  if (profile.length > 0 && selected.some((capability) => !profile.includes(capability))) {
    throw fail(`organization role ${contract.role} requests a capability absent from the Agent profile`);
  }
  const parentCapabilities = list(parentGrant.allowedCapabilities).map((value) => value.toLowerCase());
  if (parentCapabilities.length > 0 && selected.some((capability) => !parentCapabilities.includes(capability))) {
    throw fail('organization role requests a capability outside the parent grant');
  }
  if (!contract.canWrite && selected.includes('write')) {
    throw fail(`${contract.role} is read-only and cannot receive write capability`);
  }
  if (!contract.canReview && selected.includes('review')) {
    throw fail(`${contract.role} cannot receive review capability`);
  }

  const requestedScope = { ...object(scopes), ...object(scope) };
  const writablePaths = list(requestedScope.writablePaths);
  const parentPaths = list(parentGrant.writablePaths || parentGrant.scope?.writablePaths);
  if (!contract.canWrite && writablePaths.length > 0) {
    throw fail(`${contract.role} cannot receive writable paths`);
  }
  if (parentPaths.length > 0 && !pathsWithin(writablePaths, parentPaths)) {
    throw fail('organization role expands writable paths beyond the parent grant');
  }
  const workspaceScope = text(requestedScope.workspaceScope || requestedScope.workspaceRoot);
  const parentWorkspace = text(parentGrant.workspaceScope || parentGrant.scope?.workspaceScope);
  if (workspaceScope && parentWorkspace && !pathWithin(workspaceScope, parentWorkspace)) {
    throw fail('organization role expands workspace scope beyond the parent grant');
  }
  const projectId = text(requestedScope.projectId || parentGrant.projectId || parentGrant.scope?.projectId);
  if (text(requestedScope.projectId) && parentGrant.projectId && text(requestedScope.projectId) !== text(parentGrant.projectId)) {
    throw fail('organization role changes project identity');
  }

  const parentAccess = text(parentGrant.accessMode).toLowerCase() || 'writer';
  const agentAccess = agentProfile ? (text(agentProfile.accessMode).toLowerCase() || 'read_only') : 'writer';
  if (agentProfile && !['read_only', 'writer'].includes(agentAccess)) throw fail('Agent access mode denies execution');
  const requestedAccess = text(requestedScope.accessMode).toLowerCase();
  if (['writer', 'write'].includes(requestedAccess)
      && (parentAccess === 'read_only' || agentAccess !== 'writer' || (agentProfile && !profile.includes('write')))) {
    throw fail('Requested write access exceeds the Agent or parent grant');
  }
  const accessMode = contract.accessMode === 'read_only' || requestedAccess === 'read_only' || parentAccess === 'read_only' || agentAccess === 'read_only'
    || (agentProfile && !profile.includes('write'))
    ? 'read_only'
    : 'writer';
  if (parentAccess === 'read_only' && accessMode !== 'read_only') {
    throw fail('organization role raises access mode beyond the parent grant');
  }
  const parentIsolation = text(parentGrant.executionIsolation).toLowerCase() || 'shared';
  const executionIsolation = text(requestedScope.executionIsolation).toLowerCase() || parentIsolation;
  if (!['shared', 'worktree', 'container'].includes(executionIsolation) || executionIsolation !== parentIsolation) {
    throw fail('organization role changes execution isolation');
  }

  const parentMaxDepth = integer(parentGrant.maxDepth, 3, 16);
  const defaultDepth = parentGrant && Object.keys(parentGrant).length > 0
    ? Math.max(0, parentMaxDepth - 1)
    : contract.maxDepth;
  const agentMaxDepth = agentProfile ? integer(agentProfile.maxDepth, 0, 16) : defaultDepth;
  const effectiveMaxDepth = integer(maxDepth, Math.min(defaultDepth, agentMaxDepth), 16);
  if (effectiveMaxDepth > defaultDepth || effectiveMaxDepth > agentMaxDepth) throw fail('organization role raises delegation depth');
  const parentMaxChildren = integer(parentGrant.maxChildren, 16, 200);
  const parentMaxConcurrent = integer(parentGrant.maxConcurrent, 4, 64);
  const agentMaxChildren = agentProfile ? integer(agentProfile.maxChildren, 0, 200) : parentMaxChildren;
  const agentMaxConcurrent = agentProfile ? integer(agentProfile.maxConcurrent, 0, 64) : parentMaxConcurrent;
  const effectiveMaxChildren = integer(maxChildren, contract.canDelegate ? Math.min(parentMaxChildren, agentMaxChildren, 16) : contract.maxChildren, 200);
  const effectiveMaxConcurrent = integer(maxConcurrent, contract.canDelegate ? Math.min(parentMaxConcurrent, agentMaxConcurrent, 4) : Math.min(contract.maxConcurrent, agentMaxConcurrent), 64);
  if (effectiveMaxChildren > parentMaxChildren || effectiveMaxChildren > agentMaxChildren || effectiveMaxConcurrent > parentMaxConcurrent || effectiveMaxConcurrent > agentMaxConcurrent) {
    throw fail('organization role raises child or concurrency quota');
  }

  const canDelegate = contract.canDelegate && parentGrant.canDelegate !== false
    && (!agentProfile || agentProfile.canDelegate === true);
  return {
    organizationRole: contract.role,
    allowedCapabilities: selected,
    writablePaths,
    workspaceScope: workspaceScope || parentWorkspace,
    projectId,
    accessMode,
    executionIsolation,
    maxDepth: effectiveMaxDepth,
    maxChildren: effectiveMaxChildren,
    maxConcurrent: effectiveMaxConcurrent,
    canDelegate,
    canWrite: contract.canWrite && accessMode !== 'read_only',
    canReview: contract.canReview,
    ...(runtimePolicy && typeof runtimePolicy === 'object' ? { runtimePolicy: { ...runtimePolicy } } : {}),
  };
}

export function organizationGrantForNode(node, parentGrant = {}) {
  const definition = object(node);
  const existing = object(definition.grant);
  if (Object.keys(existing).length > 0) return existing;
  return deriveOrganizationGrant({
    role: definition.role,
    capabilities: definition.capabilities,
    profileCapabilities: definition.capabilities,
    parentGrant,
    scope: definition.scope,
    scopes: definition.scopes,
    maxDepth: definition.maxDepth,
    maxChildren: definition.maxChildren,
    maxConcurrent: definition.maxConcurrent,
    runtimePolicy: definition.runtimePolicy,
  });
}

export { ROLE_CONTRACTS };
