// Runtime selection for managed organization and collaboration Sessions.
//
// A plan may request a provider tool, model and effort, but the request is
// never authoritative by itself. The effective selection is the intersection
// of the child Agent policy, the parent delegation grant and the server-known
// tool/model catalog. The returned value is safe to freeze into a plan or a
// Session creation request.
import { getModelsForTool, getToolModelCatalogs } from './models.mjs';
import { getPricingMetadataForModel } from '../lib/model-pricing.mjs';
import { createProviderQuotaStore } from '../lib/provider-runtime/quota.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';

export const ORGANIZATION_RUNTIME_SELECTION_SCHEMA_VERSION = 1;

export const ORGANIZATION_RUNTIME_TOOLS = Object.freeze([
  'codex',
  'codex-cli',
  'claude',
  'claude-bidi',
  'agy',
]);

const TOOL_SET = new Set(ORGANIZATION_RUNTIME_TOOLS);

function text(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => text(entry)).filter(Boolean))].sort();
}

function mapOfLists(value) {
  const source = object(value);
  const result = {};
  for (const [key, entries] of Object.entries(source)) {
    const normalizedKey = text(key, 80).toLowerCase();
    const normalized = list(entries);
    if (normalizedKey && normalized.length > 0) result[normalizedKey] = normalized;
  }
  return result;
}

function providerFromModel(value) {
  const raw = text(value);
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return '';
  const candidate = raw.slice(at + 1);
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : '';
}

function clone(value, fallback = {}) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function intersect(left, right) {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const allowed = new Set(right);
  return left.filter((entry) => allowed.has(entry));
}

// Null means no constraint; an empty array means two real ceilings conflict.
function policyIntersection(left, right) {
  if (!left.length && !right.length) return null;
  if (!left.length) return [...right];
  if (!right.length) return [...left];
  const allowed = new Set(right);
  return left.filter((entry) => allowed.has(entry));
}

function modelPolicyIntersection(left, right) {
  if (!left.length && !right.length) return null;
  if (!left.length) return [...right];
  if (!right.length) return [...left];
  const result = [];
  for (const a of left) for (const b of right) {
    if (bareModel(a) !== bareModel(b)) continue;
    const ap = providerFromModel(a), bp = providerFromModel(b);
    if (ap && bp && ap !== bp) continue;
    const matched = ap ? a : bp ? b : a;
    if (!result.includes(matched)) result.push(matched);
  }
  return result;
}

function scopedValues(policy, key, tool) {
  const values = policy?.[key] && typeof policy[key] === 'object'
    ? policy[key][tool]
    : [];
  return Array.isArray(values) ? values : [];
}

function runtimeError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode: 422,
    ...details,
  });
}

async function discoverRuntimeProviders(tool) {
  const normalizedTool = text(tool, 80).toLowerCase();
  const agentType = normalizedTool === 'codex' || normalizedTool === 'codex-cli'
    ? 'codex'
    : normalizedTool === 'claude' || normalizedTool === 'claude-bidi'
      ? 'claude'
      : normalizedTool === 'agy'
        ? 'agy'
      : '';
  if (!agentType) return [];
  try {
    const { CONFIG_DIR } = await import('../lib/config.mjs');
    const { createNativeProviderRegistry } = await import('../lib/provider-runtime/index.mjs');
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    const profiles = await registry.listProviderProfiles();
    return profiles
      .filter((profile) => profile?.agentType === agentType)
      .map((profile) => profile.id);
  } catch {
    return [];
  }
}

export function normalizeRuntimeSelection(value = {}) {
  const source = object(value);
  const allowed = new Set(['tool', 'provider', 'providerProfile', 'model', 'effort']);
  const unknown = Object.keys(source).find((key) => !allowed.has(key));
  if (unknown) {
    throw runtimeError('ORG_RUNTIME_SELECTION_INVALID', `runtime contains an unknown field: ${unknown}`, {
      reason: 'unknown_field',
      field: `runtime.${unknown}`,
    });
  }
  const provider = text(source.provider || source.providerProfile, 160);
  const explicitProvider = text(source.provider, 160);
  const explicitProviderProfile = text(source.providerProfile, 160);
  if (explicitProvider && explicitProviderProfile && explicitProvider !== explicitProviderProfile) {
    throw runtimeError('ORG_RUNTIME_PROVIDER_CONFLICT', 'runtime.provider and runtime.providerProfile must match', {
      reason: 'provider_conflict',
      field: 'runtime.provider',
    });
  }
  return {
    ...(text(source.tool, 80) ? { tool: text(source.tool, 80).toLowerCase() } : {}),
    ...(provider ? { provider } : {}),
    ...(text(source.model) ? { model: text(source.model) } : {}),
    ...(text(source.effort, 80) ? { effort: text(source.effort, 80).toLowerCase() } : {}),
  };
}

