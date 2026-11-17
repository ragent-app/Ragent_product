// S21: proposal parser and autonomous organization compiler v2.
//
// The model may only produce an untrusted JSON proposal. This module parses
// and compiles that proposal into a deterministic, frozen-revision candidate.
// It deliberately has no Session/Task/Run writes: callers can use shadow mode
// to inspect the plan, then explicitly apply the returned revision later.
import { createHash } from 'crypto';
import { canonicalJson } from './execution-scope.mjs';
import { resolveDelegatedRuntimeSelection } from './agent-resolver.mjs';
import { getOrganizationRuntimeCapabilities } from './organization-runtime-capabilities.mjs';
import { normalizeRuntimeSelection } from './organization-runtime-selection.mjs';
import { applyRuntimeConstraints, candidateForRuntime, createRuntimeSelectionRecord, filterRuntimeCandidates, normalizeUserRuntimeConstraints } from './organization-runtime-decision.mjs';
import { deriveOrganizationGrant } from './organization-role-contract.mjs';

export const ORGANIZATION_PROPOSAL_SCHEMA_VERSION = 1;
export const PLANNER_ERROR = 'ORG_PLAN_INVALID';
export const PLANNER_CYCLE = 'ORG_PLAN_CYCLE';
export const PLANNER_BUDGET = 'ORG_PLAN_BUDGET_EXCEEDED';
export const PLANNER_REVIEW_REQUIRED = 'ORG_PLAN_REVIEW_REQUIRED';
export const PLANNER_ACCEPTANCE_REQUIRED = 'ORG_PLAN_ACCEPTANCE_REQUIRED';
export const PLANNER_RESOLVER_REJECTED = 'ORG_PLAN_RESOLVER_REJECTED';
export const PLANNER_CAPABILITY_DISABLED = 'ORG_PLAN_CAPABILITY_DISABLED';
export const PLANNER_AMENDMENT_INVALID = 'ORG_PLAN_AMENDMENT_INVALID';

const PLAN_ROLES = new Set(['manager', 'phase_lead', 'specialist', 'worker', 'writer', 'reviewer']);
const PLAN_OPERATIONS = new Set(['add', 'retain', 'retire', 'replace']);
const PLAN_KEYS = new Set([
  'schemaVersion', 'proposalId', 'idempotencyKey', 'objective', 'nodes', 'phases',
  'manages', 'reviewPolicy', 'acceptance', 'budget', 'resolver', 'metadata',
  'order',
]);

function plannerError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode: 422, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value, fallback = null) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, { min = 0, max = 1000000 } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function list(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))].sort()
    : [];
}

function stableDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw plannerError(PLANNER_ERROR, `${label} must be an object`, { reason: 'object_required', field: label });
  }
  return value;
}

function assertNoUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw plannerError(PLANNER_ERROR, `${label} contains an unknown field: ${key}`, {
        reason: 'unknown_field', field: `${label}.${key}`,
      });
    }
  }
}

function normalizeRole(value, label) {
  const role = text(value).toLowerCase();
  if (!PLAN_ROLES.has(role)) throw plannerError(PLANNER_ERROR, `${label} has an unknown role`, { reason: 'unknown_role', role });
  return role;
}

function displayMetadata(value, label, maxLength) {
  if (value === null) return null;
  if (typeof value !== 'string' || [...value.trim()].length > maxLength) {
    throw plannerError(PLANNER_ERROR, `${label} must be a string of at most ${maxLength} characters or null`, { reason: 'invalid_display_metadata', field: label });
  }
  return value.trim() || null;
}

