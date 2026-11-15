import { createHash } from 'node:crypto';

import { computeApprovedActionSemanticManifestHash } from './approved-action-semantic.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  canonicalSemanticJson,
  computeSemanticManifestHash,
} from './semantic-operation.mjs';
import { normalizeSessionStarterPreset, CREATE_AGENT_STARTER_PRESET } from './session-starter-preset.mjs';

export const AGENT_CREATE_OPERATION = 'agent.create';
export const AGENT_CREATE_EXECUTION_CLASS = 'product';
export const AGENT_CREATE_CATEGORY = 'product_agent_create';
export const AGENT_CREATE_TARGET_KIND = 'product_agent_definition';
export const AGENT_CREATE_EFFECTS = Object.freeze([
  'product.agent_catalog.write',
  'product.agent_prompt.persist',
  'product.agent_runtime_binding.persist',
  'product.agent_skill_labels.persist',
]);

const MAX_NAME_BYTES = 256;
const MAX_TOOL_BYTES = 128;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_WELCOME_BYTES = 16 * 1024;
const MAX_SKILLS = 32;
const MAX_SKILL_BYTES = 256;
const MAX_PER_MESSAGE_LOCALES = 16;
const MAX_PER_MESSAGE_PROMPT_BYTES = 16 * 1024;
// Locale keys that carry prototype/constructor semantics must never be
// accepted as data keys, even though they pass the [A-Za-z0-9_-] charset.
const RESERVED_LOCALE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function boundedText(value, field, maxBytes, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('AGENT_CREATE_FIELD_REQUIRED', `${field} is required`);
    return '';
  }
  // Fail-closed on wrong types: a caller payload that was silently coerced to
  // '' would change the semantics of the approved hash. Numbers, booleans,
  // arrays and objects must be rejected, not normalized away.
  if (typeof value !== 'string') {
    fail('AGENT_CREATE_FIELD_TYPE_INVALID', `${field} must be a string`);
  }
  const normalized = value.trim();
  if (required && !normalized) fail('AGENT_CREATE_FIELD_REQUIRED', `${field} is required`);
  if (byteLength(normalized) > maxBytes) {
    fail('AGENT_CREATE_FIELD_TOO_LARGE', `${field} exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function normalizeSkills(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILLS) {
    fail('AGENT_CREATE_SKILLS_INVALID', `skills must contain at most ${MAX_SKILLS} strings`);
  }
  const normalized = value.map((entry, index) => boundedText(
    entry,
    `skills[${index}]`,
    MAX_SKILL_BYTES,
    { required: true },
  ));
  if (new Set(normalized).size !== normalized.length) {
    fail('AGENT_CREATE_SKILLS_INVALID', 'skills must not contain duplicates');
  }
  return normalized;
}

function normalizePerMessageSystemPrompt(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AGENT_CREATE_PER_MESSAGE_PROMPT_INVALID', 'perMessageSystemPrompt must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PER_MESSAGE_LOCALES) {
    fail('AGENT_CREATE_PER_MESSAGE_PROMPT_INVALID', `perMessageSystemPrompt may contain at most ${MAX_PER_MESSAGE_LOCALES} locales`);
  }
  // Null-prototype accumulator: assignment can never trigger a prototype
  // setter, and reserved keys are rejected explicitly as a second layer.
  const normalized = Object.create(null);
  for (const [locale, prompt] of entries) {
    const key = boundedText(locale, 'perMessageSystemPrompt locale', 64, { required: true });
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      fail('AGENT_CREATE_PER_MESSAGE_PROMPT_INVALID', 'perMessageSystemPrompt locale is invalid');
    }
    if (RESERVED_LOCALE_KEYS.has(key)) {
      fail('AGENT_CREATE_PER_MESSAGE_PROMPT_INVALID', 'perMessageSystemPrompt locale is reserved');
    }
    normalized[key] = boundedText(
      prompt,
      `perMessageSystemPrompt.${key}`,
      MAX_PER_MESSAGE_PROMPT_BYTES,
      { required: true },
    );
  }
  // Spread back into a plain object only after reserved keys were rejected:
  // object spread uses CreateDataProperty, so it can never trip a prototype
  // setter even if a hostile key were present.
  return Object.keys(normalized).length > 0 ? { ...normalized } : null;
}

export function isAgentCreateApprovedActionEnabled(env = process.env) {
  return trimString(env?.RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED) === '1';
}

export function isAgentCreateApprovedAction(value) {
  return trimString(value?.operation || value?.primaryAction) === AGENT_CREATE_OPERATION
    || trimString(value?.category) === AGENT_CREATE_CATEGORY
    // Client projections intentionally omit the internal operation and raw
    // payload. Keep the sanitized definition recognizable so a second
    // projection remains idempotent across history and live-event paths.
    || (value?.agentDefinition && typeof value.agentDefinition === 'object');
}

export function normalizeAgentCreatePayload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AGENT_CREATE_PAYLOAD_INVALID', 'agent must be an object');
  }
  const allowed = new Set([
    'name',
    'systemPrompt',
    'welcomeMessage',
    'tool',
    'skills',
    'perMessageSystemPrompt',
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail('AGENT_CREATE_PAYLOAD_INVALID', `agent.${unknown} is not supported`);
  const normalized = {
    name: boundedText(value.name, 'agent.name', MAX_NAME_BYTES, { required: true }),
    systemPrompt: boundedText(value.systemPrompt, 'agent.systemPrompt', MAX_PROMPT_BYTES),
    welcomeMessage: boundedText(value.welcomeMessage, 'agent.welcomeMessage', MAX_WELCOME_BYTES),
    tool: boundedText(value.tool, 'agent.tool', MAX_TOOL_BYTES, { required: true }),
    skills: normalizeSkills(value.skills),
  };
  const perMessageSystemPrompt = normalizePerMessageSystemPrompt(value.perMessageSystemPrompt);
  if (perMessageSystemPrompt) normalized.perMessageSystemPrompt = perMessageSystemPrompt;
  return normalized;
}

export function computeAgentCreatePayloadHash(payload = {}) {
  return createHash('sha256')
    .update(canonicalSemanticJson(normalizeAgentCreatePayload(payload)), 'utf8')
    .digest('hex');
}

// A stable fingerprint over the server-owned tool selection facts that decide
// how this Agent will actually run. Approval binds this fingerprint; if any of
// these facts change between approval and execution, the operation must be
// re-decided. `available` is intentionally excluded: availability can legitimately
// change with the environment, while the binding (runtime family / command /
// provider) must not.
export function computeToolDefinitionFingerprint(tool = {}) {
  const stable = {
    id: trimString(tool.id),
    name: trimString(tool.name),
    runtimeFamily: trimString(tool.runtimeFamily),
    command: trimString(tool.command),
    builtin: tool.builtin === true,
    internalFallback: tool.internalFallback === true,
    provider: trimString(tool.provider),
    providerCapabilities: tool.providerCapabilities && typeof tool.providerCapabilities === 'object'
      ? tool.providerCapabilities
      : null,
    toolProfile: trimString(tool.toolProfile),
    promptMode: trimString(tool.promptMode),
    flattenPrompt: tool.flattenPrompt === true,
    models: Array.isArray(tool.models) ? tool.models : [],
    reasoning: tool.reasoning && typeof tool.reasoning === 'object' ? tool.reasoning : null,
    environment: {
      sourceKind: trimString(tool?._meta?.sourceKind),
      toolDir: trimString(tool?._meta?.toolDir),
      cardPath: trimString(tool?._meta?.cardPath),
      overlayPath: trimString(tool?._meta?.overlayPath),
    },
  };
  return createHash('sha256').update(canonicalSemanticJson(stable), 'utf8').digest('hex');
}

// True when the session carries agent/template-scoped provenance. The
// create-agent starter operation is an owner-product flow; a session created
// from a template, a share link, or a non-owner principal must not reach an
// owner approval even if the current turn authenticates as owner.
export function hasAgentScopeSessionProvenance(session = {}) {
  const principalKind = trimString(session.createdByPrincipalKind);
  return Boolean(
    trimString(session.templateId)
    || trimString(session.createdByPrincipalId)
    || trimString(session.visitorId)
    || trimString(session.agentId)
    || trimString(session.scope?.agentId)
    || trimString(session.surfaceMode) === 'agent_scoped'
    || trimString(session.sourceId) === 'share_link'
    || (principalKind && principalKind !== 'owner'),
  );
}

// Product Agent creation is available from the dedicated starter and from a
// plain owner root session. The latter is important for an owner who begins
// in an ordinary conversation and only then decides to turn the workflow into
// a reusable Agent. Delegated children, template-backed sessions, visitors,
// and organization workers remain ineligible even when their current turn is
// owner-authenticated.
export function isAgentCreateSessionEligible(session = {}) {
  if (hasAgentScopeSessionProvenance(session)) return false;
  const starterPreset = normalizeSessionStarterPreset(session.starterPreset);
  const sessionClass = trimString(session.sessionClass);
  const isOwnerRoot = (!sessionClass || sessionClass === 'ROOT_LEADERSHIP')
    && trimString(session.sessionPlane || 'user') === 'user'
    && !trimString(session.delegatedFromSessionId)
    && !trimString(session.parentSessionId)
    && session.userAddressable !== false;
  if (!isOwnerRoot) return false;
  return starterPreset === CREATE_AGENT_STARTER_PRESET
    || (sessionClass === 'ROOT_LEADERSHIP' && !starterPreset)
    || (!sessionClass && !starterPreset && !trimString(session.templateId));
}

// Agent `skills` are currently bounded catalog labels. They are not executable
// code and do not mint capabilities. There is no authoritative Agent skill
// registry yet, so the security boundary must never interpret these strings as
// proof that a runtime skill exists or is authorized.
export async function validateAgentCreatePayloadRegistries(payload = {}, {
  getToolDefinitionImpl,
} = {}) {
  const normalized = normalizeAgentCreatePayload(payload);
  if (typeof getToolDefinitionImpl !== 'function') {
    fail('AGENT_CREATE_TOOL_UNRESOLVED', 'Agent tool registry is unavailable');
  }
  let tool;
  try {
    tool = await getToolDefinitionImpl(normalized.tool);
  } catch {
    fail('AGENT_CREATE_TOOL_UNRESOLVED', 'Agent tool could not be resolved from the server registry');
  }
  if (!tool || trimString(tool.id) !== normalized.tool) {
    fail('AGENT_CREATE_TOOL_UNKNOWN', `Agent tool "${normalized.tool}" is not registered`);
  }
  if (tool.available !== true) {
    fail('AGENT_CREATE_TOOL_UNAVAILABLE', `Agent tool "${normalized.tool}" is not available`);
  }
  return {
    payload: normalized,
    tool: {
      id: trimString(tool.id),
      runtimeFamily: trimString(tool.runtimeFamily),
    },
    toolFingerprint: computeToolDefinitionFingerprint(tool),
    skillsSemantics: 'bounded_labels_only',
  };
}

export function buildAgentCreateReviewSummary(payload = {}) {
  const normalized = normalizeAgentCreatePayload(payload);
  const promptHash = createHash('sha256').update(normalized.systemPrompt, 'utf8').digest('hex').slice(0, 16);
  const visibleSkills = normalized.skills.slice(0, 8);
  const skills = visibleSkills.length > 0
    ? `${visibleSkills.join(', ')}${normalized.skills.length > visibleSkills.length ? ` (+${normalized.skills.length - visibleSkills.length} more)` : ''}`
    : 'none';
  return `tool=${normalized.tool}; skills=${skills}; systemPrompt=${normalized.systemPrompt.length} chars/sha256:${promptHash}`;
}

function trustedProductContext(action, trustedContext = {}) {
  const session = trustedContext.session && typeof trustedContext.session === 'object'
    ? trustedContext.session
    : {};
  const run = trustedContext.run && typeof trustedContext.run === 'object'
    ? trustedContext.run
    : {};
  const manifest = trustedContext.manifest && typeof trustedContext.manifest === 'object'
    ? trustedContext.manifest
    : {};
  const sessionId = trimString(run.sessionId);
  const runId = trimString(run.id);
  const turnId = trimString(manifest?.options?.approvedActionChannel?.turnId) || trimString(manifest.requestId);
  const starterPreset = normalizeSessionStarterPreset(session.starterPreset);
  const authenticatedPrincipalKind = trimString(manifest?.options?.approvedActionChannel?.authenticatedPrincipalKind);
  const toolFingerprint = trimString(trustedContext.toolFingerprint);
  const payloadHash = computeAgentCreatePayloadHash(action?.agentPayload || {});
  const unknowns = [];
  if (!sessionId || !runId || !turnId) unknowns.push('run_binding_unresolved');
  if (trimString(manifest.sessionId) !== sessionId) unknowns.push('manifest_session_mismatch');
  if (!isAgentCreateSessionEligible(session)) unknowns.push('agent_create_session_ineligible');
  if (authenticatedPrincipalKind !== 'owner') unknowns.push('owner_turn_unresolved');
  if (trimString(action?.agentPayloadHash) !== payloadHash) unknowns.push('payload_hash_mismatch');
  // The proposal must bind a server-resolved tool fingerprint; without it the
  // approved runtime binding cannot be revalidated at execution time.
  if (!toolFingerprint) unknowns.push('tool_fingerprint_unresolved');
  // Sessions that carry template or agent-scoped provenance must not reach an
  // owner approval, even on an owner-authenticated turn.
  if (hasAgentScopeSessionProvenance(session)) unknowns.push('agent_scoped_session_provenance');
  return {
    sessionId,
    runId,
    turnId,
    starterPreset,
    authenticatedPrincipalKind,
    toolFingerprint,
    payloadHash,
    unknowns,
  };
}

export function prepareAgentCreateSemanticProjection({ action, trustedContext = {} } = {}) {
  const context = trustedProductContext(action, trustedContext);
  const decision = context.unknowns.length > 0 ? 'DENY' : 'ASK';
  const snapshotIdentity = `agent-catalog:${context.sessionId}:${context.runId}:${context.turnId}:${context.payloadHash}:${context.toolFingerprint}`;
  const operation = {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: `agent_create:${trimString(action?.actionId)}`,
    requestBinding: {
      sessionId: context.sessionId || 'unresolved',
      runId: context.runId || 'unresolved',
      turnId: context.turnId || 'unresolved',
      requestKey: trimString(action?.requestKey) || 'unresolved',
    },
    primaryAction: AGENT_CREATE_OPERATION,
    effects: [...AGENT_CREATE_EFFECTS],
    executionClass: AGENT_CREATE_EXECUTION_CLASS,
    target: {
      kind: AGENT_CREATE_TARGET_KIND,
      platform: trimString(trustedContext.platform) || process.platform,
      catalog: 'apps',
      payloadHash: context.payloadHash,
      exact: true,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        identity: snapshotIdentity,
        sessionId: context.sessionId,
        runId: context.runId,
        turnId: context.turnId,
        payloadHash: context.payloadHash,
        toolFingerprint: context.toolFingerprint,
      },
    },
    scope: {
      kind: 'owner_product_agent_catalog',
      computed: context.unknowns.length === 0,
      sessionId: context.sessionId,
      runId: context.runId,
      turnId: context.turnId,
      starterPreset: context.starterPreset,
      authenticatedPrincipalKind: context.authenticatedPrincipalKind,
    },
    impact: {
      estimatedItems: 1,
      reversible: true,
      // Prompt text is durable product configuration. Treat it as sensitive
      // without attempting to classify or echo possible credentials.
      containsSensitiveMaterial: true,
      containsGitMetadata: false,
    },
    source: {
      rawRequestHash: `sha256:${context.payloadHash}`,
      commandForm: 'structured-product-operation',
    },
    analysis: {
      confidence: context.unknowns.length === 0 ? 'high' : 'unknown',
      unknowns: [...context.unknowns],
      policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      effectsComplete: context.unknowns.length === 0,
    },
  };
  const entry = {
    operationId: operation.operationId,
    operation,
    operationManifestHash: computeSemanticManifestHash(operation),
    resolverSnapshotIdentity: snapshotIdentity,
    policyVersion: SEMANTIC_POLICY_VERSION,
    unknowns: [...context.unknowns],
    decision,
    strictness: decision === 'ASK' ? 2 : 3,
    reasons: [{
      code: decision === 'ASK' ? 'product_agent_create_owner_confirmation' : 'product_agent_create_unresolved',
      message: decision === 'ASK'
        ? 'Creating a persistent Agent requires owner confirmation'
        : 'Agent creation context could not be resolved safely',
    }],
  };
  const projection = {
    schemaVersion: 'approved-action-semantic/v1',
    decision,
    strictness: entry.strictness,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    policyVersion: SEMANTIC_POLICY_VERSION,
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    unknowns: [...context.unknowns],
    decisions: [entry],
  };
  return {
    ...projection,
    semanticManifestHash: computeApprovedActionSemanticManifestHash({ action, projection }),
  };
}
