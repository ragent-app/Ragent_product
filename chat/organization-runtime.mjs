// Organization Runtime command layer + Revision Compiler (S9).
//
// Builds on the S8 organization store (chat/organization-store.mjs). This
// module owns the command surface an Organization goes through: it can be
// created, revised (proposal -> compile -> draft revision -> freeze), and read
// back. The Revision Compiler (constitution §2.17) validates a proposal into a
// compiled constitution: acyclic dependency graph, bounded by budget, stable
// content digest, and per-node effective-grant projection. A failed compile
// never produces a freezable Revision.
//
// All six commands are gated on ORG_SCHEMA_ENABLED: when the flag is off they
// answer with the stable unavailable error instead of touching the schema.
import { createHash } from 'crypto';
import { ORG_SCHEMA_ENABLED } from '../lib/config.mjs';
import { canonicalJson } from './execution-scope.mjs';
import {
  createOrganization as storeCreateOrganization,
  createRevisionAtHead,
  getOrganization,
  getRevision,
  freezeRevision as storeFreezeRevision,
  listRevisions,
} from './organization-store.mjs';
import {
  assertDelegationAllowed,
  proveNoCapabilityEscalation,
  resolveAgentCandidates,
} from './agent-resolver.mjs';
import { normalizeCapabilityProfile } from './agent-capability-registry.mjs';

// Stable roles and capabilities for organization nodes (additive whitelist).
// Roles mirror the collaboration policy roles plus the writer role used by the
// managed-writer slice; capabilities cover the operational verbs the
// constitution grants (read/write/manage/review/aggregate/input/run). A
// proposal or an organization budget may override either set.
export const ORGANIZATION_ROLES = new Set(['manager', 'specialist', 'reviewer', 'writer']);
export const ORGANIZATION_CAPABILITIES = new Set([
  'read', 'write', 'manage', 'review', 'aggregate', 'input', 'run',
]);

// Default compiler budget. Every limit is a positive integer; proposal.budget
// and the explicit org budget override them, with the explicit budget winning.
export const DEFAULT_ORG_BUDGET = Object.freeze({
  maxNodes: 64,
  maxDepth: 16,
  maxCapabilitiesPerRole: 32,
});

function runtimeError(message, code, statusCode, cause = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (cause !== null && cause !== undefined) error.cause = cause;
  return error;
}

function statusForCode(code) {
  switch (code) {
    case 'ORGANIZATION_NOT_FOUND': return 404;
    case 'ORGANIZATION_ROOT_SESSION_CONFLICT':
    case 'ORGANIZATION_ROOT_IMMUTABLE':
    case 'REVISION_CONFLICT':
    case 'REVISION_FROZEN':
      return 409;
    case 'REVISION_COMPILE_FAILED':
    case 'REVISION_CYCLE_DETECTED':
    case 'REVISION_BUDGET_EXCEEDED':
      return 422;
    case 'ORGANIZATION_SCHEMA_DISABLED':
      return 503;
    default:
      return 400;
  }
}

// Re-throw a store error with its stable HTTP status attached when the store
// (which is transport-agnostic) did not set one.
async function runStore(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && typeof error === 'object' && error.code && !error.statusCode) {
      error.statusCode = statusForCode(error.code);
    }
    throw error;
  }
}

