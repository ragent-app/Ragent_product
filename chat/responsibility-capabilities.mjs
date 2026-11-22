import { getOrganization } from './organization-store.mjs';
import { getFactoryFormula } from './factory-workflow.mjs';
import { digest } from './work-graph-store.mjs';
import { PROJECT_REPORT_PROVIDER, GENERIC_PLANNER_PROVIDER } from './responsibility-providers.mjs';
import { getPricingMetadataForModel } from '../lib/model-pricing.mjs';
import {
  CONNECTOR_CORE_IDS,
  CONNECTOR_RISK_LEVELS,
  evaluateConnectorActionPolicy,
  getConnectorActionCatalog,
  getConnectorActionDefinition,
} from '../lib/connector-action-dispatcher.mjs';

export const MODEL_TIERS = Object.freeze(['lightweight', 'standard', 'strong']);

export const DEFAULT_COST_AWARE_TIERING_POLICY = Object.freeze({
  enabled: true,
  defaultTier: 'standard',
  observationTier: 'lightweight',
  executionTier: 'strong',
  reviewTier: 'strong',
  maxTier: 'strong',
  allowBudgetDowngrade: false,
  allowWriteBudgetDowngrade: false,
  budgetPressureThresholdRatio: 0.25,
  preserveOwnerLocks: true,
  tiers: Object.freeze({
    lightweight: Object.freeze({
      maxCostRatio: 0.35,
      preferredModels: Object.freeze([
        Object.freeze({ tool: 'codex', model: 'gpt-5.4-nano' }),
        Object.freeze({ tool: 'codex', model: 'gpt-5.4-mini' }),
        Object.freeze({ tool: 'claude', model: 'claude-haiku-4.5' }),
      ]),
    }),
    standard: Object.freeze({
      maxCostRatio: 0.7,
      preferredModels: Object.freeze([
        Object.freeze({ tool: 'codex', model: 'gpt-5.4-mini' }),
        Object.freeze({ tool: 'claude', model: 'claude-sonnet-4.6' }),
        Object.freeze({ tool: 'codex', model: 'gpt-5.4' }),
      ]),
    }),
    strong: Object.freeze({
      maxCostRatio: 1,
      preferredModels: Object.freeze([
        Object.freeze({ tool: 'codex', model: 'gpt-5.4' }),
        Object.freeze({ tool: 'claude', model: 'claude-opus-4.6' }),
        Object.freeze({ tool: 'claude', model: 'claude-sonnet-4.6' }),
      ]),
    }),
  }),
});

export const STAGE2_SWARM_TEMPLATE = Object.freeze({
  id: 'ragent-swarm-collaboration',
  version: 1,
  capabilities: Object.freeze(['read', 'write', 'delegate', 'review']),
});

export const STAGE2_FANOUT_READ_FORMULA = Object.freeze({
  id: 'ragent-fanout-workflow',
  version: 1,
  capabilities: Object.freeze(['read']),
});

export const STAGE2_FANOUT_WRITE_FORMULA = Object.freeze({
  id: 'ragent-fanout-workflow',
  version: 1,
  capabilities: Object.freeze(['read', 'write']),
});

function requiredConnectorGateForRisk(riskLevel) {
  if (riskLevel === 'read') return 'capabilityGates.allowConnectorRead';
  if (riskLevel === 'reversible_write') return 'capabilityGates.allowConnectorWrite';
  return 'capabilityGates.allowConnectorBroadcast';
}

