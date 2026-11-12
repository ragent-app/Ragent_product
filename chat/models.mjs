import { filterWorkbenchModels, workbenchToolAllowed } from '../lib/workbench-execution-policy.mjs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { CODEX_MANAGED_HOME_DIR, CONFIG_DIR } from '../lib/config.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { CODEX_SERVICE_TIER_OPTIONS } from '../lib/codex-service-tier.mjs';
import { AGY_EFFORT_LEVELS, listAgyModels } from '../lib/agy-manager.mjs';
import { lookupModelContextWindowTokens } from './model-context-windows.mjs';
import { normalizeModelCatalog, sourceFromModelOrigins } from '../lib/provider-runtime/model-catalog.mjs';
import { getHarnessProviderProtocols } from '../lib/provider-runtime/harness-bridge.mjs';
import { getHarnessDefinition, listHarnesses } from '../lib/harness-registry.mjs';

const codexModelsCache = new Map();
const agyModelsCache = new Map();
const agyModelRefreshes = new Map();
const MODEL_CATALOG_CACHE_MAX_ENTRIES = 128;

function cacheGet(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

function cacheSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MODEL_CATALOG_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

// Provider model discovery is an upstream fan-out. Keep the request window
// small and deterministic so a large credential catalog cannot create one
// socket/timer per provider or reorder the model picker by response latency.
async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];
  const results = new Array(source.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(source[index], index);
    }
  };
  await Promise.all(Array.from({
    length: Math.min(Math.max(1, concurrency), source.length),
  }, () => worker()));
  return results;
}

const CODEX_DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_GPT_56_EFFORT_LEVELS = [...CODEX_DEFAULT_EFFORT_LEVELS, 'max'];
const CODEX_GPT_56_SOL_EFFORT_LEVELS = [...CODEX_GPT_56_EFFORT_LEVELS, 'ultra'];
const CODEX_GPT_6_ASTRA_EFFORT_LEVELS = [...CODEX_GPT_56_SOL_EFFORT_LEVELS];
const AGY_MODEL_CACHE_TTL_MS = 120_000;
const BRIDGED_HARNESS_IDS = new Set(['pi', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes']);
const TOOL_HARNESS_ALIASES = Object.freeze({
  'claude-bidi': 'claude',
  'codex-cli': 'codex',
});

function refreshAgyModelsInBackground(providerProfile = '') {
  const key = providerProfile || '*';
  if (agyModelRefreshes.has(key)) return agyModelRefreshes.get(key);
  const promise = getModelsForTool('agy', { providerProfile, fast: false })
    .catch(() => null)
    .finally(() => agyModelRefreshes.delete(key));
  agyModelRefreshes.set(key, promise);
  promise.catch(() => {});
  return promise;
}

const MODEL_EFFORT_LEVEL_PATHS = [
  'supported_effort_levels',
  'supportedEffortLevels',
  'effort_levels',
  'effortLevels',
  'supported_reasoning_levels',
  'supportedReasoningLevels',
  'reasoning_effort_levels',
  'reasoningEffortLevels',
  'reasoning_levels',
  'reasoningLevels',
  'supported_reasoning_efforts',
  'supportedReasoningEfforts',
  'supported_efforts',
  'supportedEfforts',
  'reasoning.levels',
  'reasoning.supported_levels',
  'reasoning.supportedLevels',
  'effort.levels',
  'effort.supported_levels',
  'effort.supportedLevels',
  'capabilities.reasoning.levels',
  'capabilities.reasoning.supported_levels',
  'capabilities.reasoning.supportedLevels',
  'capabilities.supported_reasoning_levels',
  'capabilities.supportedReasoningLevels',
  'capabilities.effort_levels',
  'capabilities.effortLevels',
  'capabilities.effort.levels',
  'capabilities.effort.supported_levels',
  'capabilities.effort.supportedLevels',
];

const MODEL_EFFORT_SUPPORT_PATHS = [
  'supports_reasoning',
  'supportsReasoning',
  'reasoning_supported',
  'reasoningSupported',
  'supports_effort',
  'supportsEffort',
  'supports_reasoning_effort',
  'supportsReasoningEffort',
  'reasoning.supported',
  'effort.supported',
  'capabilities.supports_reasoning',
  'capabilities.supportsReasoning',
  'capabilities.supports_effort',
  'capabilities.supportsEffort',
  'capabilities.reasoning.supported',
  'capabilities.effort.supported',
];

const MODEL_EFFORT_DEFAULT_PATHS = [
  'default_effort',
  'defaultEffort',
  'default_reasoning',
  'defaultReasoning',
  'reasoning.default',
  'reasoning.default_effort',
  'reasoning.defaultEffort',
  'effort.default',
  'capabilities.reasoning.default',
  'capabilities.effort.default',
];

const MODEL_SERVICE_TIER_PATHS = [
  'service_tiers',
  'serviceTiers',
  'supported_service_tiers',
  'supportedServiceTiers',
  'service_tier_options',
  'serviceTierOptions',
  'serviceTier.values',
  'serviceTier.tiers',
  'capabilities.service_tiers',
  'capabilities.serviceTiers',
  'capabilities.serviceTier.values',
  'capabilities.serviceTier.tiers',
];

const MODEL_FAST_SUPPORT_PATHS = [
  'supports_fast',
  'supportsFast',
  'supports_service_tier_fast',
  'supportsServiceTierFast',
  'fast_mode',
  'fastMode',
  'serviceTier.supportsFast',
  'service_tier.supports_fast',
  'capabilities.serviceTier.supportsFast',
  'capabilities.service_tier.supports_fast',
  'capabilities.supports_fast',
  'capabilities.supportsFast',
  'capabilities.fast',
];

const MODEL_SERVICE_TIER_VALUE_PATHS = [
  'service_tier',
  'serviceTier',
  'capabilities.serviceTier',
  'capabilities.service_tier',
];

function readPath(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

function firstDefinedPath(value, paths) {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  return null;
}

function normalizeCapabilityList(value, { serviceTiers = false } = {}) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[\s,]+/) : []);
  const normalized = [];
  for (const item of values) {
    const raw = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? item.id || item.name || item.value : '');
    const candidate = String(raw || '').trim().toLowerCase();
    if (!candidate || candidate.length > 64 || normalized.includes(candidate)) continue;
    if (serviceTiers && !['standard', 'fast'].includes(candidate)) continue;
    normalized.push(candidate);
  }
  return normalized;
}

function publicModelCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const effort = capabilities.effort && typeof capabilities.effort === 'object'
    ? capabilities.effort
    : null;
  const serviceTier = capabilities.serviceTier && typeof capabilities.serviceTier === 'object'
    ? capabilities.serviceTier
    : null;
  if (!effort && !serviceTier) return null;
  return {
    ...(effort ? {
      effort: {
        supported: effort.supported === true ? true : effort.supported === false ? false : null,
        levels: Array.isArray(effort.levels) ? [...effort.levels] : [],
        ...(effort.default ? { default: effort.default } : {}),
        source: String(effort.source || 'unknown'),
      },
    } : {}),
    ...(serviceTier ? {
      serviceTier: {
        supportsFast: serviceTier.supportsFast === true ? true : serviceTier.supportsFast === false ? false : null,
        values: Array.isArray(serviceTier.values) ? [...serviceTier.values] : ['standard'],
        source: String(serviceTier.source || 'unknown'),
      },
    } : {}),
  };
}

// OpenAI and Anthropic do not standardize effort or service-tier fields in
// their model-list responses.  Gateways commonly expose one of the aliases
// below, so normalize them without claiming support when none is present.
export function parseModelCapabilities(entry, { source = 'upstream' } = {}) {
  const model = entry && typeof entry === 'object' ? entry : {};
  const effortLevels = normalizeCapabilityList(firstDefinedPath(model, MODEL_EFFORT_LEVEL_PATHS));
  const effortSupport = normalizeBoolean(firstDefinedPath(model, MODEL_EFFORT_SUPPORT_PATHS));
  const defaultEffortRaw = firstDefinedPath(model, MODEL_EFFORT_DEFAULT_PATHS);
  const defaultEffort = typeof defaultEffortRaw === 'string'
    ? defaultEffortRaw.trim().toLowerCase()
    : '';
  const effort = {
    supported: effortLevels.length > 0 ? true : effortSupport,
    levels: effortLevels,
    ...(effortLevels.includes(defaultEffort) ? { default: defaultEffort } : {}),
    source,
  };

  const serviceTierValues = normalizeCapabilityList(
    firstDefinedPath(model, MODEL_SERVICE_TIER_PATHS),
    { serviceTiers: true },
  );
  const directServiceTier = firstDefinedPath(model, MODEL_SERVICE_TIER_VALUE_PATHS);
  const directServiceTierName = typeof directServiceTier === 'string'
    ? directServiceTier.trim().toLowerCase()
    : '';
  if (directServiceTierName === 'fast' && !serviceTierValues.includes('fast')) serviceTierValues.push('fast');
  if (directServiceTierName === 'standard' && !serviceTierValues.includes('standard')) serviceTierValues.push('standard');
  const fastSupport = normalizeBoolean(firstDefinedPath(model, MODEL_FAST_SUPPORT_PATHS));
  const serviceTier = {
    supportsFast: serviceTierValues.length > 0 ? serviceTierValues.includes('fast') : fastSupport,
    values: [...new Set(['standard', ...serviceTierValues])],
    source,
  };
  if (serviceTier.supportsFast === true && !serviceTier.values.includes('fast')) serviceTier.values.push('fast');
  return { effort, serviceTier };
}

function reasoningFromCapabilities(capabilities) {
  const effort = capabilities?.effort;
  if (effort?.supported === true && Array.isArray(effort.levels) && effort.levels.length > 0) {
    const defaultEffort = effort.levels.includes(effort.default)
      ? effort.default
      : (effort.levels.includes('medium') ? 'medium' : effort.levels[0]);
    return {
      kind: 'enum',
      label: 'Thinking',
      levels: [...effort.levels],
      default: defaultEffort,
    };
  }
  if (effort?.supported === false) return { kind: 'none', label: 'Thinking' };
  return null;
}