export function normalizeRuntimePolicy(value = {}, { defaultTool = '' } = {}) {
  const source = object(value);
  const defaultSelection = normalizeRuntimeSelection(source.default || source.defaults || {});
  const allowedTools = list(
    source.allowedTools || source.tools || source.toolProfiles,
  ).map((tool) => tool.toLowerCase());
  const normalizedTools = [...new Set(allowedTools.filter((tool) => TOOL_SET.has(tool)))];
  const fallbackTool = text(defaultTool, 80).toLowerCase();
  const allowedProviders = list(
    source.allowedProviders || source.providers || source.providerProfiles,
  );
  const providersByTool = mapOfLists(
    source.allowedProvidersByTool || source.providersByTool || source.providerProfilesByTool,
  );
  const modelsByTool = mapOfLists(source.allowedModelsByTool || source.modelsByTool);
  const effortsByTool = mapOfLists(source.allowedEffortsByTool || source.effortsByTool);
  return {
    schemaVersion: ORGANIZATION_RUNTIME_SELECTION_SCHEMA_VERSION,
    allowedTools: normalizedTools.length > 0
      ? normalizedTools
      : (TOOL_SET.has(fallbackTool) ? [fallbackTool] : []),
    allowedProviders,
    allowedProvidersByTool: providersByTool,
    allowedModels: list(source.allowedModels || source.models),
    allowedEfforts: list(source.allowedEfforts || source.efforts).map((effort) => effort.toLowerCase()),
    allowedModelsByTool: modelsByTool,
    allowedEffortsByTool: effortsByTool,
    ...(Object.keys(defaultSelection).length > 0 ? { default: defaultSelection } : {}),
  };
}

export function runtimePolicyForProfile(profile = {}) {
  const runtimeProfile = object(profile.runtimeProfile);
  return normalizeRuntimePolicy(
    profile.runtimePolicy || profile.policy?.runtimePolicy || {},
    {
      defaultTool: runtimeProfile.toolId || profile.toolId || profile.tool,
    },
  );
}

export function runtimePolicyForGrant(grant = {}) {
  return normalizeRuntimePolicy(grant.runtimePolicy || grant.runtime || {});
}

export function runtimePolicyHasConstraints(policy = {}) {
  const source = object(policy);
  const listKeys = ['allowedTools', 'allowedProviders', 'allowedModels', 'allowedEfforts'];
  if (listKeys.some((key) => Array.isArray(source[key]) && source[key].length > 0)) return true;
  return ['allowedProvidersByTool', 'allowedModelsByTool', 'allowedEffortsByTool'].some((key) => (
    Object.values(object(source[key])).some((values) => Array.isArray(values) && values.length > 0)
  ));
}

function modelIds(catalog) {
  return Array.isArray(catalog?.models)
    ? catalog.models.map((entry) => text(entry?.id)).filter(Boolean)
    : [];
}

function bareModel(value) {
  const raw = text(value);
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return raw;
  const candidate = raw.slice(at + 1);
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? raw.slice(0, at) : raw;
}

function modelEntry(catalog, model, provider = '') {
  if (!Array.isArray(catalog?.models)) return null;
  const exact = catalog.models.find((entry) => text(entry?.id) === model);
  if (exact) return exact;
  const bare = bareModel(model);
  return catalog.models.find((entry) => {
    const entryId = text(entry?.id);
    return bareModel(entryId) === bare && (!provider || providerFromModel(entryId) === provider);
  }) || null;
}