function buildConnectorCatalogDescriptors() {
  return Object.freeze(
    getConnectorActionCatalog().map((entry) => {
      const actionClass = entry.actionClass || (entry.riskLevel === 'read' ? 'read' : (entry.riskLevel === 'reversible_write' ? 'write' : 'broadcast'));
      return Object.freeze({
        capability: entry.capability,
        connectorId: entry.connectorId,
        actionClass,
        privilegeGroup: entry.privilegeGroup || actionClass,
        riskLevel: entry.riskLevel,
        confirmationPolicy: entry.confirmationPolicy,
        timeoutMs: entry.timeoutMs,
        defaultOptIn: false,
        autoEligible: false,
        requiresHumanApproval: entry.riskLevel !== 'read' || entry.confirmationPolicy === 'require_approval',
        requiredCapabilityGate: requiredConnectorGateForRisk(entry.riskLevel),
        receiptVerifierKind: entry.receiptVerifier?.kind || 'none_readonly',
        receiptVerifierSupported: entry.receiptVerifier?.supported === true,
        compensationMode: entry.compensation?.mode || 'none_readonly',
        compensationSupported: entry.compensation?.supported === true,
      });
    }),
  );
}

export const STAGE4_CONNECTOR_CAPABILITY_CATALOG = buildConnectorCatalogDescriptors();

function buildStage4ConnectorPlanDescriptors() {
  const groups = new Map();
  for (const item of STAGE4_CONNECTOR_CAPABILITY_CATALOG) {
    const key = `${item.connectorId}:${item.actionClass}`;
    if (!groups.has(key)) {
      groups.set(key, {
        connectorId: item.connectorId,
        actionClass: item.actionClass,
        riskLevels: new Set(),
        capabilities: [],
        requiredCapabilityGate: item.requiredCapabilityGate,
      });
    }
    const group = groups.get(key);
    group.riskLevels.add(item.riskLevel);
    group.capabilities.push(item.capability);
  }

  return Object.freeze(
    [...groups.values()].map((group) => {
      const templateObj = Object.freeze({
        id: `ragent-connector-${group.connectorId}-${group.actionClass}`,
        version: 1,
        connectorId: group.connectorId,
        actionClass: group.actionClass,
        capabilities: Object.freeze([...group.capabilities]),
      });
      const gateKey = group.requiredCapabilityGate;
      const reason = group.actionClass === 'broadcast'
        ? `Requires explicit policy.${gateKey}=true, allowedConnectorCapabilities opt-in, scoped resource bounds, and mandatory per-action human approval (never auto-admitted).`
        : `Requires explicit policy.${gateKey}=true, allowedConnectorCapabilities opt-in, and scoped resource bounds.`;
      return Object.freeze({
        capability: `connector-${group.connectorId}-${group.actionClass}`,
        connectorId: group.connectorId,
        actionClass: group.actionClass,
        riskLevels: Object.freeze([...group.riskLevels]),
        connectorCapabilities: templateObj.capabilities,
        available: true,
        defaultOptIn: false,
        requiredCapabilityGate: gateKey,
        reason,
        templateId: templateObj.id,
        templateVersion: templateObj.version,
        templateDigest: digest(templateObj),
        requiredFields: Object.freeze(['connectorId', 'capability', 'scope', 'idempotencyKey']),
        autoEligible: false,
        requiresHumanApproval: true,
      });
    }),
  );
}

export const STAGE4_CONNECTOR_PLAN_DESCRIPTORS = buildStage4ConnectorPlanDescriptors();