function cloneReasoning(reasoning, fallbackLabel = 'Thinking') {
  if (!reasoning || typeof reasoning !== 'object') return null;
  const kind = String(reasoning.kind || '').trim().toLowerCase();
  const label = String(reasoning.label || fallbackLabel).trim() || fallbackLabel;
  if (kind === 'enum') {
    const levels = [...new Set(
      (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((level) => String(level || '').trim())
        .filter(Boolean),
    )];
    if (levels.length === 0) return null;
    const defaultValue = String(
      reasoning.default
      || reasoning.defaultReasoning
      || reasoning.defaultEffort
      || levels[0],
    ).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === 'toggle' || kind === 'none') {
    return { kind, label };
  }
  return null;
}

function buildModelReasoning(model, fallbackReasoning = null) {
  const fallbackLabel = String(fallbackReasoning?.label || 'Thinking').trim() || 'Thinking';
  // Prefer explicit reasoning object on the model.
  if (model?.reasoning && typeof model.reasoning === 'object') {
    return cloneReasoning(model.reasoning, fallbackLabel);
  }
  // Fall back to flat fields: supportedReasoningLevels + reasoningKind.
  const levels = Array.isArray(model?.supportedReasoningLevels)
    ? model.supportedReasoningLevels
    : Array.isArray(model?.effortLevels) ? model.effortLevels : [];
  const kind = String(model?.reasoningKind || '').trim().toLowerCase();
  if (levels.length > 0) {
    return cloneReasoning({
      kind: 'enum',
      label: fallbackLabel,
      levels,
      default: model.defaultReasoning || levels[0],
    }, fallbackLabel);
  }
  if (kind === 'toggle') {
    return cloneReasoning({ kind: 'toggle', label: fallbackLabel }, fallbackLabel);
  }
  if (kind === 'none') {
    return cloneReasoning({ kind: 'none', label: fallbackLabel }, fallbackLabel);
  }
  return cloneReasoning(fallbackReasoning, fallbackLabel);
}

function buildResponseModel(model, fallbackReasoning = null) {
  const reasoning = buildModelReasoning(model, fallbackReasoning);
  const capabilities = publicModelCapabilities(model?.capabilities);
  return {
    id: model.id,
    label: model.label,
    ...(Number.isFinite(model?.contextWindow) && model.contextWindow > 0
      ? { contextWindow: Math.floor(model.contextWindow) }
      : {}),
    ...(Array.isArray(model?.serviceTiers) && model.serviceTiers.includes('fast')
      ? { serviceTiers: [...model.serviceTiers] }
      : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning?.kind === 'enum'
      ? {
        defaultEffort: reasoning.default,
        effortLevels: [...reasoning.levels],
      }
      : {}),
  };
}

/**
 * Returns { models, effortLevels } for a given tool.
 * - models: [{ id, label, defaultEffort?, effortLevels? }]
 * - effortLevels: string[] | null (null means tool uses a binary thinking toggle)
 */

// Native mode: enumerate claude provider profiles from the registry and show
// each provider's tier-alias resolutions as separate entries
// (`alias@providerId`), mirroring how codex models are scoped per provider.
// The run launcher accepts `options.providerProfile` for provider selection,
// so the id keeps the codex `model@providerId` uniqueness contract.
async function getNativeClaudeModels(providerProfile = '', { allowNetwork = true } = {}) {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const secretStore = createSecretStore({ configDir: CONFIG_DIR });
  const profiles = (await registry.listProviderProfiles().catch(() => []))
    .filter((profile) => !providerProfile || profile.id === providerProfile);
  const levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const models = [];
  for (const profile of profiles) {
    if (profile.agentType !== 'claude') continue;
    const authProfile = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    // Legacy rotating Claude OAuth profiles remain readable for migration, but
    // must not advertise runnable models after the mode was removed.
    if (authProfile?.authType === 'oauth') continue;
    const policy = profile.modelPolicy && typeof profile.modelPolicy === 'object'
      ? profile.modelPolicy
      : {};
    const aliasTargets = {
      sonnet: policy.sonnet || policy.defaultModel || '',
      opus: policy.opus || policy.defaultModel || '',
      haiku: policy.haiku || policy.defaultModel || '',
    };
    const configuredModels = Array.isArray(policy.models) ? policy.models : [];
    const configuredById = new Map(
      configuredModels
        .filter((entry) => entry && typeof entry === 'object' && String(entry.id || '').trim())
        .map((entry) => [String(entry.id).trim(), entry]),
    );
    // Prefer the provider's live `/v1/models` catalog: one Claude relay
    // config exposes every Claude-Code-usable model it serves, not just the
    // three tier aliases.  api-key rows only (OAuth official has no
    // list endpoint on this shape).
    let discovered = null;
    if (authProfile?.authType === 'api-key') {
      const resolvedSecret = await secretStore.resolveSecret(authProfile.storageRef).catch(() => null);
      const apiKey = resolvedSecret?.ok && resolvedSecret.authType === 'api-key'
        ? resolvedSecret.apiKey
        : '';
      if (apiKey && profile.baseUrl) {
        discovered = await fetchProviderModelList({
          meta: { apiFormat: 'anthropic' },
          settingsConfig: {
            config: `base_url = "${profile.baseUrl}"\n`,
            auth: { OPENAI_API_KEY: apiKey },
          },
        }, { allowNetwork });
      }
    }
    const seen = new Set();
    // Claude Code recognizes a `[1m]` suffix on --model to opt into the 1M
    // context variant.  The suffix survives the whole chain: it contains no
    // '@' so parseScopedCodexModel/resolveClaudeRuntimeModelAlias keep the id
    // whole and only strip the provider scope.  Raw tier aliases
    // (sonnet/opus/haiku) must never get it — the suffix would break their
    // env-key lookup in resolveClaudeRuntimeModelAlias.
    const pushModel = (id, label, contextWindow = null, modelEntry = null) => {
      if (seen.has(id)) return;
      seen.add(id);
      const window = contextWindow || lookupModelContextWindowTokens(id);
      const supportsLongContext = window !== null && window >= 1_000_000;
      const configured = configuredById.get(id) || configuredById.get(`${id}[1m]`);
      let capabilities = modelEntry?.capabilities
        ? parseModelCapabilities(modelEntry, { source: 'upstream' })
        : parseModelCapabilities(configured || {}, { source: 'configured' });
      // Use Harness defaults when the provider does not publish effort levels.
      if (capabilities.effort.supported !== false && capabilities.effort.levels.length === 0) {
        capabilities = { ...capabilities, effort: {
          supported: true, levels: [...levels], default: 'medium', source: 'builtin',
        } };
      }
      const reasoning = reasoningFromCapabilities(capabilities);
      models.push({
        id: `${id}${supportsLongContext ? '[1m]' : ''}@${profile.id}`,
        label: label || id,
        ...(window !== null ? { contextWindow: window } : {}),
        capabilities: publicModelCapabilities({ effort: capabilities.effort }),
        ...(reasoning ? {
          reasoning,
          ...(reasoning.kind === 'enum' ? {
            defaultEffort: reasoning.default,
            effortLevels: [...reasoning.levels],
          } : {}),
        } : {}),
      });
    };
    if (Array.isArray(discovered) && discovered.length > 0) {
      for (const entry of discovered) pushModel(entry.id, entry.label, entry.contextWindow, entry);
      continue;
    }
    for (const tier of ['sonnet', 'opus', 'haiku']) {
      const target = String(aliasTargets[tier] || '').trim();
      if (!target || seen.has(target)) continue;
      pushModel(target, target, null, configuredById.get(target));
    }
    // A provider without any model env (OAuth official rows import bare) still
    // needs selectable tiers; expose the raw aliases so the CLI resolves them.
    if (seen.size === 0) {
      for (const tier of ['sonnet', 'opus', 'haiku']) pushModel(tier, tier);
    }
  }
  const discoveredLevels = [...new Set(models.flatMap((model) => model.effortLevels || []))];
  const reasoning = discoveredLevels.length > 0
    ? {
      kind: 'enum',
      label: 'Thinking',
      levels: discoveredLevels,
      default: discoveredLevels.includes('medium') ? 'medium' : discoveredLevels[0],
    }
    : { kind: 'none', label: 'Thinking' };
  return {
    models,
    effortLevels: discoveredLevels.length > 0 ? discoveredLevels : null,
    defaultModel: null,
    reasoning,
  };
}

// Third-party Harnesses use a native ProviderProfile as their source of
// credentials, but must expose a separate catalog because the same profile
// can be selected by more than one Harness.  Keep this projection read-only:
// the secret is used only for the existing in-memory /models probe and is
// never returned to the caller.
async function getBridgedHarnessModels(harnessId, providerProfile = '', { allowNetwork = true } = {}) {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const secretStore = createSecretStore({ configDir: CONFIG_DIR });
  const profiles = (await registry.listProviderProfiles().catch(() => []))
    .filter((profile) => !providerProfile || profile.id === providerProfile);
  const models = [];
  const seen = new Set();
  const supportedProtocols = new Set(getHarnessProviderProtocols(harnessId));

  for (const profile of profiles) {
    if (!profile?.id || !supportedProtocols.has(String(profile.protocol || '').trim().toLowerCase())) continue;
    if (harnessId === 'copilot' && String(profile.protocol || '').trim().toLowerCase() === 'github-copilot'
        && profile.agentType !== 'copilot') continue;
    const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    if (auth?.authType !== 'api-key') continue;
    const secret = await secretStore.resolveSecret(auth.storageRef).catch(() => null);
    if (!secret?.ok || secret.authType !== 'api-key' || !secret.apiKey) continue;

    const configured = Array.isArray(profile.modelPolicy?.models)
      ? profile.modelPolicy.models
        .map((entry) => typeof entry === 'string' ? { id: entry } : entry)
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
      : [];
    const defaultModel = String(profile.modelPolicy?.defaultModel || '').trim();
    const apiFormat = String(profile.protocol || '').toLowerCase() === 'anthropic-messages'
      ? 'anthropic'
      : 'openai';
    const row = {
      id: profile.id,
      name: profile.displayName || profile.id,
      meta: { apiFormat },
      settingsConfig: {
        config: `base_url = ${JSON.stringify(profile.baseUrl || '')}\n`,
        auth: { OPENAI_API_KEY: secret.apiKey },
      },
    };
    // A GitHub Copilot PAT authenticates the Copilot service, not an OpenAI
    // compatible /models endpoint. Only use the explicit model policy for
    // this protocol; probing it would be both misleading and unauthorized.
    const discovered = harnessId === 'copilot' && String(profile.protocol || '').trim().toLowerCase() === 'github-copilot'
      ? []
      : await fetchProviderModelList(row, { allowNetwork });
    const entries = discovered?.length ? discovered : (configured.length
      ? configured
      : (defaultModel ? [{ id: defaultModel }] : []));
    for (const entry of entries) {
      const id = String(entry?.id || '').trim();
      if (!id) continue;
      const scopedId = `${id}@${profile.id}`;
      if (seen.has(scopedId)) continue;
      seen.add(scopedId);
      models.push(buildResponseModel({
        ...entry,
        id: scopedId,
        label: `${String(entry.label || id).trim()} · ${profile.displayName || profile.id}`,
      }));
    }
  }

  const effortLevels = [...new Set(models.flatMap((model) => model.effortLevels || []))];
  return {
    models,
    effortLevels: effortLevels.length ? effortLevels : null,
    defaultModel: models[0]?.id || null,
    reasoning: effortLevels.length
      ? { kind: 'enum', label: 'Thinking', levels: effortLevels, default: effortLevels[0] }
      : { kind: 'none', label: 'Thinking' },
  };
}

export async function getModelsForTool(toolId, options = {}) {
  if (!workbenchToolAllowed(toolId)) return filterWorkbenchModels({ models: [], defaultModel: null }, toolId);
  return filterWorkbenchModels(await getUnrestrictedModelsForTool(toolId, options), toolId);
}

async function getUnrestrictedModelsForTool(toolId, { providerProfile = '', fast = false } = {}) {
  const normalizedToolId = String(toolId || '').trim();
  const selectedProviderProfile = String(providerProfile || '').trim();
  const harnessId = TOOL_HARNESS_ALIASES[normalizedToolId] || normalizedToolId;
  const harness = fast
    ? (await listHarnesses({ fast })).find((entry) => entry.id === harnessId)
    : await getHarnessDefinition(harnessId);
  if (harness && harness.installed !== true) {
    return {
      models: [],
      effortLevels: null,
      defaultModel: null,
      reasoning: { kind: 'none', label: 'Thinking' },
    };
  }
  if (toolId === 'claude' || toolId === 'claude-bidi') {
    return getNativeClaudeModels(selectedProviderProfile, { allowNetwork: !fast });
  }
  if (toolId === 'codex' || toolId === 'codex-cli') {
    return getCodexModels(selectedProviderProfile, { allowNetwork: !fast });
  }
  if (toolId === 'agy') {
    const now = Date.now();
    const agyCacheKey = selectedProviderProfile || '*';
    let cached = cacheGet(agyModelsCache, agyCacheKey);
    if (fast && (!cached || now - cached.at >= AGY_MODEL_CACHE_TTL_MS)) {
      // `agy models` starts a provider CLI and may wait on auth/configuration.
      // Keep the model picker responsive by returning the last known catalog
      // (or an empty bounded result) and refreshing it off the request path.
      refreshAgyModelsInBackground(selectedProviderProfile);
      if (!cached) {
        return {
          models: [],
          effortLevels: [...AGY_EFFORT_LEVELS],
          defaultModel: null,
          reasoning: {
            kind: 'enum',
            label: 'Thinking',
            levels: [...AGY_EFFORT_LEVELS],
            default: 'medium',
          },
        };
      }
    }
    if (!cached || now - cached.at >= AGY_MODEL_CACHE_TTL_MS) {
      const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
      const { prepareNativeRunProviderHome } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
      const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
      const secretStore = createSecretStore({ configDir: CONFIG_DIR });
      const profiles = (await registry.listProviderProfiles().catch(() => []))
        .filter((profile) => profile.agentType === 'agy')
        .filter((profile) => !selectedProviderProfile || profile.id === selectedProviderProfile);
      const discovered = [];
      for (const profile of profiles) {
        const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
        const status = auth ? await secretStore.describeSecret(auth.storageRef).catch(() => null) : null;
        if (!status?.ok) continue;
        const prepared = await prepareNativeRunProviderHome(`catalog-${profile.id}`, {
          tool: 'agy',
          runtimeFamily: 'agy-json',
          options: { runtimeFamily: 'agy-json', providerProfile: profile.id },
        }, {
          configDir: CONFIG_DIR,
          providerHomesRoot: join(CONFIG_DIR, 'provider-runtime-homes', 'catalog'),
          externalOAuthOwnership: false,
        }).catch(() => null);
        if (!prepared?.ok || !prepared.agyHomeDir) continue;
        const models = await listAgyModels({ agyHomeDir: prepared.agyHomeDir }).catch(() => []);
        for (const entry of Array.isArray(models) ? models : []) {
          const id = String(entry?.id || entry || '').trim();
          if (!id) continue;
          discovered.push({
            ...entry,
            id: `${id}@${profile.id}`,
            label: `${String(entry?.label || id).trim()} · ${profile.displayName || profile.id}`,
          });
        }
      }
      cached = { at: now, models: discovered };
      cacheSet(agyModelsCache, agyCacheKey, cached);
    }
    const reasoning = {
      kind: 'enum',
      label: 'Thinking',
      levels: [...AGY_EFFORT_LEVELS],
      default: 'medium',
    };
    return {
      models: cached.models.map((model) => buildResponseModel(model, reasoning)),
      effortLevels: [...AGY_EFFORT_LEVELS],
      defaultModel: cached.models[0]?.id || null,
      reasoning,
    };
  }

  if (BRIDGED_HARNESS_IDS.has(String(toolId || '').trim())) {
    const harness = String(toolId).trim();
    const result = await getBridgedHarnessModels(harness, selectedProviderProfile, { allowNetwork: !fast });
    return harness === 'openhands'
      ? { ...result, serviceRequired: true, serviceRuntimeFamily: 'openhands-agent-server' }
      : result;
  }

  const tool = await getToolDefinitionAsync(toolId);
  if (tool?.runtimeFamily) {
    const toolReasoning = cloneReasoning(tool.reasoning || { kind: 'none', label: 'Thinking' })
      || { kind: 'none', label: 'Thinking' };
    const models = (tool.models || []).map((model) => buildResponseModel(model, toolReasoning));
    const defaultReasoning = models[0]?.reasoning || toolReasoning;

    return {
      models,
      effortLevels: defaultReasoning.kind === 'enum' ? defaultReasoning.levels || [] : null,
      defaultModel: models[0]?.id || null,
      reasoning: defaultReasoning,
    };
  }

  return {
    models: [],
    effortLevels: null,
    defaultModel: null,
    reasoning: { kind: 'none', label: 'Thinking' },
  };
}

// Provider-scoped catalog projection for run-admission validation and the
// refreshed /api/models metadata. Reuses getModelsForTool's cached entries —
// the same normalization path that feeds the UI — and groups them per
// providerProfileId with catalogVersion/fetchedAt/status metadata. Read-only:
// this never triggers an upstream discovery on the request path.
const toolCatalogCache = new Map(); // `${toolId}` -> { at, catalogs: Map<providerProfileId, catalog> }
const TOOL_CATALOG_CACHE_TTL_MS = 60_000;

export function invalidateToolModelCatalogCache(toolId = '') {
  const normalized = String(toolId || '').trim();
  if (!normalized) {
    toolCatalogCache.clear();
    return;
  }
  const alias = TOOL_HARNESS_ALIASES[normalized];
  for (const key of toolCatalogCache.keys()) {
    if (key === normalized || key.startsWith(`${normalized}\u0000`)
      || (alias && (key === alias || key.startsWith(`${alias}\u0000`)))) {
      toolCatalogCache.delete(key);
    }
  }
}

export async function getToolModelCatalogs(toolId, providerProfile = '', { fast = false, getModelsImpl = getModelsForTool } = {}) {
  const tool = String(toolId || '').trim();
  if (!tool) return [];
  const selectedProviderProfile = String(providerProfile || '').trim();
  const cacheKey = `${tool}\u0000${selectedProviderProfile}`;
  const now = Date.now();
  let entry = cacheGet(toolCatalogCache, cacheKey);
  if (!entry || now - entry.at >= TOOL_CATALOG_CACHE_TTL_MS) {
    const result = await getModelsImpl(tool, { providerProfile: selectedProviderProfile, fast });
    const catalogs = new Map();
    const providerGroups = new Map();
    const providerOrigins = new Map();
    for (const model of Array.isArray(result?.models) ? result.models : []) {
      const { model: bareModel, providerId } = parseScopedCodexModel(model?.id || '');
      const groupKey = providerId || '';
      if (!providerGroups.has(groupKey)) providerGroups.set(groupKey, []);
      if (!providerOrigins.has(groupKey)) providerOrigins.set(groupKey, []);
      providerOrigins.get(groupKey).push(model?.catalogSource);
      providerGroups.get(groupKey).push({
        model: bareModel,
        label: model?.label || bareModel,
        source: sourceFromModelOrigins([model?.catalogSource]),
        capabilities: model?.capabilities || null,
        ...(Number.isFinite(model?.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      });
    }
    for (const [groupKey, entries] of providerGroups) {
      catalogs.set(groupKey, normalizeModelCatalog({
        providerProfileId: groupKey,
        entries,
        // The backing getModelsForTool caches (AgY TTL, codexModelsCache,
        // providerModelListCache) already carry freshness semantics; this
        // projection is 'discovered' when it came from provider enumeration
        // and static for tool-definition fallbacks.
        source: sourceFromModelOrigins(providerOrigins.get(groupKey)),
        fetchedAt: new Date(now).toISOString(),
        expiresAt: now + TOOL_CATALOG_CACHE_TTL_MS,
        nowMs: now,
      }));
    }
    entry = { at: now, catalogs };
    // A fast request may be built from configured/stale fallback rows while
    // the upstream refresh is still running. Do not pin that incomplete
    // catalog for a full minute; the next request should observe the
    // background result as soon as it is available.
    if (!fast) {
      cacheSet(toolCatalogCache, cacheKey, entry);
    }
  }
  return [...entry.catalogs.values()];
}

export async function getToolModelCatalog(toolId, providerProfileId = '', { fast = false } = {}) {
  const wanted = String(providerProfileId || '').trim();
  const catalogs = await getToolModelCatalogs(toolId, wanted, { fast });
  if (wanted) return catalogs.find((catalog) => catalog.providerProfileId === wanted) || null;
  // No provider specified: a single-provider tool yields its catalog; a
  // multi-provider tool has no unambiguous catalog and the gate is skipped.
  if (catalogs.length === 1) return catalogs[0];
  return null;
}

// Model slugs retired upstream: opencode.ai's (zen) model list endpoint still
// advertises them (supported_in_api=true) even though the responses endpoint
// rejects them with 401 "Model X is not supported".  Filter them out of zen
// rows only — the official ChatGPT backend and the custom upstream both
// support these models, so a global filter would hide valid models the user
// explicitly wants to see (2026-08-09: 全量合并展示所有凭据的模型).
const RETIRED_CODEX_MODEL_SLUGS = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);

// —— 2026-08-09 全量合并：/api/models 展示所有 codex 凭据的模型 ——
// 需求（用户定界）：API 服务展示全部 provider 的模型（官方=标邮箱后缀），
// 会话按所选模型自动注入对应 Native provider 凭据；不读取或修改任何
// 全局 provider/current 配置。
// id 契约：`${model}@${providerId}`——同 model id 存在于多个 provider 时
// 保证唯一；spawn 侧（runner-sidecar）用 parseScopedCodexModel 拆出
// providerId 后按行镜像 managed home，真实 model id 再发给 codex。

// 官方账号（ChatGPT OAuth）模型目录兜底。正常路径通过每个 Provider 的
// 隔离 home + app-server model/list 动态发现；只有账号离线、登录失效或
// app-server 暂时不可用时才使用此表，保证模型选择器不会被清空。
const OFFICIAL_CODEX_MODEL_CATALOG = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', effortLevels: CODEX_GPT_6_ASTRA_EFFORT_LEVELS },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', effortLevels: CODEX_GPT_56_SOL_EFFORT_LEVELS },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', effortLevels: CODEX_GPT_56_EFFORT_LEVELS },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', effortLevels: CODEX_GPT_56_EFFORT_LEVELS },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
];

