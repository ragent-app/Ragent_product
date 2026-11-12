/**
 * Phase 2A deterministic permission language and policy evaluator.
 *
 * This module has no I/O and never executes a command. It consumes a
 * server-produced SemanticOperation plus resolver facts, applies the
 * immutable security ceiling, and optionally matches an exact constraint-set
 * capability. Durable signature verification, nonce consumption, and the
 * executor remain separate gates.
 */

import { randomBytes } from 'node:crypto';

import {
  ACTION_TAXONOMY,
  aggregateDecisions,
  computeSemanticManifestHash,
  decisionFromStrictness,
  isKnownAction,
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  isRefusal,
  operationActionStrictness,
  validateSemanticOperation,
} from './semantic-operation.mjs';

export const PERMISSION_FACTS_VERSION = 'permission-facts/v3';
export const CAPABILITY_GRANT_VERSION = 'capability-grant/v3';
export const PERMISSION_POLICY_VERSION = 'permission-policy/v3';

export const PERMISSION_MODES = Object.freeze({
  STANDARD: 'STANDARD',
  FULL_AUTONOMY: 'FULL_AUTONOMY',
});

export const CAPABILITY_WORKLOAD_SCOPES = Object.freeze({
  ONE_OPERATION: 'ONE_OPERATION',
  RUN: 'RUN',
  SESSION: 'SESSION',
});

// RUN/SESSION grants intentionally survive turns for autonomous work. The
// issuing turn remains provenance; making that choice explicit prevents a
// caller from accidentally treating an omitted turn binding as authorization.
export const CAPABILITY_TURN_BINDINGS = Object.freeze({
  PROVENANCE: 'provenance',
});

export const CAPABILITY_AUTHORIZATION_CLASSES = Object.freeze({
  OWNER: 'owner',
  STRONG_OWNER: 'strong-owner',
  POLICY_AUTO: 'policy-auto',
});

export const PERMISSION_REASON_CODES = Object.freeze({
  ALLOW_DEFAULT: 'permission_allow_default',
  ASK_DEFAULT: 'permission_ask_default',
  DENY_DEFAULT: 'permission_deny_default',
  MODE_INVALID: 'permission_mode_invalid',
  OPERATION_INVALID: 'permission_operation_invalid',
  FACTS_REQUIRED: 'permission_facts_required',
  FACTS_NOT_SERVER_COMPUTED: 'permission_facts_not_server_computed',
  FACTS_PROOF_REQUIRED: 'permission_facts_proof_required',
  FACTS_PROOF_INVALID: 'permission_facts_proof_invalid',
  FACTS_MANIFEST_MISMATCH: 'permission_facts_manifest_mismatch',
  FACTS_VERSION_MISMATCH: 'permission_facts_version_mismatch',
  UNKNOWN_TARGET_IDENTITY: 'permission_unknown_target_identity',
  DYNAMIC_TARGET_IDENTITY: 'permission_dynamic_target_identity',
  UNMODELED_TARGET_KIND: 'permission_unmodeled_target_kind',
  UNSUPPORTED_TARGET_PLATFORM: 'permission_unsupported_target_platform',
  UNKNOWN_HOST_EFFECT: 'permission_unknown_host_effect',
  DYNAMIC_HOST_EFFECT: 'permission_dynamic_host_effect',
  NON_REVALIDATABLE_HOST_EFFECT: 'permission_non_revalidatable_host_effect',
  SECURITY_CEILING: 'permission_security_ceiling',
  META_PERMISSION: 'permission_meta_permission',
  CAPABILITY_INVALID: 'permission_capability_invalid',
  CAPABILITY_PROOF_REQUIRED: 'permission_capability_proof_required',
  CAPABILITY_PROOF_INVALID: 'permission_capability_proof_invalid',
  CAPABILITY_TTL_EXCEEDED: 'permission_capability_ttl_exceeded',
  CAPABILITY_USAGE_LIMIT_EXCEEDED: 'permission_capability_usage_limit_exceeded',
  PERMISSION_SET_EMPTY: 'permission_set_empty',
  CAPABILITY_EXPIRED: 'permission_capability_expired',
  CAPABILITY_VERSION_MISMATCH: 'permission_capability_version_mismatch',
  CAPABILITY_MODE_MISMATCH: 'permission_capability_mode_mismatch',
  CAPABILITY_CONSTRAINT_MISMATCH: 'permission_capability_constraint_mismatch',
  CAPABILITY_WORKLOAD_MISMATCH: 'permission_capability_workload_mismatch',
  CAPABILITY_STRONG_AUTH_REQUIRED: 'permission_capability_strong_auth_required',
  CAPABILITY_USAGE_EXHAUSTED: 'permission_capability_usage_exhausted',
  CAPABILITY_USE_NONCE_REQUIRED: 'permission_use_nonce_required',
  CAPABILITY_USE_NONCE_REPLAY: 'permission_use_nonce_replay',
  CAPABILITY_MATCHED: 'permission_capability_matched',
  RISK_CONTEXT_REVIEW_REQUIRED: 'permission_risk_context_review_required',
  POLICY_GATE_REQUIRED: 'permission_policy_gate_required',
  SELF_PROTECTION_BOUNDARY: 'permission_self_protection_boundary',
  SELF_PROTECTION_UNAVAILABLE: 'permission_self_protection_unavailable',
});

const C = PERMISSION_REASON_CODES;