function normalizeNode(raw, index) {
  const value = assertPlainObject(raw, `nodes[${index}]`);
  assertNoUnknownKeys(value, new Set([
    'stableKey', 'role', 'agentId', 'capabilities', 'dependsOn', 'phaseId', 'parentKey',
    'scope', 'scopes', 'runtime', 'runtimePolicy', 'acceptance', 'reviewRequired', 'maxChildren', 'maxConcurrent', 'domain', 'iconKey', 'displayName', 'responsibility', 'runtimeRequirements', 'runtimeRationale',
  ]), `nodes[${index}]`);
  const stableKey = text(value.stableKey);
  if (!stableKey) throw plannerError(PLANNER_ERROR, `nodes[${index}].stableKey is required`, { reason: 'missing_stable_key' });
  const role = normalizeRole(value.role, `nodes[${index}].role`);
  const agentId = text(value.agentId);
  if (!agentId) throw plannerError(PLANNER_ERROR, `node ${stableKey} requires agentId`, { reason: 'missing_agent_id', stableKey });
  const phaseId = text(value.phaseId);
  if (!phaseId) throw plannerError(PLANNER_ERROR, `node ${stableKey} requires phaseId`, { reason: 'missing_phase_id', stableKey });
  const parentKey = text(value.parentKey);
  if (parentKey && parentKey === stableKey) {
    throw plannerError(PLANNER_CYCLE, `node ${stableKey} cannot manage itself`, { stableKey });
  }
  const acceptance = normalizeAcceptance(value.acceptance, `nodes[${index}].acceptance`, { allowEmpty: true });
  const requirements = value.runtimeRequirements === undefined ? {} : assertPlainObject(value.runtimeRequirements, `nodes[${index}].runtimeRequirements`);
  assertNoUnknownKeys(requirements, new Set(['tools', 'environment', 'minimumContextTokens', 'advancedRequired', 'qualityFloor']), `nodes[${index}].runtimeRequirements`);
  if (requirements.tools !== undefined && (!Array.isArray(requirements.tools) || requirements.tools.length > 32
      || requirements.tools.some((tool) => typeof tool !== 'string' || !tool.trim() || tool.length > 120))) {
    throw plannerError(PLANNER_ERROR, 'runtimeRequirements.tools must be a bounded list of tool names');
  }
  if (requirements.environment !== undefined && (typeof requirements.environment !== 'string' || requirements.environment.length > 120)) {
    throw plannerError(PLANNER_ERROR, 'runtimeRequirements.environment must be a bounded string');
  }
  if (requirements.minimumContextTokens !== undefined && (!Number.isSafeInteger(requirements.minimumContextTokens) || requirements.minimumContextTokens < 1)) {
    throw plannerError(PLANNER_ERROR, 'runtimeRequirements.minimumContextTokens must be a positive integer');
  }
  if (requirements.advancedRequired !== undefined && typeof requirements.advancedRequired !== 'boolean') {
    throw plannerError(PLANNER_ERROR, 'runtimeRequirements.advancedRequired must be boolean');
  }
  if (requirements.qualityFloor !== undefined && (typeof requirements.qualityFloor !== 'string' || requirements.qualityFloor.length > 500)) {
    throw plannerError(PLANNER_ERROR, 'runtimeRequirements.qualityFloor must be a bounded string');
  }
  const runtime = value.runtime === undefined ? {} : normalizeRuntimeSelection(value.runtime);
  const runtimePolicy = value.runtimePolicy === undefined
    ? null
    : object(value.runtimePolicy);
  return {
    stableKey,
    role,
    agentId,
    ...(Object.hasOwn(value, 'displayName') ? { displayName: displayMetadata(value.displayName, `nodes[${index}].displayName`, 160) } : {}),
    ...(Object.hasOwn(value, 'responsibility') ? { responsibility: displayMetadata(value.responsibility, `nodes[${index}].responsibility`, 1000) } : {}),
    ...(Object.hasOwn(value, 'domain') ? { domain: displayMetadata(value.domain, `nodes[${index}].domain`, 160) } : {}),
    ...(Object.hasOwn(value, 'iconKey') ? { iconKey: displayMetadata(value.iconKey, `nodes[${index}].iconKey`, 64) } : {}),
    capabilities: list(value.capabilities).map((entry) => entry.toLowerCase()),
    dependsOn: list(value.dependsOn),
    phaseId,
    parentKey,
    scope: clone(value.scope, {}),
    scopes: clone(value.scopes, {}),
    ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
    ...(Object.keys(requirements).length > 0 ? { runtimeRequirements: { tools: list(requirements.tools), environment: text(requirements.environment), ...(requirements.minimumContextTokens ? { minimumContextTokens: requirements.minimumContextTokens } : {}), ...(requirements.advancedRequired === true ? { advancedRequired: true } : {}), ...(text(requirements.qualityFloor) ? { qualityFloor: text(requirements.qualityFloor) } : {}) } } : {}),
    ...(runtimePolicy ? { runtimePolicy: clone(runtimePolicy, {}) } : {}),
    ...(Object.hasOwn(value, 'runtimeRationale') ? { runtimeRationale: displayMetadata(value.runtimeRationale, `nodes[${index}].runtimeRationale`, 2000) } : {}),
    acceptance,
    reviewRequired: value.reviewRequired === true,
    maxChildren: boundedInteger(value.maxChildren, null, { min: 0, max: 10000 }),
    maxConcurrent: boundedInteger(value.maxConcurrent, null, { min: 0, max: 10000 }),
  };
}