function intersectScopedArray(policyArr, orgArr) {
  const hasPolicy = Array.isArray(policyArr);
  const hasOrg = Array.isArray(orgArr);
  if (hasPolicy && hasOrg) {
    const orgSet = new Set(orgArr.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
    return policyArr.filter((v) => orgSet.has(String(v || '').trim().toLowerCase()));
  }
  if (hasPolicy) return [...policyArr];
  if (hasOrg) return [...orgArr];
  return undefined;
}

function extractScopedMap(rawScopes, connectorId) {
  if (!rawScopes || typeof rawScopes !== 'object' || Array.isArray(rawScopes)) return {};
  if (Object.hasOwn(rawScopes, connectorId)) {
    const sub = rawScopes[connectorId];
    return sub && typeof sub === 'object' && !Array.isArray(sub) ? sub : {};
  }
  if (CONNECTOR_CORE_IDS.some((id) => Object.hasOwn(rawScopes, id))) {
    return {};
  }
  return rawScopes;
}

function mergeConnectorScopes(policyScopes = null, orgScopes = null, connectorId = '') {
  const p = extractScopedMap(policyScopes, connectorId);
  const o = extractScopedMap(orgScopes, connectorId);
  const merged = { ...p };
  for (const arrayKey of [
    'allowedRepositories',
    'allowedBaseBranches',
    'allowedRecipients',
    'allowedRecipientDomains',
    'allowedCalendarIds',
    'allowedFolderIds',
    'allowedShareEmails',
    'allowedShareDomains',
  ]) {
    const intersected = intersectScopedArray(p[arrayKey], o[arrayKey]);
    if (intersected !== undefined) merged[arrayKey] = intersected;
  }
  if (p.allowDraftOnly === true || o.allowDraftOnly === true) {
    merged.allowDraftOnly = true;
  }
  if (p.allowPublicExposure === true && (o.allowPublicExposure === undefined || o.allowPublicExposure === true)) {
    merged.allowPublicExposure = true;
  } else {
    merged.allowPublicExposure = false;
  }
  return { [connectorId]: merged };
}

/**
 * Evaluate conservative Planner/Responsibility boundaries for a connector
 * action before dispatch. Connector capabilities are default-off and strictly
 * separated across read, reversible_write, and irreversible/broadcast tiers.
 */
export function resolveConnectorCapabilityBoundary({
  capability,
  scope = {},
  payload = null,
  idempotencyKey = 'boundary-check',
  policy = null,
  orgPolicy = null,
  approval = null,
  actor = null,
} = {}) {
  const def = getConnectorActionDefinition(capability);
  if (!def) {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_CAPABILITY_UNKNOWN',
      reason: `Unverified or unknown connector capability "${String(capability || '')}".`,
    };
  }

  const gates = policy?.capabilityGates && typeof policy.capabilityGates === 'object' ? policy.capabilityGates : {};
  if (def.riskLevel === 'read' && gates.allowConnectorRead !== true) {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_GATE_DISABLED',
      reason: `Capability "${def.capability}" requires explicit policy.capabilityGates.allowConnectorRead=true.`,
    };
  }
  if (def.riskLevel === 'reversible_write' && gates.allowConnectorWrite !== true) {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_GATE_DISABLED',
      reason: `Capability "${def.capability}" requires explicit policy.capabilityGates.allowConnectorWrite=true.`,
    };
  }
  if ((def.riskLevel === 'irreversible_write' || def.riskLevel === 'external_broadcast') && gates.allowConnectorBroadcast !== true) {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_GATE_DISABLED',
      reason: `Capability "${def.capability}" requires explicit policy.capabilityGates.allowConnectorBroadcast=true.`,
    };
  }

  // Default-off opt-in check: policy MUST explicitly opt in to the exact capability.
  const optedIn = Array.isArray(policy?.allowedConnectorCapabilities)
    ? policy.allowedConnectorCapabilities.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  if (!optedIn.includes(def.capability)) {
    return {
      allowed: false,
      state: 'denied',
      code: 'CONNECTOR_CAPABILITY_NOT_OPTED_IN',
      reason: `Capability "${def.capability}" is default-off and not opted into policy.allowedConnectorCapabilities.`,
    };
  }

  if (orgPolicy && typeof orgPolicy === 'object') {
    if (Array.isArray(orgPolicy.disallowedConnectors) && orgPolicy.disallowedConnectors.includes(def.connectorId)) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_ORG_POLICY_DENIED',
        reason: `Organization policy disables connector "${def.connectorId}".`,
      };
    }
    if (Array.isArray(orgPolicy.disallowedConnectorCapabilities) && orgPolicy.disallowedConnectorCapabilities.includes(def.capability)) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_ORG_POLICY_DENIED',
        reason: `Organization policy disables capability "${def.capability}".`,
      };
    }
    if (Array.isArray(orgPolicy.allowedConnectors) && !orgPolicy.allowedConnectors.includes(def.connectorId)) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_ORG_POLICY_DENIED',
        reason: `Connector "${def.connectorId}" is not allowed by organization policy.`,
      };
    }
    if (Array.isArray(orgPolicy.allowedConnectorCapabilities) && !orgPolicy.allowedConnectorCapabilities.includes(def.capability)) {
      return {
        allowed: false,
        state: 'denied',
        code: 'CONNECTOR_ORG_POLICY_DENIED',
        reason: `Capability "${def.capability}" is not allowed by organization policy.`,
      };
    }
  }

  const effectiveScope = {
    connectorId: def.connectorId,
    resource: scope?.resource || `${def.connectorId}:scoped`,
    ...(scope && typeof scope === 'object' ? scope : {}),
  };

  const mergedScopes = mergeConnectorScopes(
    policy?.connectorScopes || policy?.allowedScopes,
    orgPolicy?.connectorScopes || orgPolicy?.allowedScopes,
    def.connectorId,
  );

  const effectivePolicy = {
    ...(policy && typeof policy === 'object' ? policy : {}),
    allowedCapabilities: optedIn,
    connectorScopes: mergedScopes,
    withinPolicy: policy?.planApproval === 'within_policy' && policy?.planAutoAdmissionConfirmed === true,
  };

  return evaluateConnectorActionPolicy({
    contract: {
      capability: def.capability,
      connectorId: def.connectorId,
      actionClass: def.actionClass,
      privilegeGroup: def.privilegeGroup,
      scope: effectiveScope,
      riskLevel: def.riskLevel,
      idempotencyKey,
      confirmationPolicy: def.confirmationPolicy,
      timeoutMs: def.timeoutMs,
      receiptVerifier: def.receiptVerifier?.supported
        ? { ...def.receiptVerifier, verify: async () => null }
        : def.receiptVerifier,
      compensation: def.compensation,
    },
    payload,
    policy: effectivePolicy,
    approval,
    actor,
  });
}