function effortLevels(catalog, model, provider = '') {
  const entry = modelEntry(catalog, model, provider);
  if (Array.isArray(entry?.effortLevels) && entry.effortLevels.length > 0) {
    return list(entry.effortLevels).map((effort) => effort.toLowerCase());
  }
  return list(catalog?.effortLevels).map((effort) => effort.toLowerCase());
}

function assertAllowed(value, allowed, code, label, details = {}) {
  if (value && allowed !== null && !allowed.includes(value)) {
    throw runtimeError(code, `${label} is outside the delegated runtime policy`, {
      reason: 'runtime_policy_denied',
      field: label,
      value,
      ...details,
    });
  }
}

function assertModelAllowed(value, allowed, details = {}) {
  if (!value || allowed === null) return;
  const requested = bareModel(value);
  if (allowed.some((entry) => {
    if (bareModel(entry) !== requested) return false;
    const requiredProvider = providerFromModel(entry);
    const actualProvider = providerFromModel(value) || details.provider || '';
    return !requiredProvider || requiredProvider === actualProvider;
  })) return;
  throw runtimeError('ORG_RUNTIME_MODEL_DENIED', 'runtime.model is outside the delegated runtime policy', {
    reason: 'runtime_policy_denied',
    field: 'runtime.model',
    value,
    ...details,
  });
}

/**
 * Resolve one effective selection. `parentGrant` is optional for Root
 * Leadership; when present it is a ceiling, never an additional grant.
 */