function normalizeAcceptance(value, label, { allowEmpty = false } = {}) {
  if (value === undefined) {
    if (allowEmpty) return [];
    throw plannerError(PLANNER_ACCEPTANCE_REQUIRED, `${label} is required`, { reason: 'missing_acceptance' });
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw plannerError(PLANNER_ACCEPTANCE_REQUIRED, `${label} must be a non-empty array`, { reason: 'invalid_acceptance' });
  }
  return value.map((entry, index) => {
    const item = assertPlainObject(entry, `${label}[${index}]`);
    const criterion = text(item.criterion || item.id || item.name);
    if (!criterion) throw plannerError(PLANNER_ACCEPTANCE_REQUIRED, `${label}[${index}] requires criterion`, { reason: 'missing_criterion' });
    return {
      criterion,
      evidenceRequired: item.evidenceRequired !== false,
      ...(text(item.description) ? { description: text(item.description) } : {}),
    };
  }).sort((a, b) => a.criterion.localeCompare(b.criterion));
}

function normalizePhase(raw, index) {
  const value = assertPlainObject(raw, `phases[${index}]`);
  assertNoUnknownKeys(value, new Set(['phaseId', 'objective', 'dependsOn', 'acceptance', 'reviewRequired', 'reviewerRoles']), `phases[${index}]`);
  const phaseId = text(value.phaseId);
  const objective = text(value.objective);
  if (!phaseId || !objective) throw plannerError(PLANNER_ERROR, `phases[${index}] requires phaseId and objective`, { reason: 'invalid_phase' });
  const acceptance = normalizeAcceptance(value.acceptance, `phases[${index}].acceptance`);
  const reviewerRoles = list(value.reviewerRoles).map((entry) => entry.toLowerCase());
  if (value.reviewRequired !== false && reviewerRoles.length === 0) {
    throw plannerError(PLANNER_REVIEW_REQUIRED, `phase ${phaseId} requires an independent reviewer`, { phaseId, reason: 'missing_reviewer' });
  }
  return {
    phaseId,
    objective,
    dependsOn: list(value.dependsOn),
    acceptance,
    reviewRequired: value.reviewRequired !== false,
    reviewerRoles,
  };
}

function normalizeReviewPolicy(value) {
  const policy = object(value);
  assertNoUnknownKeys(policy, new Set(['required', 'minReviewers', 'independent', 'allowedRoles']), 'reviewPolicy');
  const required = policy.required !== false;
  const minReviewers = boundedInteger(policy.minReviewers, required ? 1 : 0, { min: 0, max: 32 });
  if (required && minReviewers < 1) throw plannerError(PLANNER_REVIEW_REQUIRED, 'reviewPolicy requires at least one reviewer');
  return {
    required,
    minReviewers,
    independent: policy.independent !== false,
    allowedRoles: list(policy.allowedRoles).map((entry) => entry.toLowerCase()),
  };
}