// 上游 /v1/models 探测：TTL 缓存 + 失败冷却（zen 端点响应极慢，不能让每次
// /api/models 请求都卡在超时上）
const PROVIDER_MODEL_LIST_TTL_MS = 120_000;
const PROVIDER_MODEL_LIST_FETCH_TIMEOUT_MS = 8_000;
const PROVIDER_MODEL_LIST_FAIL_COOLDOWN_MS = 60_000;
const providerModelListCache = new Map();
const providerModelListRefreshes = new Map();
const officialCodexModelListCache = new Map();
const officialCodexModelListRefreshes = new Map();

function parseTomlStringValue(toml, key) {
  const match = String(toml || '').match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match ? match[1].trim() : '';
}

function providerApiFormat(provider) {
  return String(provider?.meta?.apiFormat || '').trim().toLowerCase();
}

function isOfficialRow(provider) {
  // 官方 OAuth 行：auth_mode=chatgpt（key 行一律带 apiFormat）
  return provider?.settingsConfig?.auth?.auth_mode === 'chatgpt';
}

function providerBaseUrl(provider) {
  const settingsConfig = provider?.settingsConfig || {};
  const envBase = settingsConfig.env?.ANTHROPIC_BASE_URL;
  if (typeof envBase === 'string' && envBase.trim()) return envBase.trim();
  const toml = typeof settingsConfig.config === 'string' ? settingsConfig.config : '';
  return parseTomlStringValue(toml, 'base_url');
}