const OBSERVATION_KINDS = new Set([
  'observation',
  'investigation',
  'report',
  'planning',
  'planner',
  'triage',
  'research',
  'audit',
]);

const EXECUTION_STRONG_KINDS = new Set([
  'implementation',
  'code',
  'author',
  'edit',
  'integration',
  'delivery',
  'release',
]);

const REVIEW_STRONG_KINDS = new Set(['review', 'verification', 'qa', 'acceptance']);

function normalizeTierName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return MODEL_TIERS.includes(normalized) ? normalized : '';
}

function tierRank(tier) {
  const idx = MODEL_TIERS.indexOf(normalizeTierName(tier));
  return idx >= 0 ? idx : 1;
}

function minTier(a, b) {
  const rankA = tierRank(a);
  const rankB = tierRank(b);
  return MODEL_TIERS[Math.min(rankA, rankB)];
}

function parseCandidateList(tierConfig, overrideList) {
  const raw = Array.isArray(overrideList) && overrideList.length > 0
    ? overrideList
    : (Array.isArray(tierConfig?.preferredModels) ? tierConfig.preferredModels : []);
  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        if (trimmed.includes(':')) {
          const idx = trimmed.indexOf(':');
          return { tool: trimmed.slice(0, idx).trim().toLowerCase(), model: trimmed.slice(idx + 1).trim() };
        }
        const lower = trimmed.toLowerCase();
        const inferredTool = lower.startsWith('claude') ? 'claude' : lower.startsWith('gemini') ? 'gemini' : 'codex';
        return { tool: inferredTool, model: trimmed };
      }
      if (entry && typeof entry === 'object' && typeof entry.model === 'string' && entry.model.trim()) {
        return {
          tool: String(entry.tool || 'codex').trim().toLowerCase(),
          model: entry.model.trim(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function isCandidateAllowedByOrgPolicy(candidate, orgPolicy = null, requiredTool = '') {
  if (!candidate?.model) return false;
  const tool = String(candidate.tool || '').trim().toLowerCase();
  const model = String(candidate.model || '').trim();
  const reqTool = String(requiredTool || '').trim().toLowerCase();
  if (reqTool && tool && tool !== reqTool) return false;

  const allowedHarnesses = Array.isArray(orgPolicy?.allowedHarnesses)
    ? orgPolicy.allowedHarnesses.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowedHarnesses.length > 0 && !allowedHarnesses.includes(tool)) return false;

  const disallowedModels = Array.isArray(orgPolicy?.disallowedModels)
    ? new Set(orgPolicy.disallowedModels.map((entry) => String(entry || '').trim().toLowerCase()))
    : new Set();
  if (disallowedModels.has(model.toLowerCase()) || disallowedModels.has(`${tool}:${model.toLowerCase()}`)) {
    return false;
  }

  const allowedModels = Array.isArray(orgPolicy?.allowedModels)
    ? orgPolicy.allowedModels.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowedModels.length > 0) {
    const matched = allowedModels.includes(model.toLowerCase())
      || allowedModels.includes(`${tool}:${model.toLowerCase()}`);
    if (!matched) return false;
  }
  return true;
}

function selectModelForTier(tier, { tieringPolicy, orgPolicy, tool = '' } = {}) {
  const defaultTierDef = DEFAULT_COST_AWARE_TIERING_POLICY.tiers[tier] || DEFAULT_COST_AWARE_TIERING_POLICY.tiers.standard;
  const customTierDef = tieringPolicy?.tiers?.[tier] || null;
  const overrideModels = tieringPolicy?.tierModels?.[tier] || customTierDef?.preferredModels;
  const candidates = parseCandidateList(defaultTierDef, overrideModels);
  const toolRestricted = candidates.filter((entry) => isCandidateAllowedByOrgPolicy(entry, orgPolicy, tool));
  const pool = toolRestricted.length > 0
    ? toolRestricted
    : candidates.filter((entry) => isCandidateAllowedByOrgPolicy(entry, orgPolicy, ''));
  const chosen = pool[0] || null;
  if (!chosen) return null;
  const pricing = getPricingMetadataForModel(chosen.model, { tool: chosen.tool }) || null;
  const estimatedCostPer1MTokens = pricing
    ? Number((Number(pricing.inputUsdPerMillion || 0) + Number(pricing.outputUsdPerMillion || 0)).toFixed(6))
    : null;
  return {
    tool: chosen.tool,
    model: chosen.model,
    pricing,
    estimatedCostPer1MTokens,
  };
}

function normalizeBudgetValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolveCostAwareModelTiering({
  capability = 'project-report',
  stepKind = '',
  accessMode = 'read',
  requiredRole = '',
  modelTierHint = '',
  tieringPolicy = null,
  orgPolicy = null,
  ownerRuntimeLocks = null,
  budgetContext = null,
  tool = '',
  currentModel = '',
} = {}) {
  const effectivePolicy = {
    ...DEFAULT_COST_AWARE_TIERING_POLICY,
    ...(tieringPolicy && typeof tieringPolicy === 'object' ? tieringPolicy : {}),
  };
  const normalizedKind = String(stepKind || requiredRole || '').trim().toLowerCase();
  const normalizedRole = String(requiredRole || '').trim().toLowerCase();
  const normalizedAccess = String(accessMode || 'read').trim().toLowerCase() === 'write' ? 'write' : 'read';

  let requestedTier = normalizeTierName(modelTierHint);
  if (!requestedTier) {
    if (REVIEW_STRONG_KINDS.has(normalizedKind) || REVIEW_STRONG_KINDS.has(normalizedRole)) {
      requestedTier = normalizeTierName(effectivePolicy.reviewTier) || 'strong';
    } else if (normalizedAccess === 'write' || EXECUTION_STRONG_KINDS.has(normalizedKind) || EXECUTION_STRONG_KINDS.has(normalizedRole)) {
      requestedTier = normalizeTierName(effectivePolicy.executionTier) || 'strong';
    } else if (
      OBSERVATION_KINDS.has(normalizedKind)
      || OBSERVATION_KINDS.has(normalizedRole)
      || (normalizedAccess === 'read' && normalizedKind === 'execution')
      || capability === 'project-report'
    ) {
      requestedTier = normalizeTierName(effectivePolicy.observationTier) || 'lightweight';
    } else {
      requestedTier = normalizeTierName(effectivePolicy.defaultTier) || 'standard';
    }
  }

  const maxTier = normalizeTierName(effectivePolicy.maxTier) || 'strong';
  const cappedTier = minTier(requestedTier, maxTier);

  const lockedByOwner = Boolean(
    effectivePolicy.preserveOwnerLocks !== false && (
      ownerRuntimeLocks?.locked === true
      || ownerRuntimeLocks?.modelLockedByOwner === true
      || ownerRuntimeLocks?.pinRuntime === true
    )
  );
  if (lockedByOwner) {
    const lockedTool = String(ownerRuntimeLocks?.tool || tool || 'codex').trim().toLowerCase();
    const lockedModel = String(ownerRuntimeLocks?.model || currentModel || '').trim();
    const pricing = lockedModel ? getPricingMetadataForModel(lockedModel, { tool: lockedTool }) : null;
    return {
      schemaVersion: 1,
      requestedTier,
      resolvedTier: cappedTier,
      tierRank: tierRank(cappedTier),
      capability,
      stepKind: normalizedKind,
      accessMode: normalizedAccess,
      requiredRole: String(requiredRole || ''),
      selectedTool: lockedTool,
      selectedModel: lockedModel,
      pricing,
      estimatedCostPer1MTokens: pricing
        ? Number((Number(pricing.inputUsdPerMillion || 0) + Number(pricing.outputUsdPerMillion || 0)).toFixed(6))
        : null,
      lockedByOwner: true,
      downgradedForBudget: false,
      switched: false,
      budgetOk: true,
      budgetExceeded: false,
      budgetPressure: false,
      reason: 'owner_lock_preserved',
    };
  }

  const maxCost = normalizeBudgetValue(budgetContext?.maxCost);
  const remainingCostRaw = normalizeBudgetValue(budgetContext?.remainingCost);
  const dailyRemainingCostRaw = normalizeBudgetValue(budgetContext?.dailyRemainingCost);
  const effectiveRemainingCandidates = [remainingCostRaw, dailyRemainingCostRaw].filter((v) => v !== null);
  const effectiveRemaining = effectiveRemainingCandidates.length > 0
    ? Math.min(...effectiveRemainingCandidates)
    : null;
  const thresholdRatio = Number.isFinite(Number(effectivePolicy.budgetPressureThresholdRatio))
    ? Number(effectivePolicy.budgetPressureThresholdRatio)
    : 0.25;
  const budgetExhausted = budgetContext?.exhausted === true || (effectiveRemaining !== null && effectiveRemaining <= 0);
  const budgetPressure = !budgetExhausted && effectiveRemaining !== null && maxCost !== null && maxCost > 0
    && (effectiveRemaining / maxCost) <= thresholdRatio;

  let resolvedTier = cappedTier;
  let downgradedForBudget = false;
  const isCriticalWriteOrReview = normalizedAccess === 'write' || REVIEW_STRONG_KINDS.has(normalizedKind);
  const downgradePermitted = isCriticalWriteOrReview
    ? effectivePolicy.allowWriteBudgetDowngrade === true
    : effectivePolicy.allowBudgetDowngrade === true;

  if (budgetPressure && downgradePermitted && tierRank(resolvedTier) > 0) {
    resolvedTier = MODEL_TIERS[Math.max(0, tierRank(resolvedTier) - 1)];
    downgradedForBudget = resolvedTier !== cappedTier;
  }

  let selected = selectModelForTier(resolvedTier, {
    tieringPolicy: effectivePolicy,
    orgPolicy,
    tool,
  });
  if (!selected && resolvedTier !== 'standard') {
    selected = selectModelForTier('standard', { tieringPolicy: effectivePolicy, orgPolicy, tool });
  }
  if (!selected && resolvedTier !== 'lightweight') {
    selected = selectModelForTier('lightweight', { tieringPolicy: effectivePolicy, orgPolicy, tool });
  }

  const budgetOk = !budgetExhausted && Boolean(selected);
  const currentNorm = String(currentModel || '').trim().toLowerCase();
  const nextNorm = String(selected?.model || '').trim().toLowerCase();

  return {
    schemaVersion: 1,
    requestedTier,
    resolvedTier,
    tierRank: tierRank(resolvedTier),
    capability,
    stepKind: normalizedKind,
    accessMode: normalizedAccess,
    requiredRole: String(requiredRole || ''),
    selectedTool: selected?.tool || String(tool || ''),
    selectedModel: selected?.model || '',
    pricing: selected?.pricing || null,
    estimatedCostPer1MTokens: selected?.estimatedCostPer1MTokens ?? null,
    lockedByOwner: false,
    downgradedForBudget,
    switched: Boolean(nextNorm && currentNorm && nextNorm !== currentNorm),
    budgetOk,
    budgetExceeded: budgetExhausted,
    budgetPressure,
    reason: budgetExhausted
      ? 'budget_exhausted'
      : downgradedForBudget
        ? 'budget_pressure_downgrade'
        : !selected
          ? 'no_allowed_model_for_tier'
          : 'tier_policy_resolved',
  };
}

// Catalog data describes available server code, not an authorization or a
// guarantee that a selected node meets runtime isolation requirements.
export async function getResponsibilityCapabilities({ organizationId, projectId } = {}, actor) {
  if (actor?.kind !== 'user' || actor.role !== 'owner' || !actor.principalId) {
    throw Object.assign(new Error('Owner required'), { statusCode: 403, code: 'RESPONSIBILITY_FORBIDDEN' });
  }
  const org = await getOrganization(organizationId);
  if (!org || (projectId && org.projectId !== projectId) || ['archived', 'lifecycle_pending'].includes(org.state)) {
    throw Object.assign(new Error('Organization or project unavailable'), { statusCode: 404, code: 'RESPONSIBILITY_NOT_FOUND' });
  }
  const report = getFactoryFormula('ragent-project-report', 1);
  const planner = getFactoryFormula('ragent-responsibility-planner', 1);
  const ci = getFactoryFormula('ragent-reviewed-change', 3);
  const fanoutReadDigest = digest(STAGE2_FANOUT_READ_FORMULA);
  const fanoutWriteDigest = digest(STAGE2_FANOUT_WRITE_FORMULA);
  const swarmDigest = digest(STAGE2_SWARM_TEMPLATE);
  const template = f => ({ id: f.id, version: f.version, digest: f.digest });
  return {
    schemaVersion: 1,
    features: {
      timeTriggerBridge: true,
      timeTriggerTypes: ['at_time'],
      eventTriggerBridge: true,
      eventTriggerTypes: ['run_terminal'],
      eventSource: 'root_session',
      sourceCompleteness: 'best_effort_snapshot',
      deliveryGuarantee: 'durable_after_observation',
      committedGitChangesOnly: true,
      fanoutWorkflows: true,
      swarmCollaboration: true,
      costAwareModelTiering: true,
      workerFailureHandoffEvidence: true,
      unifiedConnectorContracts: true,
      connectorRiskLevels: [...CONNECTOR_RISK_LEVELS],
      coreConnectors: [...CONNECTOR_CORE_IDS],
      defaultCapabilityGates: {
        allowWrite: false,
        allowFanout: false,
        allowSwarm: false,
        allowModelSwitch: false,
        allowConnectorRead: false,
        allowConnectorWrite: false,
        allowConnectorBroadcast: false,
      },
    },
    modelTiering: {
      schemaVersion: 1,
      tiers: [...MODEL_TIERS],
      defaultPolicy: DEFAULT_COST_AWARE_TIERING_POLICY,
    },
    providers: [
      { id:'github-ci', version:1, available:true, templates:[template(ci)], requiredScope:'github_repository', approvalMode:'preauthorized_template_and_manual_result' },
      { ...PROJECT_REPORT_PROVIDER, available:true, reason:'Node must enforce project filesystem read-only; denied network isolation is not currently verified',
        templates:[template(report)], requiredScope:'entire_project', networkPolicies:{ deny:'requires_verified_isolation', inherit_existing_permissions:'requires_explicit_owner_confirmation' }, approvalMode:'preauthorized_template_and_manual_result' },
      { ...GENERIC_PLANNER_PROVIDER, available:true, reason:'Configuration is available; execution requires enabled services, node grants and verified isolation. Real execution is not yet validated.', templates:[template(planner)], requiredScope:'entire_project', approvalMode:'always' },
    ],
    connectorCatalogDescriptors: STAGE4_CONNECTOR_CAPABILITY_CATALOG,
    planCatalogDescriptors: [
      {
        capability: 'project-report',
        available: true,
        templateId: report.id,
        templateVersion: report.version,
        templateDigest: report.digest,
        requiredFields: ['resource.projectId','resource.readScope','resource.networkPolicy','nodeBindings.report.nodeId','nodeBindings.report.bindingGeneration','maxAttempts','maxCost'],
        autoEligible: true,
        requiresHumanApproval: true,
      },
      {
        capability: 'project-code',
        available: true,
        reason: 'Requires a verified local code baseline, scoped grants, registered check and human review; real execution is not yet validated',
        templateId: ci.id,
        templateVersion: ci.version,
        templateDigest: ci.digest,
        requiredFields: ['codeBaselineId','repositoryFactId','repository','targetBranch','allowedPaths','candidateScope','checkActionId','nodeBindings.implementation','nodeBindings.review','nodeBindings.integration','maxAttempts','maxCost'],
        autoEligible: false,
        requiresHumanApproval: true,
      },
      {
        capability: 'fanout',
        available: true,
        defaultOptIn: false,
        requiredCapabilityGate: 'capabilityGates.allowFanout',
        writeRequiresCapabilityGate: 'capabilityGates.allowWrite',
        reason: 'Requires explicit policy.capabilityGates.allowFanout=true; write slices require capabilityGates.allowWrite=true and path-disjoint allowedPaths intersection',
        templateId: STAGE2_FANOUT_READ_FORMULA.id,
        templateVersion: STAGE2_FANOUT_READ_FORMULA.version,
        templateDigest: fanoutReadDigest,
        supportedTemplateDigests: [fanoutReadDigest, fanoutWriteDigest],
        requiredFields: ['objective','accessMode','maxAttempts','maxCost','maxConcurrency','nodeBindings'],
        autoEligible: false,
        requiresHumanApproval: true,
      },
      {
        capability: 'swarm-collaboration',
        available: true,
        defaultOptIn: false,
        requiredCapabilityGate: 'capabilityGates.allowSwarm',
        writeRequiresCapabilityGate: 'capabilityGates.allowWrite',
        reason: 'Requires explicit policy.capabilityGates.allowSwarm=true and delegate-capable coordinator; write members require capabilityGates.allowWrite=true and isolated workspaces',
        templateId: STAGE2_SWARM_TEMPLATE.id,
        templateVersion: STAGE2_SWARM_TEMPLATE.version,
        templateDigest: swarmDigest,
        requiredFields: ['objective','accessMode','coordinator','members','nodeBindings','maxAttempts','maxCost'],
        autoEligible: false,
        requiresHumanApproval: true,
      },
      ...STAGE4_CONNECTOR_PLAN_DESCRIPTORS,
    ],
  };
}