export const PERMISSION_REASON_MESSAGES = Object.freeze({
  [C.ALLOW_DEFAULT]: 'operation is allowed by the deterministic default policy',
  [C.ASK_DEFAULT]: 'operation requires owner approval or an exact capability',
  [C.DENY_DEFAULT]: 'operation is denied by the deterministic default policy',
  [C.MODE_INVALID]: 'permission mode is invalid',
  [C.OPERATION_INVALID]: 'semantic operation is invalid',
  [C.FACTS_REQUIRED]: 'server-computed permission facts are required',
  [C.FACTS_NOT_SERVER_COMPUTED]: 'permission facts are not server-computed',
  [C.FACTS_PROOF_REQUIRED]: 'trusted resolver proof is required',
  [C.FACTS_PROOF_INVALID]: 'trusted resolver proof is invalid',
  [C.FACTS_MANIFEST_MISMATCH]: 'permission facts do not match the operation manifest',
  [C.FACTS_VERSION_MISMATCH]: 'permission facts use an incompatible resolver version',
  [C.UNKNOWN_TARGET_IDENTITY]: 'target identity is unknown and cannot be authorized',
  [C.DYNAMIC_TARGET_IDENTITY]: 'target identity is dynamic and cannot be authorized',
  [C.UNMODELED_TARGET_KIND]: 'target kind is not modeled by the permission language',
  [C.UNSUPPORTED_TARGET_PLATFORM]: 'target platform is not supported by the permission resolver',
  [C.UNKNOWN_HOST_EFFECT]: 'unknown host effect fails closed',
  [C.DYNAMIC_HOST_EFFECT]: 'dynamic host effect cannot be authorized',
  [C.NON_REVALIDATABLE_HOST_EFFECT]: 'host effect cannot be revalidated at execution time',
  [C.SECURITY_CEILING]: 'operation is above the immutable security ceiling',
  [C.META_PERMISSION]: 'meta-permission is permanently denied',
  [C.CAPABILITY_INVALID]: 'capability grant is invalid',
  [C.CAPABILITY_PROOF_REQUIRED]: 'trusted capability signature proof is required',
  [C.CAPABILITY_PROOF_INVALID]: 'trusted capability signature proof is invalid',
  [C.CAPABILITY_TTL_EXCEEDED]: 'capability grant exceeds the active mode TTL limit',
  [C.CAPABILITY_USAGE_LIMIT_EXCEEDED]: 'capability grant exceeds the active mode usage limit',
  [C.PERMISSION_SET_EMPTY]: 'an empty permission set is not authorizing',
  [C.CAPABILITY_EXPIRED]: 'capability grant has expired',
  [C.CAPABILITY_VERSION_MISMATCH]: 'capability grant versions do not match',
  [C.CAPABILITY_MODE_MISMATCH]: 'capability grant mode does not match the active mode',
  [C.CAPABILITY_CONSTRAINT_MISMATCH]: 'operation exceeds the capability constraint set',
  [C.CAPABILITY_WORKLOAD_MISMATCH]: 'operation is outside the capability workload binding',
  [C.CAPABILITY_STRONG_AUTH_REQUIRED]: 'operation requires a dedicated strong authorization',
  [C.CAPABILITY_USAGE_EXHAUSTED]: 'capability usage budget is exhausted',
  [C.CAPABILITY_USE_NONCE_REQUIRED]: 'a fresh per-use nonce is required',
  [C.CAPABILITY_USE_NONCE_REPLAY]: 'capability per-use nonce was already consumed',
  [C.CAPABILITY_MATCHED]: 'operation matches the exact capability constraint set',
  [C.RISK_CONTEXT_REVIEW_REQUIRED]: 'server-computed risk context requires owner review',
  [C.POLICY_GATE_REQUIRED]: 'a Phase 2A permission policy gate is required for host-capable execution',
  [C.SELF_PROTECTION_BOUNDARY]: 'write-like operation targets the Ragent service self-protection boundary',
  [C.SELF_PROTECTION_UNAVAILABLE]: 'self-protection facts are unavailable for a write-like operation',
});

// These actions cannot be lowered by mode or capability in this phase. This
// set is a code constant, not user/LLM configurable policy data.
export const IMMUTABLE_DENY_ACTIONS = Object.freeze([
  'unknown.host_effect',
  'credential.read',
  'credential.write',
  'credential.use',
  'remote_code.execute',
  'permission.policy.modify',
  'capability.forge',
  'approval.bypass',
  'audit.tamper',
  'executor.bypass',
  'signing.key.read',
]);

export const STRONG_AUTH_ACTIONS = Object.freeze([
  'privilege.elevate',
  'security.firewall.disable',
  'security.antivirus.exclusion.add',
  'security.antivirus.disable',
  'security.audit.config.modify',
  'security.audit.disable',
]);

export const STRONG_DEFAULT_DENY_ACTIONS = Object.freeze([
  'security.firewall.disable',
  'security.antivirus.disable',
  'security.audit.disable',
]);

export const CAPABILITY_GRANT_TTL_MAX_MS = 24 * 60 * 60 * 1000;
export const CAPABILITY_USAGE_MAX = 10_000;

// Product modes remain a two-option UI, but their grant envelope is explicit
// and deterministic. Full autonomy may reduce interruptions only by allowing
// a longer, still exact grant; it never lowers the semantic security ceiling.
export const PERMISSION_MODE_POLICIES = Object.freeze({
  [PERMISSION_MODES.STANDARD]: Object.freeze({
    maxGrantTtlMs: 15 * 60 * 1000,
    maxUsage: 1,
    strongActionWithoutGrant: 'DENY',
  }),
  [PERMISSION_MODES.FULL_AUTONOMY]: Object.freeze({
    maxGrantTtlMs: CAPABILITY_GRANT_TTL_MAX_MS,
    maxUsage: CAPABILITY_USAGE_MAX,
    strongActionWithoutGrant: 'ASK',
  }),
});