function providerModelFromConfig(provider) {
  const settingsConfig = provider?.settingsConfig || {};
  const envModel = settingsConfig.env?.ANTHROPIC_MODEL;
  if (typeof envModel === 'string' && envModel.trim()) return envModel.trim();
  const toml = typeof settingsConfig.config === 'string' ? settingsConfig.config : '';
  return parseTomlStringValue(toml, 'model');
}

function isZenProvider(provider) {
  return String(providerBaseUrl(provider) || '').toLowerCase().includes('opencode.ai');
}

// 模型行展示后缀：官方=账号邮箱（用户需求），key 行=按上游端点归类
function providerDisplayTag(provider) {
  if (isOfficialRow(provider)) return provider.name || provider.id;
  const url = String(providerBaseUrl(provider) || '').toLowerCase();
  if (url.includes('api.deepseek.com')) return 'DeepSeek';
  if (url.includes('opencode.ai/zen/v1')) return 'Zen Free';
  if (url.includes('opencode.ai/zen/go')) return 'Zen';
  if (/^https?:\/\/[\d.:]+/i.test(url)) return 'Custom';
  return provider.name || provider.id;
}

// 缓存 display_name 可能残留旧「 · 邮箱」后缀；服务端统一按行重新标注，
// 去掉尾部「 · …」避免双后缀（官方模型名本身不含「 · 」）
function stripTrailingProviderSuffix(label) {
  return String(label || '').replace(/\s*·\s*[^·]+$/, '').trim();
}