function assertCommandEnabled() {
  if (!ORG_SCHEMA_ENABLED) {
    throw runtimeError(
      'organization schema is disabled; set RAGENT_ORG_SCHEMA_ENABLED=1 to enable organization commands',
      'ORGANIZATION_SCHEMA_DISABLED',
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Revision Compiler (constitution §2.17)
// ---------------------------------------------------------------------------

function compileError(code, message, cause) {
  return runtimeError(message, code, 422, cause);
}

function resolveBudget(budget, proposalBudget) {
  const merged = { ...DEFAULT_ORG_BUDGET };
  for (const source of [proposalBudget, budget]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of Object.keys(merged)) {
      const value = source[key];
      if (Number.isInteger(value) && value > 0) merged[key] = value;
    }
  }
  return merged;
}

function allowedSet(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const values = list.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
  return values.length > 0 ? new Set(values) : fallback;
}

// Deep-sanitize a JSON-ish value for a stable digest: drops undefined object
// keys, normalizes key order through canonicalJson at hash time, and never
// lets a malformed entry crash the compiler.
function sanitizeJson(value, fallback) {
  if (value === undefined) return fallback;
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// compileRevision(proposal, budget) -> { compiled, digest }
//
// proposal shape (the task-card contract):
//   { nodes: [{ stableKey, role, capabilities[], dependsOn[], scope?, scopes? }],
//     phaseContracts?: [{ phaseId?, ... }],
//     budget?: { maxNodes?, maxDepth?, maxCapabilitiesPerRole?, allowedRoles?, allowedCapabilities? } }
// budget is the organization budget (org.budget_json); proposal.budget and the
// explicit budget both override the defaults, explicit wins. Validation runs
// before any output is produced; failures carry a cause with the reason detail.
export function compileRevision(proposal = {}, budget = null) {
  const nodes = Array.isArray(proposal.nodes) ? proposal.nodes : [];
  if (nodes.length === 0) {
    throw compileError('REVISION_COMPILE_FAILED', 'proposal requires at least one node', { reason: 'empty_nodes', detail: 'nodes must be a non-empty array' });
  }

  const proposalBudget = proposal && typeof proposal === 'object' && !Array.isArray(proposal) && proposal.budget && typeof proposal.budget === 'object' && !Array.isArray(proposal.budget)
    ? proposal.budget
    : null;
  const resolvedBudget = resolveBudget(budget, proposalBudget);
  const { maxNodes, maxDepth, maxCapabilitiesPerRole } = resolvedBudget;
  const allowedRoles = allowedSet(budget?.allowedRoles || proposalBudget?.allowedRoles, ORGANIZATION_ROLES);
  const allowedCapabilities = allowedSet(budget?.allowedCapabilities || proposalBudget?.allowedCapabilities, ORGANIZATION_CAPABILITIES);

  if (nodes.length > maxNodes) {
    throw compileError('REVISION_BUDGET_EXCEEDED', `proposal has ${nodes.length} nodes, exceeding maxNodes ${maxNodes}`, {
      reason: 'max_nodes', limit: maxNodes, actual: nodes.length,
    });
  }

  const normalized = [];
  const byKey = new Map();
  for (let index = 0; index < nodes.length; index++) {
    const raw = nodes[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw compileError('REVISION_COMPILE_FAILED', `node at index ${index} is not an object`, { reason: 'invalid_node', detail: `index ${index}` });
    }
    const stableKey = typeof raw.stableKey === 'string' ? raw.stableKey.trim() : '';
    if (!stableKey) {
      throw compileError('REVISION_COMPILE_FAILED', `node at index ${index} has no stableKey`, { reason: 'missing_stable_key', detail: `index ${index}` });
    }
    if (byKey.has(stableKey)) {
      throw compileError('REVISION_COMPILE_FAILED', `duplicate stableKey "${stableKey}"`, { reason: 'duplicate_stable_key', stableKey });
    }
    const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
    if (!allowedRoles.has(role)) {
      throw compileError('REVISION_COMPILE_FAILED', `unknown role "${String(raw.role)}" for node ${stableKey}`, { reason: 'invalid_role', stableKey, role });
    }
    let capabilities = Array.isArray(raw.capabilities)
      ? [...new Set(raw.capabilities.map((capability) => (typeof capability === 'string' ? capability.trim().toLowerCase() : '')).filter(Boolean))]
      : [];
    for (const capability of capabilities) {
      if (!allowedCapabilities.has(capability)) {
        throw compileError('REVISION_COMPILE_FAILED', `unknown capability "${capability}" for node ${stableKey}`, { reason: 'invalid_capability', stableKey, capability });
      }
    }
    if (capabilities.length > maxCapabilitiesPerRole) {
      throw compileError('REVISION_BUDGET_EXCEEDED', `node ${stableKey} declares ${capabilities.length} capabilities, exceeding maxCapabilitiesPerRole ${maxCapabilitiesPerRole}`, {
        reason: 'max_capabilities_per_role', stableKey, limit: maxCapabilitiesPerRole, actual: capabilities.length,
      });
    }
    const dependsOn = Array.isArray(raw.dependsOn)
      ? [...new Set(raw.dependsOn.map((dependency) => (typeof dependency === 'string' ? dependency.trim() : '')).filter(Boolean))]
      : [];
    const scope = raw.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? sanitizeJson(raw.scope, {}) : {};
    const scopes = raw.scopes && typeof raw.scopes === 'object' && !Array.isArray(raw.scopes) ? sanitizeJson(raw.scopes, {}) : {};
    const node = { stableKey, role, capabilities, dependsOn, scope, scopes };
    byKey.set(stableKey, node);
    normalized.push(node);
  }

  for (const node of normalized) {
    for (const dependency of node.dependsOn) {
      if (!byKey.has(dependency)) {
        throw compileError('REVISION_COMPILE_FAILED', `node ${node.stableKey} depends on missing node ${dependency}`, {
          reason: 'missing_dependency', stableKey: node.stableKey, dependency,
        });
      }
    }
  }

  // Cycle detection + deterministic topological order + per-node depth. Visit
  // in sorted stableKey order so the compiled dependencyOrder is independent of
  // the input array order (keeps the digest a canonical function of the graph).
  const visiting = new Set();
  const visited = new Set();
  const dependencyOrder = [];
  const depthByKey = new Map();
  const visit = (key, path) => {
    if (visiting.has(key)) {
      throw compileError('REVISION_CYCLE_DETECTED', `dependency cycle detected at ${key}`, {
        reason: 'cycle', cycle: [...path, key].join(' -> '),
      });
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const node = byKey.get(key);
    let depth = 1;
    for (const dependency of node.dependsOn) {
      visit(dependency, [...path, key]);
      depth = Math.max(depth, Number(depthByKey.get(dependency) || 0) + 1);
    }
    visiting.delete(key);
    visited.add(key);
    depthByKey.set(key, depth);
    dependencyOrder.push(key);
  };
  for (const key of [...byKey.keys()].sort()) visit(key, []);

  const maxComputedDepth = Math.max(...depthByKey.values());
  if (maxComputedDepth > maxDepth) {
    throw compileError('REVISION_BUDGET_EXCEEDED', `dependency depth ${maxComputedDepth} exceeds maxDepth ${maxDepth}`, {
      reason: 'max_depth', limit: maxDepth, actual: maxComputedDepth,
    });
  }

  const compiledNodes = normalized.map((node) => {
    const effectiveGrants = {};
    for (const capability of node.capabilities) {
      const capScope = node.scopes[capability] && typeof node.scopes[capability] === 'object' && !Array.isArray(node.scopes[capability])
        ? sanitizeJson(node.scopes[capability], {})
        : node.scope;
      effectiveGrants[capability] = { allow: true, scope: capScope };
    }
    return {
      stableKey: node.stableKey,
      role: node.role,
      capabilities: [...node.capabilities].sort(),
      dependsOn: [...node.dependsOn].sort(),
      effectiveGrants,
    };
  });
  // Stable node table ordering for the digest.
  compiledNodes.sort((left, right) => (left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0));

  let phaseContracts = [];
  if (proposal.phaseContracts !== undefined && proposal.phaseContracts !== null) {
    if (!Array.isArray(proposal.phaseContracts)) {
      throw compileError('REVISION_COMPILE_FAILED', 'phaseContracts must be an array', { reason: 'invalid_phase_contracts' });
    }
    phaseContracts = proposal.phaseContracts.map((contract, index) => {
      if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        throw compileError('REVISION_COMPILE_FAILED', `phase contract at index ${index} is not an object`, { reason: 'invalid_phase_contract', detail: `index ${index}` });
      }
      const phaseId = typeof contract.phaseId === 'string' && contract.phaseId.trim()
        ? contract.phaseId.trim()
        : `phase-${index + 1}`;
      return { ...sanitizeJson(contract, {}), phaseId };
    });
  }

  const compiled = {
    schemaVersion: 1,
    nodes: compiledNodes,
    dependencyOrder,
    phaseContracts,
    budget: {
      maxNodes,
      maxDepth,
      maxCapabilitiesPerRole,
      allowedRoles: [...allowedRoles].sort(),
      allowedCapabilities: [...allowedCapabilities].sort(),
    },
    stats: { nodeCount: normalized.length, maxDepth: maxComputedDepth },
  };

  const digest = `sha256:${createHash('sha256').update(canonicalJson(compiled), 'utf8').digest('hex')}`;
  return { compiled, digest };
}

// S16 additive compiler entry. S9 compileRevision remains unchanged and keeps
// its original proposal shape; this helper only adds the role/capability proof
// required before a later command can create organization facts.
export async function compileDelegationPlan({
  request = {},
  parentProfile,
  parentGrant = {},
  profiles = [],
  depth = 0,
  childCount = 0,
  concurrentCount = 0,
  getAgent,
  getTool,
  getModels,
  getProviders,
} = {}) {
  const parent = normalizeCapabilityProfile(parentProfile);
  assertDelegationAllowed(parent, { childCount, concurrentCount, depth });
  const candidates = await resolveAgentCandidates(request, {
    profiles,
    parentProfile: parent,
    parentGrant,
    depth,
    getAgent,
    getTool,
    getModels,
    getProviders,
  });
  if (candidates.length === 0) {
    const error = new Error('no Agent candidate satisfies the delegation request');
    error.code = 'ORG_AGENT_NOT_ALLOWED';
    error.statusCode = 422;
    throw error;
  }
  const selected = candidates[0];
  const proof = proveNoCapabilityEscalation({
    parentProfile: parent,
    parentGrant,
    request,
    childProfile: selected.profile,
    depth,
  });
  return {
    schemaVersion: 1,
    request: JSON.parse(JSON.stringify(request || {})),
    selectedAgentId: selected.profile.agentId,
    profile: selected.profile,
    effective: proof.effective,
    proof: proof.proof,
    runtime: selected.runtime || null,
    candidates: candidates.map((candidate) => ({
      agentId: candidate.profile.agentId,
      score: candidate.score,
    })),
  };
}

// ---------------------------------------------------------------------------
// Organization commands (gated on ORG_SCHEMA_ENABLED)
// ---------------------------------------------------------------------------

export async function createOrganization({ projectId, rootSessionId, policy, budget, idempotencyKey } = {}) {
  assertCommandEnabled();
  return runStore(() => storeCreateOrganization({ projectId, rootSessionId, policy, budget, idempotencyKey }));
}

// S21 v2 command adapter. Compilation remains side-effect free; callers can
// use the returned plan for a shadow decision before appending a revision.
export async function compileOrganizationProposal(proposal, options = {}) {
  assertCommandEnabled();
  const planner = await import('./organization-planner.mjs');
  return planner.compileOrganizationProposal(proposal, options);
}

// Persist a previously compiled S21 v2 plan. Keeping the compiled plan as an
// explicit input lets the Root Leader ingress validate before it creates the
// Organization row, so rejected model output leaves no partial organization.
export async function reviseOrganizationProposal({
  organizationId,
  proposal,
  compiledPlan = null,
  idempotencyKey = '',
  expectedCurrentRevision = null,
  profiles,
  budget,
  getAgent,
  getTool,
} = {}) {
  assertCommandEnabled();
  const org = await runStore(() => getOrganization(organizationId));
  if (!org) throw runtimeError(`organization ${organizationId} not found`, 'ORGANIZATION_NOT_FOUND', 404);
  const planned = compiledPlan || await compileOrganizationProposal(proposal, {
    ...(Array.isArray(profiles) && profiles.length > 0 ? { profiles } : {}),
    ...(budget && typeof budget === 'object' ? { budget } : {}),
    ...(typeof getAgent === 'function' ? { getAgent } : {}),
    ...(typeof getTool === 'function' ? { getTool } : {}),
  });
  if (!planned?.compiled || !planned?.proposal || !planned?.digest) {
    throw runtimeError('compiled organization proposal is incomplete', 'REVISION_COMPILE_FAILED', 422);
  }
  return runStore(() => createRevisionAtHead(organizationId, {
    expectedCurrentRevision,
    proposal: planned.proposal,
    compiled: planned.compiled,
    digest: planned.digest,
    idempotencyKey: idempotencyKey || planned.proposal.idempotencyKey,
  }));
}

// reviseOrganization compiles the proposal against the current organization
// head and appends the next revision (CAS: the head must still match
// expectedCurrentRevision, otherwise a concurrent revise already advanced it).
// A replay with the same idempotencyKey returns the original revision.
export async function reviseOrganization({ organizationId, proposal, idempotencyKey = '', expectedCurrentRevision = null } = {}) {
  assertCommandEnabled();
  const org = await runStore(() => getOrganization(organizationId));
  if (!org) throw runtimeError(`organization ${organizationId} not found`, 'ORGANIZATION_NOT_FOUND', 404);
  const { compiled, digest } = compileRevision(proposal, org.budget);
  return runStore(() => createRevisionAtHead(organizationId, {
    expectedCurrentRevision,
    proposal,
    compiled,
    digest,
    idempotencyKey,
  }));
}

export async function freezeRevision(organizationId, revision) {
  assertCommandEnabled();
  return runStore(() => storeFreezeRevision(organizationId, revision));
}

export async function getOrganizationRevision(organizationId, revision) {
  assertCommandEnabled();
  return runStore(() => getRevision(organizationId, revision));
}

// getCompiledRevision returns the compiled constitution of a revision. Without
// an explicit revision it resolves the organization's current head.
export async function getCompiledRevision(organizationId, revision = null) {
  assertCommandEnabled();
  if (revision === null || revision === undefined) {
    const org = await runStore(() => getOrganization(organizationId));
    if (!org || !org.currentRevision) return null;
    revision = org.currentRevision;
  }
  const row = await runStore(() => getRevision(organizationId, revision));
  return row ? row.compiled : null;
}

export async function listOrganizationRevisions(organizationId) {
  assertCommandEnabled();
  return runStore(() => listRevisions(organizationId));
}