// This is the closed target-identity vocabulary for the Phase 2A policy
// language. Some kinds are reserved for policy fixtures or future resolver
// adapters; they still require a trusted resolver proof before authorization.
// Adding a new kind requires parser/resolver facts and corpus coverage before
// it can participate in authorization.
export const PERMISSION_SUPPORTED_PLATFORMS = Object.freeze(['linux', 'win32']);
export const PERMISSION_KNOWN_TARGET_KINDS = Object.freeze([
  'filesystem_file',
  'filesystem_tree',
  'filesystem_root',
  'filesystem_symlink',
  'filesystem_glob',
  'filesystem_batch',
  'credential_dir',
  'package',
  'package_artifact',
  'package_source',
  'systemd_unit',
  'systemd_manager',
  'systemd_unit_file',
  'git_remote',
  'git_remote_config',
  'process',
  'firewall_rule',
  'windows_acl',
  'windows_service',
  'product_agent_definition',
  'remote_url',
  'script_file',
  'interpreter',
  'interpreter_code',
  'variable',
  'unknown',
  'unresolvable',
]);
export const PERMISSION_UNKNOWN_TARGET_KINDS = Object.freeze([
  'unknown',
  'unresolvable',
]);
export const PERMISSION_DYNAMIC_TARGET_KINDS = Object.freeze([
  'variable',
  'script_file',
  'interpreter',
  'interpreter_code',
  'remote_url',
  'filesystem_glob',
  'filesystem_batch',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonEmpty(value) {
  return trim(value) !== '';
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(value) {
  return Array.isArray(value) ? [...new Set(value.map(trim).filter(Boolean))] : [];
}

function errorResult(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function validMode(mode) {
  return mode === PERMISSION_MODES.STANDARD || mode === PERMISSION_MODES.FULL_AUTONOMY;
}

function validWorkloadScope(scope) {
  return Object.values(CAPABILITY_WORKLOAD_SCOPES).includes(scope);
}

export function validatePermissionTargetIdentity(target) {
  if (!isPlainObject(target) || !nonEmpty(target.kind) || !nonEmpty(target.platform)) {
    return errorResult(C.UNKNOWN_TARGET_IDENTITY, PERMISSION_REASON_MESSAGES[C.UNKNOWN_TARGET_IDENTITY]);
  }
  if (!PERMISSION_SUPPORTED_PLATFORMS.includes(target.platform)) {
    return errorResult(C.UNSUPPORTED_TARGET_PLATFORM, PERMISSION_REASON_MESSAGES[C.UNSUPPORTED_TARGET_PLATFORM]);
  }
  if (!PERMISSION_KNOWN_TARGET_KINDS.includes(target.kind)) {
    return errorResult(C.UNMODELED_TARGET_KIND, PERMISSION_REASON_MESSAGES[C.UNMODELED_TARGET_KIND]);
  }
  if (PERMISSION_UNKNOWN_TARGET_KINDS.includes(target.kind)) {
    return errorResult(C.UNKNOWN_TARGET_IDENTITY, PERMISSION_REASON_MESSAGES[C.UNKNOWN_TARGET_IDENTITY]);
  }
  if (PERMISSION_DYNAMIC_TARGET_KINDS.includes(target.kind)) {
    return errorResult(C.DYNAMIC_TARGET_IDENTITY, PERMISSION_REASON_MESSAGES[C.DYNAMIC_TARGET_IDENTITY]);
  }
  return { ok: true, code: '' };
}

function safeValue(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (value === '*' || value === '**') return [`${path} wildcard is not allowed`];
    return [];
  }
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path} must be finite`];
  if (Array.isArray(value)) return value.flatMap((item, index) => safeValue(item, `${path}[${index}]`));
  if (!isPlainObject(value)) return [`${path} must be JSON data`];
  return Object.entries(value).flatMap(([key, item]) => (
    key.startsWith('__')
      ? [`${path}.${key} is not allowed`]
      : safeValue(item, `${path}.${key}`)
  ));
}

/**
 * Authorization constraints are closed canonical values. Object key order and
 * array order are not security dimensions, but every key and every array item
 * must be present on both sides. In particular, a smaller actual array is not
 * treated as a harmless subset because profiles, ports, effects, and other
 * action-specific arrays can change the meaning of an operation.
 */
export function valueSatisfiesConstraint(actual, granted) {
  if (Array.isArray(actual) || Array.isArray(granted)) {
    if (!Array.isArray(actual) || !Array.isArray(granted)) return false;
    if (actual.length !== granted.length) return false;
    const used = new Set();
    return actual.every((item) => {
      const index = granted.findIndex((candidate, candidateIndex) => (
        !used.has(candidateIndex) && valueSatisfiesConstraint(item, candidate)
      ));
      if (index < 0) return false;
      used.add(index);
      return true;
    });
  }
  if (isPlainObject(actual) || isPlainObject(granted)) {
    if (!isPlainObject(actual) || !isPlainObject(granted)) return false;
    if (Object.keys(granted).length === 0) return Object.keys(actual).length === 0;
    // Phase 2A uses closed canonical objects for authorization dimensions:
    // every actual field must be explicitly pinned by the grant. This avoids
    // treating an unmodeled resolver field as harmless extra information.
    if (Object.keys(actual).some((key) => !Object.prototype.hasOwnProperty.call(granted, key))) return false;
    return Object.keys(granted).every((key) => (
      Object.prototype.hasOwnProperty.call(actual, key)
      && valueSatisfiesConstraint(actual[key], granted[key])
    ));
  }
  return actual === granted;
}

function operationActions(operation) {
  return [operation?.primaryAction, ...(Array.isArray(operation?.effects) ? operation.effects : [])]
    .filter(nonEmpty);
}

function operationWorkload(operation) {
  return {
    sessionId: trim(operation?.requestBinding?.sessionId),
    runId: trim(operation?.requestBinding?.runId),
    turnId: trim(operation?.requestBinding?.turnId),
    operationId: trim(operation?.operationId),
  };
}

function currentView(operation, facts) {
  return {
    action: trim(operation?.primaryAction),
    resource: clone(facts?.resource),
    selection: clone(facts?.selection),
    effects: uniqueStrings(operation?.effects).sort(),
  };
}

/** Canonical security-sensitive target flags come from resolver facts only. */
export function computePermissionTargetFlags(facts = {}) {
  const sources = [facts?.resource, facts?.selection].filter(isPlainObject);
  return {
    recursive: sources.some((value) => value.recursive === true),
    force: sources.some((value) => value.force === true || value.forced === true),
    exact: sources.some((value) => value.exact === true),
  };
}

function computeOperationTargetFlags(operation = {}) {
  const target = isPlainObject(operation.target) ? operation.target : {};
  return {
    recursive: target.recursive === true,
    force: target.force === true || target.forced === true,
    exact: target.exact === true,
  };
}

function validatePermissionFactsShape(operation, facts) {
  if (!isPlainObject(facts)) return errorResult(C.FACTS_REQUIRED, PERMISSION_REASON_MESSAGES[C.FACTS_REQUIRED]);
  const targetIdentity = validatePermissionTargetIdentity(operation?.target);
  if (!targetIdentity.ok) return targetIdentity;
  if (facts.schemaVersion !== PERMISSION_FACTS_VERSION) {
    return errorResult(C.FACTS_VERSION_MISMATCH, PERMISSION_REASON_MESSAGES[C.FACTS_VERSION_MISMATCH]);
  }
  if (facts.serverComputed !== true) {
    return errorResult(C.FACTS_NOT_SERVER_COMPUTED, PERMISSION_REASON_MESSAGES[C.FACTS_NOT_SERVER_COMPUTED]);
  }
  if (facts.source !== 'server-resolver') {
    return errorResult(C.FACTS_NOT_SERVER_COMPUTED, PERMISSION_REASON_MESSAGES[C.FACTS_NOT_SERVER_COMPUTED]);
  }
  for (const field of ['reversible', 'containsSensitiveMaterial', 'containsGitMetadata']) {
    if (typeof operation.impact?.[field] !== 'boolean') {
      return errorResult(C.FACTS_REQUIRED, `operation impact.${field} is required before resolver facts can authorize`);
    }
  }
  if (facts.operationManifestHash !== computeSemanticManifestHash(operation)) {
    return errorResult(C.FACTS_MANIFEST_MISMATCH, PERMISSION_REASON_MESSAGES[C.FACTS_MANIFEST_MISMATCH]);
  }
  if (facts.resolverVersion !== SEMANTIC_RESOLVER_VERSION) {
    return errorResult(C.FACTS_VERSION_MISMATCH, PERMISSION_REASON_MESSAGES[C.FACTS_VERSION_MISMATCH]);
  }
  if (!isPlainObject(facts.scope) || facts.scope.computed !== true
    || JSON.stringify(facts.scope) !== JSON.stringify(operation.scope)) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts scope is not the server-computed operation scope');
  }
  if (!isPlainObject(facts.selfProtection)
    || typeof facts.selfProtection.computed !== 'boolean'
    || typeof facts.selfProtection.matched !== 'boolean'
    || typeof facts.selfProtection.workspaceRecommended !== 'boolean'
    || !['none', 'agentoc-service'].includes(facts.selfProtection.boundary)) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts selfProtection must be server-computed');
  }
  // A resolver-bound operation may carry the self-protection projection in
  // scope. The facts envelope must repeat it exactly; a caller cannot turn a
  // protected target into an ordinary one by supplying a different fact.
  if (isPlainObject(operation?.scope?.selfProtection)
    && JSON.stringify(facts.selfProtection) !== JSON.stringify(operation.scope.selfProtection)) {
    return errorResult(C.FACTS_MANIFEST_MISMATCH, 'permission facts selfProtection does not match the operation scope');
  }
  if (!isPlainObject(operation?.scope?.selfProtection) && facts.selfProtection.matched === true) {
    return errorResult(C.FACTS_MANIFEST_MISMATCH, 'self-protection match is not present in the operation scope');
  }
  if (!isPlainObject(facts.resource) || Object.keys(facts.resource).length === 0
    || !isPlainObject(facts.selection) || Object.keys(facts.selection).length === 0) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts resource and selection must be non-empty objects');
  }
  if (!nonEmpty(facts.executionClass)) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts executionClass is required');
  }
  if (facts.executionClass !== operation.executionClass) {
    return errorResult(C.FACTS_MANIFEST_MISMATCH, 'permission facts executionClass does not match the operation manifest');
  }
  if (!isPlainObject(facts.impact)) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts impact is required');
  }
  for (const field of ['reversible', 'containsSensitiveMaterial', 'containsGitMetadata']) {
    if (typeof facts.impact[field] !== 'boolean') {
      return errorResult(C.FACTS_REQUIRED, `permission facts impact.${field} must be a boolean`);
    }
    if (facts.impact[field] !== (operation.impact?.[field] === true)) {
      return errorResult(C.FACTS_MANIFEST_MISMATCH, `permission facts impact.${field} does not match the operation manifest`);
    }
  }
  if (operation.analysis?.effectsComplete !== true || facts.effectsComplete !== true) {
    return errorResult(C.FACTS_REQUIRED, 'complete effect enumeration proof is required before authorization');
  }
  if (!nonEmpty(facts.effectEnumerationProof)) {
    return errorResult(C.FACTS_REQUIRED, 'effect enumeration proof is required before authorization');
  }
  const operationTargetFlags = computeOperationTargetFlags(operation);
  const factsTargetFlags = computePermissionTargetFlags(facts);
  for (const field of ['recursive', 'force', 'exact']) {
    if (operationTargetFlags[field] !== factsTargetFlags[field]) {
      return errorResult(C.FACTS_MANIFEST_MISMATCH, `permission facts target flag ${field} differs from the operation manifest`);
    }
  }
  const hostEffects = facts.hostEffects;
  if (!isPlainObject(hostEffects)) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts hostEffects are required');
  }
  if (typeof hostEffects.dynamic !== 'boolean' || typeof hostEffects.revalidatable !== 'boolean') {
    return errorResult(C.FACTS_REQUIRED, 'permission facts hostEffects flags must be booleans');
  }
  if (Object.keys(hostEffects).some((key) => !['dynamic', 'revalidatable'].includes(key))) {
    return errorResult(C.FACTS_REQUIRED, 'permission facts hostEffects contains an unmodeled field');
  }
  if (hostEffects.dynamic === true) {
    return errorResult(C.DYNAMIC_HOST_EFFECT, PERMISSION_REASON_MESSAGES[C.DYNAMIC_HOST_EFFECT]);
  }
  if (hostEffects.revalidatable !== true) {
    return errorResult(C.NON_REVALIDATABLE_HOST_EFFECT, PERMISSION_REASON_MESSAGES[C.NON_REVALIDATABLE_HOST_EFFECT]);
  }
  if (!Array.isArray(facts.unknowns) || facts.unknowns.length > 0) {
    return errorResult(C.UNKNOWN_HOST_EFFECT, PERMISSION_REASON_MESSAGES[C.UNKNOWN_HOST_EFFECT]);
  }
  if (!nonEmpty(facts.resourceSnapshotIdentity)) {
    return errorResult(C.FACTS_REQUIRED, 'resourceSnapshotIdentity is required');
  }
  if (facts.factsManifestHash !== computePermissionFactsManifestHash(facts)) {
    return errorResult(C.FACTS_MANIFEST_MISMATCH, PERMISSION_REASON_MESSAGES[C.FACTS_MANIFEST_MISMATCH]);
  }
  const valueErrors = [
    ...safeValue(facts.resource, 'facts.resource'),
    ...safeValue(facts.selection, 'facts.selection'),
    ...safeValue(facts.impact, 'facts.impact'),
  ];
  return valueErrors.length > 0
    ? errorResult(C.FACTS_REQUIRED, valueErrors.join('; '))
    : { ok: true, code: '' };
}

export function validatePermissionFacts(operation, facts) {
  const operationValidation = validateSemanticOperation(operation);
  if (!operationValidation.ok) {
    return errorResult(C.OPERATION_INVALID, operationValidation.errors.join('; '), { errors: operationValidation.errors });
  }
  return validatePermissionFactsShape(operation, facts);
}

/** Hash all resolver facts that influence authorization, excluding the proof. */
export function computePermissionFactsManifestHash(facts = {}) {
  return computeSemanticManifestHash({
    schemaVersion: facts.schemaVersion,
    serverComputed: facts.serverComputed,
    source: facts.source,
    operationManifestHash: facts.operationManifestHash,
    resolverVersion: facts.resolverVersion,
    scope: facts.scope,
    selfProtection: facts.selfProtection,
    executionClass: facts.executionClass,
    impact: facts.impact,
    effectsComplete: facts.effectsComplete,
    effectEnumerationProof: facts.effectEnumerationProof,
    resource: facts.resource,
    selection: facts.selection,
    resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
    hostEffects: facts.hostEffects,
    unknowns: facts.unknowns,
  });
}

/**
 * Verify the provenance supplied by the trusted resolver/signature boundary.
 * The policy module deliberately has no default verifier: a caller-provided
 * `serverComputed: true` flag is data, not authority.
 */
export function verifyPermissionFactsProof(operation, facts, verifyFactsProof) {
  if (typeof verifyFactsProof !== 'function') {
    return errorResult(C.FACTS_PROOF_REQUIRED, PERMISSION_REASON_MESSAGES[C.FACTS_PROOF_REQUIRED]);
  }
  try {
    return verifyFactsProof(operation, facts) === true
      ? { ok: true, code: '' }
      : errorResult(C.FACTS_PROOF_INVALID, PERMISSION_REASON_MESSAGES[C.FACTS_PROOF_INVALID]);
  } catch {
    return errorResult(C.FACTS_PROOF_INVALID, PERMISSION_REASON_MESSAGES[C.FACTS_PROOF_INVALID]);
  }
}

/** Build a server-side facts envelope after resolver work has completed. */
export function buildPermissionFacts({
  operation,
  resource,
  selection,
  resourceSnapshotIdentity,
  executionClass,
  impact,
  effectEnumerationProof = null,
  hostEffects = { dynamic: false, revalidatable: true },
  unknowns = [],
  selfProtection = null,
  attestation = null,
} = {}) {
  const computedSelfProtection = isPlainObject(selfProtection)
    ? clone(selfProtection)
    : (isPlainObject(operation?.scope?.selfProtection)
      ? clone(operation.scope.selfProtection)
      : { computed: false, matched: false, workspaceRecommended: false, boundary: 'none' });
  const facts = {
    schemaVersion: PERMISSION_FACTS_VERSION,
    serverComputed: true,
    source: 'server-resolver',
    operationManifestHash: computeSemanticManifestHash(operation),
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    scope: clone(operation?.scope),
    selfProtection: computedSelfProtection,
    executionClass: trim(executionClass),
    impact: clone(impact),
    effectsComplete: operation?.analysis?.effectsComplete === true,
    effectEnumerationProof: clone(effectEnumerationProof),
    resource: clone(resource),
    selection: clone(selection),
    resourceSnapshotIdentity: trim(resourceSnapshotIdentity),
    hostEffects: clone(hostEffects),
    unknowns: [...unknowns],
    attestation: clone(attestation),
  };
  facts.factsManifestHash = computePermissionFactsManifestHash(facts);
  const validation = validatePermissionFacts(operation, facts);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.code = validation.code;
    throw error;
  }
  return facts;
}

function validateCapabilityConstraints(constraints = {}) {
  const errors = [];
  if (!isPlainObject(constraints)) return ['constraints must be an object'];
  const constraintFields = [
    'action',
    'scope',
    'resourceSnapshotIdentity',
    'executionClass',
    'impact',
    'target',
    'targetFlags',
    'resource',
    'selection',
    'effects',
  ];
  for (const key of Object.keys(constraints)) {
    if (!constraintFields.includes(key)) errors.push(`constraints.${key} is not a modeled authorization dimension`);
  }
  for (const key of constraintFields) {
    if (!Object.prototype.hasOwnProperty.call(constraints, key)) errors.push(`constraints.${key} is required`);
  }
  if (!isKnownAction(constraints.action)) errors.push('constraints.action must be a known action');
  if (!nonEmpty(constraints.resourceSnapshotIdentity)) errors.push('constraints.resourceSnapshotIdentity is required');
  if (!nonEmpty(constraints.executionClass)) errors.push('constraints.executionClass is required');
  if (!isPlainObject(constraints.impact)) errors.push('constraints.impact must be an object');
  else {
    const impactFields = ['reversible', 'containsSensitiveMaterial', 'containsGitMetadata'];
    for (const field of impactFields) {
      if (typeof constraints.impact[field] !== 'boolean') errors.push(`constraints.impact.${field} must be a boolean`);
    }
    for (const key of Object.keys(constraints.impact)) {
      if (!impactFields.includes(key)) errors.push(`constraints.impact.${key} is not modeled`);
    }
  }
  if (!isPlainObject(constraints.targetFlags)) errors.push('constraints.targetFlags must be an object');
  else {
    const targetFlagFields = ['recursive', 'force', 'exact'];
    for (const field of targetFlagFields) {
      if (typeof constraints.targetFlags[field] !== 'boolean') errors.push(`constraints.targetFlags.${field} must be a boolean`);
    }
    for (const key of Object.keys(constraints.targetFlags)) {
      if (!targetFlagFields.includes(key)) errors.push(`constraints.targetFlags.${key} is not modeled`);
    }
  }
  if (!isPlainObject(constraints.target) || Object.keys(constraints.target).length === 0) {
    errors.push('constraints.target must be a non-empty object');
  } else {
    if (!nonEmpty(constraints.target.kind)) errors.push('constraints.target.kind is required');
    if (!nonEmpty(constraints.target.platform)) errors.push('constraints.target.platform is required');
    const targetIdentity = validatePermissionTargetIdentity(constraints.target);
    if (!targetIdentity.ok) errors.push(targetIdentity.code);
    errors.push(...safeValue(constraints.target, 'constraints.target'));
  }
  if (!isPlainObject(constraints.scope) || Object.keys(constraints.scope).length === 0) {
    errors.push('constraints.scope must be a non-empty object');
  } else {
    if (!nonEmpty(constraints.scope.kind)) errors.push('constraints.scope.kind is required');
    if (constraints.scope.computed !== true) errors.push('constraints.scope.computed must be true');
    errors.push(...safeValue(constraints.scope, 'constraints.scope'));
  }
  for (const [label, value] of [['resource', constraints.resource], ['selection', constraints.selection]]) {
    if (!isPlainObject(value) || Object.keys(value).length === 0) errors.push(`constraints.${label} must be a non-empty object`);
    else errors.push(...safeValue(value, `constraints.${label}`));
  }
  if (!isPlainObject(constraints.effects) || !Array.isArray(constraints.effects.subset)) {
    errors.push('constraints.effects.subset must be an array');
  } else {
    if (Object.keys(constraints.effects).some((key) => key !== 'subset')) {
      errors.push('constraints.effects contains an unmodeled field');
    }
    if (new Set(constraints.effects.subset).size !== constraints.effects.subset.length) {
      errors.push('constraints.effects.subset must not contain duplicates');
    }
    for (const effect of constraints.effects.subset) {
      if (!isKnownAction(effect)) errors.push(`constraints.effects.subset contains unknown action ${effect}`);
    }
  }
  return errors;
}

export function validateCapabilityGrant(grant, { now = Date.now() } = {}) {
  if (!isPlainObject(grant)) return errorResult(C.CAPABILITY_INVALID, 'capability grant must be an object');
  if (grant.schemaVersion !== CAPABILITY_GRANT_VERSION
    || grant.policyVersion !== PERMISSION_POLICY_VERSION
    || grant.operationVersion !== SEMANTIC_OPERATION_VERSION
    || grant.compilerVersion !== SEMANTIC_COMPILER_VERSION
    || grant.resolverVersion !== SEMANTIC_RESOLVER_VERSION) {
    return errorResult(C.CAPABILITY_VERSION_MISMATCH, PERMISSION_REASON_MESSAGES[C.CAPABILITY_VERSION_MISMATCH]);
  }
  for (const field of ['grantId', 'nonce', 'issuedAtTurn']) {
    if (!nonEmpty(grant[field])) return errorResult(C.CAPABILITY_INVALID, `${field} is required`);
  }
  if (!validMode(grant.mode)) return errorResult(C.CAPABILITY_INVALID, 'grant.mode is invalid');
  if (!validWorkloadScope(grant.workload?.scope)) return errorResult(C.CAPABILITY_INVALID, 'grant.workload.scope is invalid');
  if (grant.workload?.turnBinding !== CAPABILITY_TURN_BINDINGS.PROVENANCE) {
    return errorResult(C.CAPABILITY_INVALID, 'grant.workload.turnBinding must explicitly be provenance');
  }
  if (!nonEmpty(grant.workload?.sessionId)) return errorResult(C.CAPABILITY_INVALID, 'grant.workload.sessionId is required');
  if (grant.workload?.runId !== undefined && !nonEmpty(grant.workload.runId)) {
    return errorResult(C.CAPABILITY_INVALID, 'grant.workload.runId must be non-empty when provided');
  }
  if (grant.workload?.turnId !== undefined && !nonEmpty(grant.workload.turnId)) {
    return errorResult(C.CAPABILITY_INVALID, 'grant.workload.turnId must be non-empty when provided');
  }
  if (grant.workload.scope === CAPABILITY_WORKLOAD_SCOPES.RUN && !nonEmpty(grant.workload.runId)) {
    return errorResult(C.CAPABILITY_INVALID, 'RUN grant requires workload.runId');
  }
  if (grant.workload.scope === CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION && !nonEmpty(grant.workload.operationId)) {
    return errorResult(C.CAPABILITY_INVALID, 'ONE_OPERATION grant requires workload.operationId');
  }
  const issuedAt = Date.parse(trim(grant.issuedAt));
  const expiresAt = Date.parse(trim(grant.expiresAt));
  const current = Number(now);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || !Number.isFinite(current)
    || expiresAt <= issuedAt || expiresAt - issuedAt > CAPABILITY_GRANT_TTL_MAX_MS) {
    return errorResult(C.CAPABILITY_INVALID, 'grant TTL is invalid');
  }
  const modePolicy = PERMISSION_MODE_POLICIES[grant.mode];
  if (expiresAt - issuedAt > modePolicy.maxGrantTtlMs) {
    return errorResult(C.CAPABILITY_TTL_EXCEEDED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_TTL_EXCEEDED]);
  }
  if (issuedAt > current) return errorResult(C.CAPABILITY_INVALID, 'grant cannot be issued in the future');
  if (now >= expiresAt) return errorResult(C.CAPABILITY_EXPIRED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_EXPIRED]);
  const max = grant.usageBudget?.max;
  if (!Number.isInteger(max) || max < 1 || max > CAPABILITY_USAGE_MAX) {
    return errorResult(C.CAPABILITY_INVALID, 'usageBudget.max is invalid');
  }
  if (max > modePolicy.maxUsage) {
    return errorResult(C.CAPABILITY_USAGE_LIMIT_EXCEEDED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_USAGE_LIMIT_EXCEEDED]);
  }
  const authClass = grant.authorizationClass || CAPABILITY_AUTHORIZATION_CLASSES.OWNER;
  if (!Object.values(CAPABILITY_AUTHORIZATION_CLASSES).includes(authClass)) {
    return errorResult(C.CAPABILITY_INVALID, 'authorizationClass is invalid');
  }
  if (authClass === CAPABILITY_AUTHORIZATION_CLASSES.POLICY_AUTO
      && (grant.workload.scope !== CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION
        || !nonEmpty(grant.workload.runId) || !nonEmpty(grant.workload.turnId)
        || max !== 1 || expiresAt - issuedAt > 60_000)) {
    return errorResult(C.CAPABILITY_INVALID, 'policy-auto grants must bind one run operation and expire within one minute');
  }
  const constraintErrors = validateCapabilityConstraints(grant.constraints);
  if (constraintErrors.length > 0) return errorResult(C.CAPABILITY_INVALID, constraintErrors.join('; '), { errors: constraintErrors });
  if (grant.constraintManifestHash !== computeCapabilityConstraintHash(grant)) {
    return errorResult(C.CAPABILITY_INVALID, 'constraintManifestHash does not match the grant constraint set');
  }
  return { ok: true, code: '' };
}

export function computeCapabilityConstraintHash(grant = {}) {
  return computeSemanticManifestHash({
    schemaVersion: grant.schemaVersion,
    grantId: grant.grantId,
    nonce: grant.nonce,
    issuedAtTurn: grant.issuedAtTurn,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    usageBudget: grant.usageBudget,
    grantProof: grant.grantProof,
    authorizationClass: grant.authorizationClass,
    constraints: grant.constraints,
    mode: grant.mode,
    policyVersion: grant.policyVersion,
    operationVersion: grant.operationVersion,
    compilerVersion: grant.compilerVersion,
    resolverVersion: grant.resolverVersion,
    workload: grant.workload,
  });
}

export function verifyCapabilityGrantProof(grant, verifyGrantProof) {
  if (!grant?.grantProof || typeof verifyGrantProof !== 'function') {
    return errorResult(C.CAPABILITY_PROOF_REQUIRED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_PROOF_REQUIRED]);
  }
  try {
    return verifyGrantProof(grant) === true
      ? { ok: true, code: '' }
      : errorResult(C.CAPABILITY_PROOF_INVALID, PERMISSION_REASON_MESSAGES[C.CAPABILITY_PROOF_INVALID]);
  } catch {
    return errorResult(C.CAPABILITY_PROOF_INVALID, PERMISSION_REASON_MESSAGES[C.CAPABILITY_PROOF_INVALID]);
  }
}

export function createCapabilityGrant({
  constraints,
  mode = PERMISSION_MODES.FULL_AUTONOMY,
  workload,
  issuedAtTurn,
  issuedAt = new Date(),
  ttlMs = 60 * 60 * 1000,
  usageMax = 1,
  authorizationClass = CAPABILITY_AUTHORIZATION_CLASSES.OWNER,
  grantProof = '',
  grantId = `cgrant_${randomBytes(12).toString('hex')}`,
  nonce = randomBytes(24).toString('base64url'),
} = {}) {
  const boundedTtl = Number.isInteger(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, CAPABILITY_GRANT_TTL_MAX_MS) : 0;
  const issued = new Date(issuedAt);
  if (!Number.isFinite(issued.getTime()) || boundedTtl <= 0) throw new Error('invalid capability grant time');
  const grant = {
    schemaVersion: CAPABILITY_GRANT_VERSION,
    grantId: trim(grantId),
    nonce: trim(nonce),
    mode,
    policyVersion: PERMISSION_POLICY_VERSION,
    operationVersion: SEMANTIC_OPERATION_VERSION,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    issuedAtTurn: trim(issuedAtTurn),
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + boundedTtl).toISOString(),
    authorizationClass,
    grantProof: clone(grantProof),
    workload: clone(workload),
    usageBudget: { max: usageMax },
    constraints: clone(constraints),
  };
  grant.constraintManifestHash = computeCapabilityConstraintHash(grant);
  const validation = validateCapabilityGrant(grant, { now: issued.getTime() });
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.code = validation.code;
    throw error;
  }
  return grant;
}

function capabilityWorkloadMatches(grant, operation) {
  const expected = grant.workload;
  const actual = operationWorkload(operation);
  if (expected.sessionId !== actual.sessionId) return false;
  if (nonEmpty(expected.runId) && expected.runId !== actual.runId) return false;
  if (nonEmpty(expected.turnId) && expected.turnId !== actual.turnId) return false;
  if (expected.scope === CAPABILITY_WORKLOAD_SCOPES.RUN && expected.runId !== actual.runId) return false;
  if (expected.scope === CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION && expected.operationId !== actual.operationId) return false;
  return true;
}

export function capabilityMatchesOperation(grant, operation, facts, {
  now = Date.now(),
  mode = null,
  verifyFactsProof = null,
  verifyGrantProof = null,
  useNonce = '',
  usageConsumed = 0,
  consumedUseNonces = [],
} = {}) {
  if (!validMode(mode)) {
    return errorResult(C.CAPABILITY_MODE_MISMATCH, PERMISSION_REASON_MESSAGES[C.CAPABILITY_MODE_MISMATCH]);
  }
  const operationValidation = validateSemanticOperation(operation);
  if (!operationValidation.ok) {
    return errorResult(C.OPERATION_INVALID, operationValidation.errors.join('; '), { errors: operationValidation.errors });
  }
  const factsValidation = validatePermissionFacts(operation, facts);
  const ceiling = ceilingFor(operation, factsValidation, facts);
  if (ceiling.decision === 'DENY') {
    return errorResult(ceiling.code, PERMISSION_REASON_MESSAGES[ceiling.code] || ceiling.code, { ceiling: 'DENY' });
  }
  const grantValidation = validateCapabilityGrant(grant, { now });
  if (!grantValidation.ok) return grantValidation;
  if (grant.mode !== mode) {
    return errorResult(C.CAPABILITY_MODE_MISMATCH, PERMISSION_REASON_MESSAGES[C.CAPABILITY_MODE_MISMATCH]);
  }
  if (!factsValidation.ok) return factsValidation;
  const factsProof = verifyPermissionFactsProof(operation, facts, verifyFactsProof);
  if (!factsProof.ok) return factsProof;
  const grantProof = verifyCapabilityGrantProof(grant, verifyGrantProof);
  if (!grantProof.ok) return grantProof;
  if (!nonEmpty(useNonce)) return errorResult(C.CAPABILITY_USE_NONCE_REQUIRED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_USE_NONCE_REQUIRED]);
  if (new Set(consumedUseNonces).has(useNonce)) return errorResult(C.CAPABILITY_USE_NONCE_REPLAY, PERMISSION_REASON_MESSAGES[C.CAPABILITY_USE_NONCE_REPLAY]);
  if (!Number.isInteger(usageConsumed) || usageConsumed < 0 || usageConsumed >= grant.usageBudget.max) {
    return errorResult(C.CAPABILITY_USAGE_EXHAUSTED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_USAGE_EXHAUSTED]);
  }
  if (!capabilityWorkloadMatches(grant, operation)) {
    return errorResult(C.CAPABILITY_WORKLOAD_MISMATCH, PERMISSION_REASON_MESSAGES[C.CAPABILITY_WORKLOAD_MISMATCH]);
  }
  if (grant.authorizationClass === CAPABILITY_AUTHORIZATION_CLASSES.POLICY_AUTO) {
    const target = operation.target || {};
    const packages = Array.isArray(target.packages) ? target.packages : [];
    if (operation.primaryAction !== 'package.install' || operation.executionClass !== 'host'
        || target.platform !== 'win32' || target.kind !== 'package' || target.manager !== 'winget'
        || target.source !== 'winget' || target.exact !== true || target.resourceSnapshot?.sourceTrust !== 'configured'
        || packages.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packages[0])
        || JSON.stringify(uniqueStrings(operation.effects).sort()) !== JSON.stringify(['process.execute'])) {
      return errorResult(C.CAPABILITY_CONSTRAINT_MISMATCH, 'policy-auto is limited to one verified Windows package installation');
    }
  }
  if (grant.constraints.action !== operation.primaryAction
    || grant.constraints.executionClass !== facts.executionClass
    || grant.constraints.resourceSnapshotIdentity !== facts.resourceSnapshotIdentity
    || !valueSatisfiesConstraint(facts.scope, grant.constraints.scope)
    || !valueSatisfiesConstraint({
      reversible: facts.impact?.reversible === true,
      containsSensitiveMaterial: facts.impact?.containsSensitiveMaterial === true,
      containsGitMetadata: facts.impact?.containsGitMetadata === true,
    }, grant.constraints.impact)
    || !valueSatisfiesConstraint(operation.target, grant.constraints.target)
    || !valueSatisfiesConstraint(computePermissionTargetFlags(facts), grant.constraints.targetFlags)
    || !valueSatisfiesConstraint(facts.resource, grant.constraints.resource)
    || !valueSatisfiesConstraint(facts.selection, grant.constraints.selection)
    || !valueSatisfiesConstraint(
      uniqueStrings(operation.effects).sort(),
      uniqueStrings(grant.constraints.effects.subset).sort(),
    )) {
    return errorResult(C.CAPABILITY_CONSTRAINT_MISMATCH, PERMISSION_REASON_MESSAGES[C.CAPABILITY_CONSTRAINT_MISMATCH]);
  }
  if (operationActions(operation).some((action) => STRONG_AUTH_ACTIONS.includes(action))
    && grant.authorizationClass !== CAPABILITY_AUTHORIZATION_CLASSES.STRONG_OWNER) {
    return errorResult(C.CAPABILITY_STRONG_AUTH_REQUIRED, PERMISSION_REASON_MESSAGES[C.CAPABILITY_STRONG_AUTH_REQUIRED]);
  }
  return {
    ok: true,
    code: C.CAPABILITY_MATCHED,
    nextUsage: { consumed: usageConsumed + 1, useNonce },
  };
}

/**
 * Explicit execution-time revalidation entry point. The executor must call
 * this after a fresh resolver pass and before constructing argv/env/cwd.
 */
export function revalidateCapabilityGrant(grant, operation, facts, options = {}) {
  return capabilityMatchesOperation(grant, operation, facts, options);
}

/** Pure state transition for a durable executor CAS/transaction wrapper. */
export function consumeCapabilityUse(grant, usageState, useNonce) {
  const consumed = Number.isInteger(usageState?.consumed) ? usageState.consumed : 0;
  const nonces = Array.isArray(usageState?.useNonces) ? usageState.useNonces : [];
  const result = capabilityMatchesOperation(
    grant,
    usageState?.operation,
    usageState?.facts,
    {
      now: usageState?.now ?? Date.now(), mode: usageState?.mode, useNonce, usageConsumed: consumed, consumedUseNonces: nonces,
      verifyFactsProof: usageState?.verifyFactsProof, verifyGrantProof: usageState?.verifyGrantProof,
    },
  );
  if (!result.ok) return result;
  return { ok: true, code: result.code, state: { consumed: consumed + 1, useNonces: [...nonces, useNonce] } };
}

function ceilingFor(operation, factsValidation, facts) {
  if (!factsValidation.ok) return { decision: 'DENY', code: factsValidation.code };
  const actions = operationActions(operation);
  if (Array.isArray(operation?.analysis?.unknowns) && operation.analysis.unknowns.length > 0) {
    return { decision: 'DENY', code: C.UNKNOWN_HOST_EFFECT };
  }
  if (actions.some((action) => action === 'unknown.host_effect')) {
    return { decision: 'DENY', code: C.UNKNOWN_HOST_EFFECT };
  }
  if (actions.some((action) => IMMUTABLE_DENY_ACTIONS.includes(action))) {
    return { decision: 'DENY', code: C.META_PERMISSION };
  }
  if (isRefusal(operation)) return { decision: 'DENY', code: C.SECURITY_CEILING };
  const writeLike = operationActions(operation).some((action) => (
    action === 'fs.write'
    || action === 'fs.delete'
    || action === 'service.modify'
    || action === 'package.remove'
    || action === 'package.source.modify'
  ));
  if (writeLike && facts?.selfProtection?.computed !== true) {
    return { decision: 'DENY', code: C.SELF_PROTECTION_UNAVAILABLE };
  }
  if (writeLike && facts?.selfProtection?.matched === true) {
    return { decision: 'DENY', code: C.SELF_PROTECTION_BOUNDARY };
  }
  return { decision: 'ALLOW', code: '' };
}

export function evaluatePermissionOperation({
  operation,
  facts,
  mode = PERMISSION_MODES.STANDARD,
  capability = null,
  now = Date.now(),
  useNonce = '',
  usageConsumed = 0,
  consumedUseNonces = [],
  llmHint = undefined,
  verifyFactsProof = null,
  verifyGrantProof = null,
} = {}) {
  // llmHint is intentionally ignored. Keeping the parameter explicit makes
  // it harder for an integration to accidentally turn model prose into auth.
  void llmHint;
  if (!validMode(mode)) return { decision: 'DENY', reasonCode: C.MODE_INVALID, reasons: [C.MODE_INVALID] };
  const operationValidation = validateSemanticOperation(operation);
  if (!operationValidation.ok) {
    return { decision: 'DENY', reasonCode: C.OPERATION_INVALID, reasons: [C.OPERATION_INVALID], errors: operationValidation.errors };
  }
  const factsValidation = validatePermissionFacts(operation, facts);
  const ceiling = ceilingFor(operation, factsValidation, facts);
  if (ceiling.decision === 'DENY') {
    return { decision: 'DENY', reasonCode: ceiling.code, reasons: [ceiling.code], ceiling: 'DENY' };
  }
  const factsProof = verifyPermissionFactsProof(operation, facts, verifyFactsProof);
  if (!factsProof.ok) {
    return { decision: 'DENY', reasonCode: factsProof.code, reasons: [factsProof.code], ceiling: 'DENY' };
  }

  const hasStrongDefaultDenyAction = operationActions(operation)
    .some((action) => STRONG_DEFAULT_DENY_ACTIONS.includes(action));
  const modePolicy = PERMISSION_MODE_POLICIES[mode];
  const defaultDecision = hasStrongDefaultDenyAction
    ? modePolicy.strongActionWithoutGrant
    : decisionFromStrictness(operationActionStrictness(operation));
  const riskContextReviewRequired = facts.impact.containsSensitiveMaterial === true
    || facts.impact.containsGitMetadata === true
    || facts.executionClass === 'privileged';
  const baseDecision = riskContextReviewRequired && defaultDecision === 'ALLOW'
    ? 'ASK'
    : defaultDecision;
  const reasons = [riskContextReviewRequired && defaultDecision === 'ALLOW'
    ? C.RISK_CONTEXT_REVIEW_REQUIRED
    : baseDecision === 'ALLOW' ? C.ALLOW_DEFAULT : baseDecision === 'ASK' ? C.ASK_DEFAULT : C.DENY_DEFAULT];
  if (capability) {
    const matched = capabilityMatchesOperation(capability, operation, facts, {
      now, mode, useNonce, usageConsumed, consumedUseNonces,
      verifyFactsProof, verifyGrantProof,
    });
    if (matched.ok) {
      return { decision: 'ALLOW', reasonCode: C.CAPABILITY_MATCHED, reasons: [C.CAPABILITY_MATCHED], capabilityMatched: true, ceiling: 'ALLOW' };
    }
    reasons.push(matched.code || C.CAPABILITY_INVALID);
    // A supplied but invalid/mismatched grant must never preserve a default
    // ALLOW. It may fall back to an explicit owner checkpoint, but only ASK
    // at most; the grant itself cannot authorize the broader operation.
    const fallbackDecision = baseDecision === 'ALLOW' ? 'ASK' : baseDecision;
    return { decision: fallbackDecision, reasonCode: matched.code || C.CAPABILITY_INVALID, reasons, capabilityMatched: false, ceiling: 'ALLOW' };
  }
  return { decision: baseDecision, reasonCode: reasons[0], reasons, capabilityMatched: false, ceiling: 'ALLOW' };
}

export function evaluatePermissionSet(entries = [], options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return { decision: 'DENY', reasonCode: C.PERMISSION_SET_EMPTY, reasons: [C.PERMISSION_SET_EMPTY], results: [] };
  }
  const results = list.map((entry) => evaluatePermissionOperation({ ...options, ...entry }));
  return {
    decision: aggregateDecisions(results.map((result) => result.decision)),
    results,
  };
}

export function describePermissionReason(code) {
  return PERMISSION_REASON_MESSAGES[code] || code;
}

export {
  ACTION_TAXONOMY,
};