export async function resolveRuntimeSelection({
  requested = {},
  profile = {},
  parentGrant = {},
  getModels = getModelsForTool,
  getTool = getToolDefinitionAsync,
  getProviders = discoverRuntimeProviders,
} = {}) {
  const selection = normalizeRuntimeSelection(requested);
  const childPolicy = runtimePolicyForProfile(profile);
  const parentPolicy = runtimePolicyForGrant(parentGrant);
  const allowedTools = policyIntersection(childPolicy.allowedTools, parentPolicy.allowedTools);
  const requestedTool = selection.tool
    || childPolicy.default?.tool
    || text(profile.runtimeProfile?.toolId || profile.toolId || profile.tool, 80).toLowerCase();
  if (!requestedTool) {
    throw runtimeError('ORG_RUNTIME_TOOL_REQUIRED', 'managed runtime selection requires a tool', {
      reason: 'tool_required',
    });
  }
  if (!TOOL_SET.has(requestedTool)) {
    throw runtimeError('ORG_RUNTIME_TOOL_UNSUPPORTED', `unsupported organization runtime tool: ${requestedTool}`, {
      reason: 'unsupported_tool',
      tool: requestedTool,
    });
  }
  assertAllowed(requestedTool, allowedTools, 'ORG_RUNTIME_TOOL_DENIED', 'runtime.tool', { tool: requestedTool });

  const childProviders = [
    ...childPolicy.allowedProviders,
    ...scopedValues(childPolicy, 'allowedProvidersByTool', requestedTool),
  ];
  const parentProviders = [
    ...parentPolicy.allowedProviders,
    ...scopedValues(parentPolicy, 'allowedProvidersByTool', requestedTool),
  ];
  const providerCeiling = policyIntersection(childProviders, parentProviders);

  if (providerCeiling?.length === 0) {
    throw runtimeError('ORG_RUNTIME_PROVIDER_DENIED', 'parent and child runtime provider policies have no permitted intersection', { reason: 'runtime_policy_denied', field: 'runtime.provider' });
  }

  const childModels = intersect(
    [...childPolicy.allowedModels, ...scopedValues(childPolicy, 'allowedModelsByTool', requestedTool)],
    [],
  );
  const parentModels = intersect(
    [...parentPolicy.allowedModels, ...scopedValues(parentPolicy, 'allowedModelsByTool', requestedTool)],
    [],
  );
  // An empty policy list means "no policy at this layer". A non-empty list is
  // a real ceiling; use the intersection only when both layers constrain it.
  const childModelCeiling = childModels.length > 0 ? childModels : [];
  const parentModelCeiling = parentModels.length > 0 ? parentModels : [];
  const modelCeiling = modelPolicyIntersection(childModelCeiling, parentModelCeiling);
  if (modelCeiling?.length === 0) {
    throw runtimeError('ORG_RUNTIME_MODEL_DENIED', 'parent and child runtime model policies have no permitted intersection', { reason: 'runtime_policy_denied', field: 'runtime.model' });
  }

  const requestedModel = selection.model || childPolicy.default?.model || '';
  const modelProvider = providerFromModel(requestedModel);
  const requestedProvider = selection.provider
    || childPolicy.default?.provider
    || modelProvider
    || (providerCeiling?.length === 1 ? providerCeiling[0] : '');
  if (modelProvider && requestedProvider && modelProvider !== requestedProvider) {
    throw runtimeError('ORG_RUNTIME_PROVIDER_MODEL_CONFLICT', 'runtime.model provider scope does not match runtime.provider', {
      reason: 'provider_model_conflict',
      tool: requestedTool,
      provider: requestedProvider,
      model: requestedModel,
    });
  }
  assertAllowed(requestedProvider, providerCeiling, 'ORG_RUNTIME_PROVIDER_DENIED', 'runtime.provider', {
    tool: requestedTool,
    provider: requestedProvider,
  });

  const catalog = await getModels(requestedTool).catch(() => null);
  let availableProviders = Array.isArray(catalog?.providers)
    ? list(catalog.providers.map((entry) => (typeof entry === 'string' ? entry : entry?.id)))
    : [];
  if (typeof getProviders === 'function') {
    const discovered = await getProviders(requestedTool).catch(() => []);
    const discoveredProviders = list((Array.isArray(discovered) ? discovered : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id)));
    if (discoveredProviders.length > 0) availableProviders = discoveredProviders;
  }
  if (availableProviders.length === 0) {
    availableProviders = list(modelIds(catalog).map(providerFromModel));
  }
  if (requestedProvider && availableProviders.length > 0 && !availableProviders.includes(requestedProvider)) {
    throw runtimeError('ORG_RUNTIME_PROVIDER_UNAVAILABLE', `provider ${requestedProvider} is not available for ${requestedTool}`, {
      reason: 'provider_unavailable',
      tool: requestedTool,
      provider: requestedProvider,
    });
  }
  assertModelAllowed(requestedModel, modelCeiling, { tool: requestedTool, provider: requestedProvider });

  const availableModels = modelIds(catalog);
  const availableBareModels = availableModels.map(bareModel);
  if (requestedModel && availableModels.length > 0
      && !availableModels.includes(requestedModel)
      && !availableBareModels.includes(bareModel(requestedModel))) {
    throw runtimeError('ORG_RUNTIME_MODEL_UNAVAILABLE', `model ${requestedModel} is not available for ${requestedTool}`, {
      reason: 'model_unavailable',
      tool: requestedTool,
      model: requestedModel,
    });
  }

  const childEfforts = intersect(
    [...childPolicy.allowedEfforts, ...scopedValues(childPolicy, 'allowedEffortsByTool', requestedTool)],
    [],
  ).map((effort) => effort.toLowerCase());
  const parentEfforts = intersect(
    [...parentPolicy.allowedEfforts, ...scopedValues(parentPolicy, 'allowedEffortsByTool', requestedTool)],
    [],
  ).map((effort) => effort.toLowerCase());
  const effortPolicy = policyIntersection(childEfforts, parentEfforts);
  if (effortPolicy?.length === 0) {
    throw runtimeError('ORG_RUNTIME_EFFORT_DENIED', 'parent and child runtime effort policies have no permitted intersection', { reason: 'runtime_policy_denied', field: 'runtime.effort' });
  }

  const requestedEffort = selection.effort || childPolicy.default?.effort || '';
  assertAllowed(requestedEffort, effortPolicy, 'ORG_RUNTIME_EFFORT_DENIED', 'runtime.effort', { tool: requestedTool });
  const catalogEfforts = effortLevels(catalog, requestedModel, requestedProvider);
  if (requestedEffort && catalogEfforts.length > 0 && !catalogEfforts.includes(requestedEffort)) {
    throw runtimeError('ORG_RUNTIME_EFFORT_UNAVAILABLE', `effort ${requestedEffort} is not available for ${requestedTool}/${requestedModel || 'default model'}`, {
      reason: 'effort_unavailable',
      tool: requestedTool,
      model: requestedModel,
      effort: requestedEffort,
    });
  }

  const toolDefinition = typeof getTool === 'function' ? await getTool(requestedTool).catch(() => null) : null;
  return {
    schemaVersion: ORGANIZATION_RUNTIME_SELECTION_SCHEMA_VERSION,
    tool: requestedTool,
    ...(requestedProvider ? { provider: requestedProvider } : {}),
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(requestedEffort ? { effort: requestedEffort } : {}),
    ...(text(toolDefinition?.runtimeFamily) ? { runtimeFamily: text(toolDefinition.runtimeFamily, 120) } : {}),
  };
}