function normalizeBudget(value) {
  const budget = object(value);
  const normalized = {};
  for (const key of [
    'maxNodes', 'maxDepth', 'maxChildren', 'maxConcurrent', 'maxTotalAgents',
    'maxTotalRuns', 'maxRetries', 'maxReplans', 'maxSessionReplacements',
    'maxTokens', 'maxCost', 'maxElapsedMs',
  ]) {
    if (budget[key] !== undefined) {
      const min = ['maxTokens', 'maxCost'].includes(key) ? 0 : 1;
      const number = Number(budget[key]);
      if (!Number.isFinite(number) || number < min) throw plannerError(PLANNER_BUDGET, `budget.${key} is invalid`, { reason: 'invalid_budget', field: key });
      normalized[key] = number;
    }
  }
  return normalized;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw plannerError(PLANNER_ERROR, `${label} contains duplicate ${value}`, { reason: 'duplicate_key', key: value });
    seen.add(value);
  }
}

function assertDag(items, key, dependencyKey, code, label) {
  const byId = new Map(items.map((item) => [item[key], item]));
  for (const item of items) {
    for (const dependency of item[dependencyKey]) {
      if (!byId.has(dependency)) throw plannerError(PLANNER_ERROR, `${label} ${item[key]} depends on missing ${dependency}`, { reason: 'missing_dependency', key: item[key], dependency });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(id, path = []) {
    if (visiting.has(id)) throw plannerError(code, `${label} dependency cycle detected`, { reason: 'cycle', cycle: [...path, id] });
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    for (const dependency of [...item[dependencyKey]].sort()) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const id of [...byId.keys()].sort()) visit(id);
  return order;
}

function assertManagementTree(nodes, explicitEdges) {
  const keys = new Set(nodes.map((node) => node.stableKey));
  const edges = explicitEdges.length > 0
    ? explicitEdges
    : nodes.filter((node) => node.parentKey).map((node) => ({ parentKey: node.parentKey, childKey: node.stableKey }));
  for (const edge of edges) {
    if (!keys.has(edge.parentKey) || !keys.has(edge.childKey)) throw plannerError(PLANNER_ERROR, 'MANAGES edge references an unknown node', { reason: 'unknown_edge_node', edge });
    if (edge.parentKey === edge.childKey) throw plannerError(PLANNER_CYCLE, 'MANAGES tree contains a self-cycle', { reason: 'cycle', edge });
  }
  const parentByChild = new Map();
  for (const edge of edges) {
    if (parentByChild.has(edge.childKey) && parentByChild.get(edge.childKey) !== edge.parentKey) {
      throw plannerError(PLANNER_ERROR, `node ${edge.childKey} has multiple MANAGES parents`, { reason: 'multiple_parents', node: edge.childKey });
    }
    parentByChild.set(edge.childKey, edge.parentKey);
  }
  const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
  for (const node of nodes) {
    const seen = new Set();
    let current = node.stableKey;
    while (parentByChild.has(current)) {
      if (seen.has(current)) throw plannerError(PLANNER_CYCLE, 'MANAGES tree contains a cycle', { reason: 'cycle', node: node.stableKey });
      seen.add(current);
      current = parentByChild.get(current);
    }
    if (!byKey.has(current)) throw plannerError(PLANNER_ERROR, 'MANAGES tree root is unknown', { reason: 'unknown_root' });
  }
  return [...edges].sort((a, b) => `${a.parentKey}:${a.childKey}`.localeCompare(`${b.parentKey}:${b.childKey}`));
}

function normalizeEdges(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw plannerError(PLANNER_ERROR, 'manages must be an array', { reason: 'invalid_edges' });
  return value.map((raw, index) => {
    const edge = assertPlainObject(raw, `manages[${index}]`);
    assertNoUnknownKeys(edge, new Set(['parentKey', 'childKey']), `manages[${index}]`);
    const parentKey = text(edge.parentKey);
    const childKey = text(edge.childKey);
    if (!parentKey || !childKey) throw plannerError(PLANNER_ERROR, `manages[${index}] requires parentKey and childKey`, { reason: 'invalid_edge' });
    return { parentKey, childKey };
  });
}

export function parseOrganizationProposal(input) {
  let source = input;
  if (typeof input === 'string') {
    try { source = JSON.parse(input); } catch (cause) { throw plannerError(PLANNER_ERROR, 'model output is not valid JSON', { reason: 'invalid_json', cause }); }
  }
  const proposal = assertPlainObject(source, 'proposal');
  assertNoUnknownKeys(proposal, PLAN_KEYS, 'proposal');
  if (proposal.schemaVersion !== undefined && proposal.schemaVersion !== ORGANIZATION_PROPOSAL_SCHEMA_VERSION) {
    throw plannerError(PLANNER_ERROR, `unsupported proposal schemaVersion ${proposal.schemaVersion}`, { reason: 'schema_version' });
  }
  const objective = text(proposal.objective);
  if (!objective) throw plannerError(PLANNER_ERROR, 'proposal.objective is required', { reason: 'missing_objective' });
  if (!Array.isArray(proposal.nodes) || proposal.nodes.length === 0) throw plannerError(PLANNER_ERROR, 'proposal.nodes must be non-empty', { reason: 'empty_nodes' });
  const nodes = proposal.nodes.map(normalizeNode);
  assertUnique(nodes.map((node) => node.stableKey), 'nodes');
  const phases = Array.isArray(proposal.phases) ? proposal.phases.map(normalizePhase) : [];
  if (phases.length === 0) throw plannerError(PLANNER_ERROR, 'proposal.phases must be non-empty', { reason: 'empty_phases' });
  assertUnique(phases.map((phase) => phase.phaseId), 'phases');
  const phaseOrder = assertDag(phases, 'phaseId', 'dependsOn', PLANNER_CYCLE, 'phase');
  const nodeKeys = new Set(nodes.map((node) => node.stableKey));
  const phaseKeys = new Set(phases.map((phase) => phase.phaseId));
  for (const node of nodes) {
    if (!phaseKeys.has(node.phaseId)) throw plannerError(PLANNER_ERROR, `node ${node.stableKey} references unknown phase`, { reason: 'unknown_phase', phaseId: node.phaseId });
    for (const dependency of node.dependsOn) if (!nodeKeys.has(dependency)) throw plannerError(PLANNER_ERROR, `node ${node.stableKey} depends on unknown node`, { reason: 'missing_dependency', dependency });
  }
  const nodeOrder = assertDag(nodes, 'stableKey', 'dependsOn', PLANNER_CYCLE, 'node');
  const manages = assertManagementTree(nodes, normalizeEdges(proposal.manages));
  const reviewPolicy = normalizeReviewPolicy(proposal.reviewPolicy);
  const acceptance = normalizeAcceptance(proposal.acceptance, 'acceptance');
  const budget = normalizeBudget(proposal.budget);
  const idempotencyKey = text(proposal.idempotencyKey || proposal.proposalId);
  if (!idempotencyKey) throw plannerError(PLANNER_ERROR, 'proposal.idempotencyKey is required', { reason: 'missing_idempotency_key' });
  if (nodes.filter((node) => node.role === 'reviewer').length < reviewPolicy.minReviewers) {
    throw plannerError(PLANNER_REVIEW_REQUIRED, 'proposal does not contain enough reviewer nodes', { reason: 'reviewer_count' });
  }
  return {
    schemaVersion: ORGANIZATION_PROPOSAL_SCHEMA_VERSION,
    proposalId: text(proposal.proposalId) || idempotencyKey,
    idempotencyKey,
    objective,
    nodes: nodes.sort((a, b) => a.stableKey.localeCompare(b.stableKey)),
    phases: phases.sort((a, b) => a.phaseId.localeCompare(b.phaseId)),
    manages,
    reviewPolicy,
    acceptance,
    budget,
    resolver: clone(proposal.resolver, {}),
    metadata: clone(proposal.metadata, {}),
    order: { phases: phaseOrder, nodes: nodeOrder },
  };
}

function compileBudget(proposal, budget = {}) {
  const limits = { ...budget, ...proposal.budget };
  if (limits.maxNodes !== undefined && proposal.nodes.length > limits.maxNodes) {
    throw plannerError(PLANNER_BUDGET, 'proposal exceeds maxNodes', { reason: 'max_nodes', actual: proposal.nodes.length, limit: limits.maxNodes });
  }
  if (limits.maxDepth !== undefined) {
    const depths = new Map();
    const parentByChild = new Map(proposal.manages.map((edge) => [edge.childKey, edge.parentKey]));
    function depth(key, path = []) {
      if (path.includes(key)) throw plannerError(PLANNER_CYCLE, 'MANAGES tree contains a cycle', { cycle: [...path, key] });
      if (!parentByChild.has(key)) return 0;
      if (!depths.has(key)) depths.set(key, depth(parentByChild.get(key), [...path, key]) + 1);
      return depths.get(key);
    }
    for (const node of proposal.nodes) {
      const value = depth(node.stableKey);
      if (value > limits.maxDepth) throw plannerError(PLANNER_BUDGET, 'proposal exceeds maxDepth', { reason: 'max_depth', node: node.stableKey, actual: value, limit: limits.maxDepth });
    }
  }
  return limits;
}

function requiredRuntimeCapabilities(proposal) {
  const required = new Set();
  const nodes = Array.isArray(proposal?.nodes) ? proposal.nodes : [];
  const manages = Array.isArray(proposal?.manages) ? proposal.manages : [];
  const governedBudgetKeys = new Set([
    'maxTotalAgents', 'maxTotalRuns', 'maxRetries', 'maxReplans',
    'maxSessionReplacements', 'maxTokens', 'maxCost', 'maxElapsedMs',
  ]);
  const hasBudgetGovernance = Object.keys(proposal?.budget || {}).some((key) => governedBudgetKeys.has(key));

  if (manages.length > 0) required.add('hierarchicalDelegation');
  if (nodes.some((node) => node.role === 'reviewer' || node.capabilities.includes('review'))
    || proposal?.reviewPolicy?.required !== false
    || (Array.isArray(proposal?.phases) && proposal.phases.some((phase) => phase.reviewRequired !== false))) {
    required.add('reviewerRuntime');
  }
  if (nodes.some((node) => node.role === 'writer' || node.capabilities.includes('write'))) required.add('managedWriter');
  if (nodes.some((node) => node.capabilities.includes('input'))) required.add('managedInput');
  if (hasBudgetGovernance) required.add('stallGovernor');
  return [...required].sort();
}

function assertRuntimeCapabilities(proposal) {
  const capabilities = getOrganizationRuntimeCapabilities({ publicOnly: true });
  for (const capability of requiredRuntimeCapabilities(proposal)) {
    if (capabilities[capability] === true) continue;
    throw plannerError(PLANNER_CAPABILITY_DISABLED, `proposal requires disabled runtime capability: ${capability}`, {
      reason: 'capability_disabled',
      capability,
    });
  }
}

export async function compileOrganizationProposal(input, options = {}) {
  const proposal = parseOrganizationProposal(input);
  assertRuntimeCapabilities(proposal);
  const budget = compileBudget(proposal, object(options.budget));
  if (!Array.isArray(options.profiles)) {
    throw plannerError(PLANNER_RESOLVER_REJECTED, 'organization compilation requires a Runtime Agent Catalog', {
      reason: 'agent_catalog_required',
    });
  }
  const profileByAgentId = new Map(options.profiles
    .map((profile) => [text(profile.agentId || profile.id), profile])
    .filter(([agentId]) => agentId));
  const nodeByKey = new Map(proposal.nodes.map((node) => [node.stableKey, node]));
  const parentByChild = new Map(proposal.manages.map((edge) => [edge.childKey, edge.parentKey]));
  const profileByNode = new Map();
  const grantByNode = new Map();
  const resolverResults = [];
  const compiling = new Set();
  async function compileNode(node) {
    if (profileByNode.has(node.stableKey)) return profileByNode.get(node.stableKey);
    if (compiling.has(node.stableKey)) {
      throw plannerError(PLANNER_CYCLE, `organization role graph contains a cycle at ${node.stableKey}`, { reason: 'management_cycle' });
    }
    compiling.add(node.stableKey);
    try {
      const profile = profileByAgentId.get(node.agentId);
      if (!profile) {
        throw plannerError(PLANNER_RESOLVER_REJECTED, `resolver found no catalog Agent for ${node.stableKey}`, {
          reason: 'agent_not_in_catalog', stableKey: node.stableKey, agentId: node.agentId,
        });
      }
      const parentKey = text(parentByChild.get(node.stableKey) || node.parentKey);
      const parent = parentKey ? nodeByKey.get(parentKey) : null;
      if (parent) await compileNode(parent);
      const parentProfile = parent ? profileByNode.get(parent.stableKey)?.profile : null;
      const parentGrant = parent ? (grantByNode.get(parent.stableKey) || {}) : {};
      const grant = deriveOrganizationGrant({
        role: node.role,
        capabilities: node.capabilities,
        profileCapabilities: profile.capabilities,
        parentGrant,
        scope: node.scope,
        scopes: node.scopes,
        maxChildren: node.maxChildren,
        maxConcurrent: node.maxConcurrent,
        runtimePolicy: node.runtimePolicy,
      });
      // Only server-supplied constraints may fill an omitted requested field.
      const decision = object(options.runtimeDecisionByNode?.[node.stableKey]);
      const constraints = normalizeUserRuntimeConstraints(decision.constraints);
      const requestedRuntime = applyRuntimeConstraints(node.runtime || {}, constraints);
      let runtime = null;
      if (Object.keys(requestedRuntime).length > 0) {
        runtime = await resolveDelegatedRuntimeSelection({
          request: { runtime: requestedRuntime },
          parentProfile,
          parentGrant,
          childProfile: profile,
          getModels: options.getModels,
          getTool: options.getTool,
          getProviders: options.getProviders,
        });
      }
      const requirements = node.runtimeRequirements || decision.requirements || {};
      const matchedCandidate = runtime && Array.isArray(decision.catalog) ? candidateForRuntime(decision.catalog, runtime) : null;
      const suppliedCandidates = Array.isArray(decision.candidates) ? decision.candidates : matchedCandidate ? [matchedCandidate] : null;
      if ((requirements.tools?.length || requirements.environment || requirements.minimumContextTokens) && (!runtime || !suppliedCandidates)) {
        throw plannerError(PLANNER_RESOLVER_REJECTED, 'runtime requirements need verified candidate evidence', { reason: 'runtime_evidence_unknown' });
      }
      let runtimeDecision = null;
      if (runtime) {
        let selectedEvidence = null;
        let selectedCost = null;
        if (suppliedCandidates) {
          const candidates = filterRuntimeCandidates(suppliedCandidates, { constraints, budget: decision.budget, requirements });
          const selected = candidates.find((candidate) => {
            const tuple = candidate.runtime || {};
            return ['tool', 'model', 'effort'].every((field) => tuple[field] === runtime[field])
              && (tuple.provider || tuple.providerProfile) === runtime.provider;
          });
          if (!selected) throw plannerError(PLANNER_RESOLVER_REJECTED, 'selected runtime is not an eligible candidate', { reason: 'runtime_candidate_ineligible' });
          selectedEvidence = selected.evidence;
          selectedCost = selected.cost;
        }
        runtimeDecision = createRuntimeSelectionRecord({ runtime, constraints, evidence: selectedEvidence, cost: selectedCost, rationale: node.runtimeRationale || decision.rationale });
      }
      const resolved = {
        selectedAgentId: profile.agentId,
        profile,
        effective: grant,
        proof: {
          capabilitySubset: true,
          organizationRole: true,
          parentGrantSubset: true,
        },
        runtime,
        runtimeDecision,
      };
      profileByNode.set(node.stableKey, resolved);
      grantByNode.set(node.stableKey, grant);
      resolverResults.push({ stableKey: node.stableKey, selectedAgentId: resolved.selectedAgentId, proof: resolved.proof, effective: grant, ...(resolved.runtime ? { runtime: resolved.runtime } : {}) });
      return resolved;
    } catch (cause) {
      throw plannerError(PLANNER_RESOLVER_REJECTED, `resolver rejected node ${node.stableKey}`, { reason: 'resolver_rejected', stableKey: node.stableKey, cause: { code: cause?.code || '', message: cause?.message || String(cause) } });
    } finally {
      compiling.delete(node.stableKey);
    }
  }
  for (const node of proposal.nodes) await compileNode(node);
  const compiled = {
    schemaVersion: ORGANIZATION_PROPOSAL_SCHEMA_VERSION,
    compilerVersion: 's21-v2',
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    objective: proposal.objective,
    nodes: proposal.nodes.map((node) => ({
      ...node,
      grant: grantByNode.get(node.stableKey),
      ...(profileByNode.get(node.stableKey)?.runtime ? { runtime: profileByNode.get(node.stableKey).runtime } : {}),
      ...(profileByNode.get(node.stableKey)?.runtimeDecision ? { runtimeDecision: profileByNode.get(node.stableKey).runtimeDecision } : {}),
      resolver: { selectedAgentId: profileByNode.get(node.stableKey)?.selectedAgentId || node.agentId, proof: profileByNode.get(node.stableKey)?.proof || null },
    })),
    phases: proposal.phases,
    manages: proposal.manages,
    reviewPolicy: proposal.reviewPolicy,
    acceptance: proposal.acceptance,
    budget,
    resolver: resolverResults,
    order: proposal.order,
  };
  const digest = stableDigest(compiled);
  return {
    proposal,
    compiled,
    digest,
    revision: { schemaVersion: 1, proposalId: proposal.proposalId, proposal: clone(proposal), compiled: clone(compiled), digest, state: 'draft' },
    sideEffects: { created: [], writes: 0, mode: options.shadow === false ? 'compile-only' : 'shadow' },
  };
}

export async function shadowOrganizationPlan(input, options = {}) {
  return compileOrganizationProposal(input, { ...options, shadow: true });
}

export function parsePlanAmendment(input) {
  const amendment = assertPlainObject(input, 'amendment');
  assertNoUnknownKeys(amendment, new Set(['schemaVersion', 'baseRevision', 'reason', 'operations', 'expectedEffects', 'requestedBudgetDelta', 'idempotencyKey']), 'amendment');
  const baseRevision = boundedInteger(amendment.baseRevision, null, { min: 1 });
  if (baseRevision === null) throw plannerError(PLANNER_AMENDMENT_INVALID, 'amendment.baseRevision is required', { reason: 'missing_base_revision' });
  const reason = text(amendment.reason);
  if (!reason) throw plannerError(PLANNER_AMENDMENT_INVALID, 'amendment.reason is required', { reason: 'missing_reason' });
  const idempotencyKey = text(amendment.idempotencyKey);
  if (!idempotencyKey) throw plannerError(PLANNER_AMENDMENT_INVALID, 'amendment.idempotencyKey is required', { reason: 'missing_idempotency_key' });
  if (!Array.isArray(amendment.operations) || amendment.operations.length === 0) throw plannerError(PLANNER_AMENDMENT_INVALID, 'amendment.operations must be non-empty', { reason: 'empty_operations' });
  const operations = amendment.operations.map((raw, index) => {
    const operation = assertPlainObject(raw, `operations[${index}]`);
    assertNoUnknownKeys(operation, new Set(['operation', 'stableKey', 'replacementKey', 'reason', 'contract']), `operations[${index}]`);
    const kind = text(operation.operation).toLowerCase();
    if (!PLAN_OPERATIONS.has(kind)) throw plannerError(PLANNER_AMENDMENT_INVALID, `unknown amendment operation ${kind}`, { reason: 'unknown_operation', kind });
    const stableKey = text(operation.stableKey);
    if (!stableKey) throw plannerError(PLANNER_AMENDMENT_INVALID, `operations[${index}].stableKey is required`, { reason: 'missing_stable_key' });
    return { operation: kind, stableKey, ...(text(operation.replacementKey) ? { replacementKey: text(operation.replacementKey) } : {}), ...(text(operation.reason) ? { reason: text(operation.reason) } : {}), contract: clone(operation.contract, null) };
  });
  assertUnique(operations.map((operation) => operation.stableKey), 'amendment.operations');
  return {
    schemaVersion: ORGANIZATION_PROPOSAL_SCHEMA_VERSION,
    baseRevision,
    reason,
    operations,
    expectedEffects: clone(amendment.expectedEffects, {}),
    requestedBudgetDelta: normalizeBudget(amendment.requestedBudgetDelta),
    idempotencyKey,
  };
}

export function proposalDigest(proposal) {
  return stableDigest(parseOrganizationProposal(proposal));
}