// /models 响应里机会性解析上下文窗口：字段名不统一（Anthropic=
// max_input_tokens，new-api 系网关=context_length / max_model_len /
// max_input_tokens），且标准 OpenAI 响应根本没有这些字段。  解析不到 →
// null，由静态兜底表（lookupModelContextWindowTokens）补。
const MODEL_LIST_CONTEXT_WINDOW_FIELDS = ['max_input_tokens', 'context_length', 'max_model_len'];

export function parseModelContextWindow(entry) {
  for (const field of MODEL_LIST_CONTEXT_WINDOW_FIELDS) {
    const raw = entry?.[field];
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return null;
}

function modelCapabilityExtension(data, model) {
  const modelId = String(model?.id || '').trim();
  if (!modelId || !data || typeof data !== 'object') return {};
  const maps = [
    data.model_capabilities,
    data.modelCapabilities,
    data.capabilities,
    data.capabilities?.models,
    data.capabilities?.by_model,
    data.capabilities?.byModel,
  ];
  for (const map of maps) {
    if (map && typeof map === 'object' && map[modelId] && typeof map[modelId] === 'object') {
      return map[modelId];
    }
  }
  return {};
}

// key 行模型目录：GET {base_url}/models（Bearer key），TTL 缓存；失败 →
// null（调用方回退到该行 config model）
function refreshProviderModelListInBackground(provider, cacheKey) {
  if (!providerModelListRefreshes.has(cacheKey)) {
    const promise = fetchProviderModelList(provider, { allowNetwork: true })
      .catch(() => null)
      .finally(() => providerModelListRefreshes.delete(cacheKey));
    providerModelListRefreshes.set(cacheKey, promise);
    promise.catch(() => {});
  }
}

async function fetchProviderModelList(provider, { allowNetwork = true } = {}) {
  const apiFormat = providerApiFormat(provider);
  if (!apiFormat || isOfficialRow(provider)) return null;
  const baseUrl = providerBaseUrl(provider);
  const apiKey = provider?.settingsConfig?.auth?.OPENAI_API_KEY
    || provider?.settingsConfig?.auth?.api_key;
  if (!baseUrl || !apiKey) return null;
  // Two accounts commonly share the same endpoint but may expose different
  // model catalogs. Keep the short credential fingerprint in memory only so
  // one account cannot reuse another account's /models result.
  const cacheKey = `${baseUrl}\u0000${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  const now = Date.now();
  const cached = cacheGet(providerModelListCache, cacheKey);
  if (cached?.at && now - cached.at < PROVIDER_MODEL_LIST_TTL_MS && Array.isArray(cached.models)) {
    return cached.models;
  }
  if (cached?.failedAt && now - cached.failedAt < PROVIDER_MODEL_LIST_FAIL_COOLDOWN_MS) {
    if (!allowNetwork) refreshProviderModelListInBackground(provider, cacheKey);
    return null;
  }
  if (!allowNetwork) {
    refreshProviderModelListInBackground(provider, cacheKey);
    return Array.isArray(cached?.models) ? cached.models : null;
  }
  // OpenAI-convention endpoints serve `GET {base}/models`; anthropic-messages
  // gateways (z.ai, bigmodel, deepseek/anthropic) serve `GET {base}/v1/models`
  // and return 404 on the bare `/models` path.
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const listPath = apiFormat === 'anthropic' && !/\/v1$/i.test(normalizedBaseUrl)
    ? '/v1/models'
    : '/models';
  const url = `${normalizedBaseUrl}${listPath}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_MODEL_LIST_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 'error'}`);
    const data = await res.json();
    const rawModels = Array.isArray(data?.data)
      ? data.data
      : (Array.isArray(data?.models) ? data.models : []);
    const list = rawModels
      .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim())
      .map((m) => {
        const capabilityExtension = modelCapabilityExtension(data, m);
        const mergedMetadata = { ...m, ...capabilityExtension };
        return {
          id: m.id.trim(),
          label: String(m.display_name || m.name || '').trim() || m.id.trim(),
          // Anthropic's /v1/models reports `max_input_tokens` (the context
          // window); new-api-style OpenAI gateways sometimes extend the bare
          // /models response with `context_length` / `max_model_len`.  None of
          // them are guaranteed, so parse opportunistically and let the static
          // fallback table decide downstream.
          contextWindow: parseModelContextWindow(mergedMetadata),
          capabilities: parseModelCapabilities(mergedMetadata, { source: 'upstream' }),
        };
      });
    if (list.length === 0) throw new Error('empty-list');
    cacheSet(providerModelListCache, cacheKey, { at: Date.now(), models: list });
    return list;
  } catch {
    cacheSet(providerModelListCache, cacheKey, { at: Date.now(), failedAt: Date.now() });
    return null;
  }
}

function fallbackOfficialCodexCatalog() {
  return OFFICIAL_CODEX_MODEL_CATALOG.map((m) => ({
    ...m,
    effortLevels: Array.isArray(m.effortLevels) ? [...m.effortLevels] : [],
    defaultEffort: m.defaultEffort || '',
    catalogSource: 'builtin',
  }));
}

async function discoverOfficialCodexCatalog(provider) {
  const providerId = String(provider?.id || '').trim();
  if (!providerId) throw new Error('Official Codex provider id is missing');
  const { prepareNativeRunProviderHome } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
  const prepared = await prepareNativeRunProviderHome(`catalog-${providerId}`, {
    tool: 'codex',
    runtimeFamily: 'codex-app-server-json',
    options: {
      runtimeFamily: 'codex-app-server-json',
      providerProfile: providerId,
      model: providerModelFromConfig(provider),
    },
  }, {
    configDir: CONFIG_DIR,
    // Use the exact same provider-scoped root as ordinary Runs. Creating a
    // second catalog-only home would create a second OAuth refresh writer.
    providerHomesRoot: dirname(CODEX_MANAGED_HOME_DIR),
    externalOAuthOwnership: false,
    holdNativeOAuthLock: false,
  });
  if (!prepared?.ok || !prepared.codexHomeDir) {
    throw new Error(prepared?.error || prepared?.reason || 'Official Codex provider home is unavailable');
  }
  const { listCodexAppServerModels } = await import('./codex-app-server-client.mjs');
  const models = await listCodexAppServerModels({
    codexHomeDir: prepared.codexHomeDir,
    timeoutMs: PROVIDER_MODEL_LIST_FETCH_TIMEOUT_MS,
  });
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Official Codex model/list returned no picker-visible models');
  }
  return models.map((model) => ({
    ...model,
    effortLevels: Array.isArray(model.effortLevels) ? [...model.effortLevels] : [],
    defaultEffort: model.defaultEffort || '',
    catalogSource: 'upstream',
  }));
}

function refreshOfficialCodexCatalog(provider, cacheKey, staleEntry = null) {
  if (officialCodexModelListRefreshes.has(cacheKey)) {
    return officialCodexModelListRefreshes.get(cacheKey);
  }
  const staleModels = Array.isArray(staleEntry?.models) ? staleEntry.models : null;
  const promise = discoverOfficialCodexCatalog(provider)
    .then((models) => {
      cacheSet(officialCodexModelListCache, cacheKey, { at: Date.now(), models });
      return models;
    })
    .catch(() => {
      const failedAt = Date.now();
      cacheSet(officialCodexModelListCache, cacheKey, {
        ...(Array.isArray(staleModels) ? { models: staleModels } : {}),
        ...(Array.isArray(staleModels) ? { at: staleEntry?.at || 0 } : {}),
        failedAt,
      });
      return Array.isArray(staleModels) ? staleModels : null;
    })
    .finally(() => officialCodexModelListRefreshes.delete(cacheKey));
  officialCodexModelListRefreshes.set(cacheKey, promise);
  promise.catch(() => {});
  return promise;
}

// Each official account has an isolated, broker-owned Codex home. A normal
// refresh asks that account's app-server for its real picker catalog; fast
// reads serve the cached/stable result immediately and refresh in background.
async function readOfficialCodexCatalog(provider, { allowNetwork = true } = {}) {
  const fallback = fallbackOfficialCodexCatalog();
  const cacheKey = String(provider?.id || '').trim();
  if (!cacheKey) return fallback;
  const now = Date.now();
  const cached = cacheGet(officialCodexModelListCache, cacheKey);
  const staleModels = Array.isArray(cached?.models) ? cached.models : null;
  if (cached?.at && now - cached.at < PROVIDER_MODEL_LIST_TTL_MS && staleModels) {
    return staleModels;
  }
  if (cached?.failedAt && now - cached.failedAt < PROVIDER_MODEL_LIST_FAIL_COOLDOWN_MS) {
    return staleModels || fallback;
  }
  if (!allowNetwork) {
    void refreshOfficialCodexCatalog(provider, cacheKey, cached);
    return staleModels || fallback;
  }
  return await refreshOfficialCodexCatalog(provider, cacheKey, cached) || fallback;
}

// 拆 `model@providerId`：providerId 只接受已知 id 形态（字母数字 . _ -），
// 防 model id 本身含 @ 时误拆；无后缀 → { model, providerId: '' }（沿用
// current provider 语义，与历史会话兼容）
export function parseScopedCodexModel(model) {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) return { model: '', providerId: '' };
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return { model: raw, providerId: '' };
  const providerId = raw.slice(at + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(providerId)) return { model: raw, providerId: '' };
  return { model: raw.slice(0, at), providerId };
}

// Native registry rows are normalized to the internal catalog shape.
async function listProviderRowsForModelCatalog() {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const secretStore = createSecretStore({ configDir: CONFIG_DIR });
  const profiles = await registry.listProviderProfiles().catch(() => []);
  const rows = [];
  for (const profile of profiles) {
    if (profile.agentType !== 'codex') continue;
    const authProfile = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    if (!authProfile) continue;
    const resolvedSecret = authProfile.authType === 'api-key'
      ? await secretStore.resolveSecret(authProfile.storageRef).catch(() => null)
      : null;
    const apiKey = resolvedSecret?.ok && resolvedSecret.authType === 'api-key'
      ? resolvedSecret.apiKey
      : '';
    const authShape = authProfile.authType === 'oauth'
      ? { auth_mode: 'chatgpt' }
      : { OPENAI_API_KEY: apiKey };
    rows.push({
      id: profile.id,
      name: profile.displayName,
      isCurrent: 0,
      settingsConfig: {
        config: `model = "${profile.modelPolicy?.defaultModel || ''}"\nbase_url = "${profile.baseUrl}"\n`,
        auth: authShape,
        models: Array.isArray(profile.modelPolicy?.models) ? profile.modelPolicy.models : [],
      },
      meta: {
        apiFormat: profile.protocol === 'openai-chat'
          ? 'openai_chat'
          : profile.protocol === 'openai-responses'
            ? 'openai'
            : '',
      },
    });
  }
  return rows;
}

async function getCodexModels(providerProfile = '', { allowNetwork = true } = {}) {
  const rows = (await listProviderRowsForModelCatalog())
    .filter((row) => !providerProfile || row.id === providerProfile);
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      models: [],
      effortLevels: CODEX_DEFAULT_EFFORT_LEVELS,
      defaultModel: null,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: CODEX_DEFAULT_EFFORT_LEVELS,
        default: 'medium',
      },
    };
  }
  const rowsFingerprint = rows.map((row) => [
    row.id,
    row.isCurrent ? 1 : 0,
    isOfficialRow(row) ? 'oauth' : 'api',
    providerApiFormat(row),
    providerModelFromConfig(row),
    providerBaseUrl(row),
    JSON.stringify(row.settingsConfig?.models || []),
  ].join(':')).join('|');
  const cacheKey = rowsFingerprint;
  const cached = cacheGet(codexModelsCache, cacheKey);
  if (cached && Date.now() - cached.at < PROVIDER_MODEL_LIST_TTL_MS) {
    return cached.result;
  }

  const merged = [];
  const providerRows = [];
  const officialRows = rows.filter((row) => isOfficialRow(row));
  const officialCatalogs = await mapWithConcurrency(officialRows, 2, async (row) => ({
    row,
    catalog: await readOfficialCodexCatalog(row, { allowNetwork }),
  }));
  const officialCatalogByProvider = new Map(
    officialCatalogs.map(({ row, catalog }) => [row.id, catalog]),
  );
  for (const row of rows) {
    if (isOfficialRow(row)) {
      const officialCatalog = officialCatalogByProvider.get(row.id) || fallbackOfficialCodexCatalog();
      for (const entry of officialCatalog) {
        merged.push(buildCodexModelRecord({
          id: `${entry.id}@${row.id}`,
          label: `${stripTrailingProviderSuffix(entry.label)} · ${providerDisplayTag(row)}`,
          effortLevels: entry.effortLevels,
          defaultEffort: entry.defaultEffort,
          catalogSource: entry.catalogSource,
          serviceTiers: CODEX_SERVICE_TIER_OPTIONS,
          capabilities: parseModelCapabilities({
            ...entry,
            serviceTiers: CODEX_SERVICE_TIER_OPTIONS,
            supportsFast: true,
          }, { source: entry.catalogSource === 'upstream' ? 'upstream' : 'builtin' }),
        }));
      }
      continue;
    }
    providerRows.push(row);
  }
  const providerModels = await mapWithConcurrency(providerRows, 4, async (row) => {
    const list = await fetchProviderModelList(row, { allowNetwork });
    const configuredModels = Array.isArray(row.settingsConfig?.models)
      ? row.settingsConfig.models
      : [];
    const entries = (list && list.length > 0)
      ? list
      : (configuredModels.length > 0
        ? configuredModels
        : [{ id: providerModelFromConfig(row), label: '' }]);
    return entries
      .filter((entry) => entry?.id)
      .filter((entry) => !(isZenProvider(row) && RETIRED_CODEX_MODEL_SLUGS.has(entry.id)))
      .map((entry) => {
        let capabilities = entry.capabilities || parseModelCapabilities(entry, {
          source: list && list.length > 0 ? 'upstream' : 'configured',
        });
        if (capabilities.effort.supported !== false && capabilities.effort.levels.length === 0) {
          const known = OFFICIAL_CODEX_MODEL_CATALOG.find((model) => model.id === entry.id);
          const levels = known?.effortLevels || CODEX_DEFAULT_EFFORT_LEVELS;
          capabilities = { ...capabilities, effort: {
            supported: true, levels: [...levels], default: 'medium', source: 'builtin',
          } };
        }
        return buildCodexModelRecord({
          id: `${entry.id}@${row.id}`,
          label: `${entry.label || entry.id} · ${providerDisplayTag(row)}`,
          serviceTiers: ['standard'],
          contextWindow: entry.contextWindow,
          catalogSource: list && list.length > 0 ? 'upstream' : 'configured',
          capabilities,
        });
      });
  });
  for (const records of providerModels) merged.push(...(Array.isArray(records) ? records : []));

  const effortLevels = [...new Set(merged.flatMap((m) => m.effortLevels || []))];
  const result = {
    models: merged,
    effortLevels: effortLevels.length > 0 ? effortLevels : null,
    defaultModel: null,
    reasoning: effortLevels.length > 0
      ? {
        kind: 'enum',
        label: 'Thinking',
        levels: effortLevels,
        default: merged[0]?.defaultEffort || effortLevels[0] || 'medium',
      }
      : { kind: 'none', label: 'Thinking' },
  };
  if (allowNetwork) cacheSet(codexModelsCache, cacheKey, { at: Date.now(), result });
  return result;
}

function normalizeUniquePaths(paths) {
  const seen = new Set();
  const normalized = [];
  for (const value of paths) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const path = resolve(trimmed);
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

function codexHomeCandidates(explicitHomeDir = '') {
  const requestedHome = typeof explicitHomeDir === 'string' ? explicitHomeDir.trim() : '';
  if (requestedHome) return normalizeUniquePaths([requestedHome]);
  return normalizeUniquePaths([
    process.env.CODEX_HOME,
    CODEX_MANAGED_HOME_DIR,
    join(homedir(), '.codex'),
  ]);
}

export async function readPreferredCodexModelFromConfig(options = {}) {
  for (const homeDir of codexHomeCandidates(options.homeDir)) {
    try {
      const raw = await readFile(join(homeDir, 'config.toml'), 'utf8');
      const match = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
      const model = typeof match?.[1] === 'string' ? match[1].trim() : '';
      if (model) return model;
    } catch {
    }
  }
  return '';
}

function buildCodexModelRecord({
  id,
  label,
  effortLevels = null,
  defaultEffort = '',
  serviceTiers = ['standard'],
  capabilities = null,
  contextWindow = null,
  catalogSource = '',
}) {
  const modelCapabilities = capabilities || parseModelCapabilities({
    ...(Array.isArray(effortLevels) ? { effortLevels } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(Array.isArray(serviceTiers) ? { serviceTiers } : {}),
  }, { source: 'configured' });
  const reasoning = reasoningFromCapabilities(modelCapabilities);
  const tiers = modelCapabilities.serviceTier.supportsFast === true
    ? [...new Set(['standard', ...modelCapabilities.serviceTier.values, 'fast'])]
    : ['standard'];
  const model = {
    id,
    label,
    ...(catalogSource ? { catalogSource } : {}),
    ...(Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow: Math.floor(contextWindow) }
      : {}),
    capabilities: publicModelCapabilities(modelCapabilities),
    ...(tiers.includes('fast') ? { serviceTiers: tiers } : {}),
    ...(reasoning ? {
      reasoning,
      ...(reasoning.kind === 'enum' ? {
        defaultEffort: reasoning.default,
        effortLevels: [...reasoning.levels],
      } : {}),
    } : {}),
  };
  return model;
}