export async function buildOrganizationRuntimeCatalog({
  tools = ORGANIZATION_RUNTIME_TOOLS,
  getTool = getToolDefinitionAsync,
  getModels = getModelsForTool,
  getProviders = discoverRuntimeProviders,
  getCatalogs = getToolModelCatalogs,
  quotaStore = createProviderQuotaStore({ configDir: CONFIG_DIR }),
} = {}) {
  const catalog = [];
  for (const rawTool of list(tools)) {
    const tool = rawTool.toLowerCase();
    if (!TOOL_SET.has(tool)) continue;
    const definition = typeof getTool === 'function' ? await getTool(tool).catch(() => null) : null;
    const models = typeof getModels === 'function' ? await getModels(tool).catch(() => null) : null;
    let providers = Array.isArray(models?.providers)
      ? list(models.providers.map((entry) => (typeof entry === 'string' ? entry : entry?.id)))
      : [];
    if (typeof getProviders === 'function') {
      const discovered = await getProviders(tool).catch(() => []);
      const discoveredProviders = list((Array.isArray(discovered) ? discovered : [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.id)));
      if (discoveredProviders.length > 0) providers = discoveredProviders;
    }
    if (providers.length === 0) providers = list((models?.models || []).map((entry) => providerFromModel(entry?.id)));
    const providerCatalogs = typeof getCatalogs === 'function'
      ? await getCatalogs(tool, '', { fast: true }).catch(() => []) : [];
    const evidence = await Promise.all(providerCatalogs.map(async (entry) => {
      const quota = entry.providerProfileId && quotaStore
        ? await quotaStore.get(entry.providerProfileId).catch(() => null) : null;
      return {
        providerProfileId: entry.providerProfileId, source: entry.source,
        status: entry.status, catalogVersion: entry.catalogVersion,
        fetchedAt: entry.fetchedAt || null, expiresAt: entry.expiresAt || null,
        quota: quota ? { status: quota.status, checkedAt: quota.checkedAt || null,
          fetchedAt: quota.fetchedAt || null, mode: quota.mode || null,
          windows: (Array.isArray(quota.windows) ? quota.windows : []).slice(0, 8).map((window) => ({
            id: window.id, remainingPercent: window.remainingPercent, resetsAt: window.resetsAt || null,
          })),
          ...(quota.balance ? { balance: { remaining: quota.balance.remaining, currency: quota.balance.currency } } : {}),
        } : { status: 'unknown' },
        models: (entry.models || []).map((model) => {
          const pricing = getPricingMetadataForModel(model.model, { tool });
          return { id: model.id, model: model.model, providerProfileId: model.providerProfileId,
            capabilities: model.capabilities || null,
            pricing: pricing ? { ...pricing, kind: 'estimate', source: 'static_table', asOf: null } : { kind: 'unknown' } };
        }),
      };
    }));
    catalog.push({
      tool,
      providerCatalogs: evidence,
      ...(text(definition?.runtimeFamily) ? { runtimeFamily: text(definition.runtimeFamily, 120) } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      models: (Array.isArray(models?.models) ? models.models : []).slice(0, 128).map((entry) => ({
        id: text(entry?.id),
        ...(text(entry?.label) ? { label: text(entry.label, 160) } : {}),
        ...(Array.isArray(entry?.effortLevels) && entry.effortLevels.length > 0
          ? { effortLevels: list(entry.effortLevels).map((effort) => effort.toLowerCase()) }
          : {}),
      })).filter((entry) => entry.id),
      effortLevels: list(models?.effortLevels).map((effort) => effort.toLowerCase()),
    });
  }
  return catalog;
}

export { TOOL_SET };
