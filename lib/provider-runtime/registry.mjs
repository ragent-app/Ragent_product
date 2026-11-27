// Native provider runtime registry.
//
// A ProviderProfile answers "where do requests go" (protocol + base URL +
// model policy).  An AuthProfile answers "who is authenticating".  The two are
// separate rows so a credential can never structurally drift into a provider
// definition: providers reference auth by id only.
//
// Storage is one JSON file per registry under the instance config directory
// (native-provider-runtime/), written atomically.  Row payloads never contain
// secrets — credentials live in the SecretStore (secret-store.mjs) and are
// referenced by AuthProfile.storageRef.  This keeps the registry file safe to
// read for status/UI purposes without a credential gate.
//
// The registry is deliberately side-effect free on import (no writes at module
// load) so root-owned brokers can import it safely.

import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export const NATIVE_PROVIDER_REGISTRY_VERSION = 1;

// Native clients and generic harness-backed provider profiles share the same
// registry.  Harness ids are intentionally explicit so a profile cannot be
// silently reused with a different config dialect.
export const SUPPORTED_AGENT_TYPES = new Set([
  'codex', 'claude', 'agy',
  'pi', 'deepseek-harness', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo',
]);

// Quota policy is metadata only.  It selects a fixed, server-owned adapter;
// it never contains an endpoint script or credential material.  Providers
// without a policy can still be used normally, but their quota projection is
// reported as unsupported until a known adapter is selected.
export const PROVIDER_QUOTA_MODES = new Set([
  'official_subscription',
  'coding_plan',
  'payg_balance',
]);

export const PROVIDER_QUOTA_ADAPTERS = new Set([
  'codex',
  'claude',
  'agy',
  'kimi',
  'zhipu',
  'minimax',
  'zenmux',
  'deepseek',
  'stepfun',
  'siliconflow',
  'openrouter',
  'novita',
]);

export const PROVIDER_STATUSES = new Set([
  'ready',
  'needs-login',
  'disabled',
  'refresh-conflict',
  'migration-error',
]);

// How a provider speaks to its upstream, and which agent runtime families can
// drive it.  Mirrors the capability matrix in the architecture doc: the UI must
// not offer combinations the adapters cannot actually run.
export const PROVIDER_PROTOCOLS = new Set([
  'openai-responses', // Upstream Responses API (Codex still uses Responses)
  'openai-chat', // Upstream Chat Completions API (requires a conversion gateway)
  'anthropic-messages', // Claude wire protocol (official or compatible gateway)
  'agy', // Native AgY CLI protocol; base URL is intentionally unused.
  'github-copilot', // GitHub Copilot subscription authenticated by GH_TOKEN.
]);

export function computeProfileRevision(profile) {
  const canonical = JSON.stringify(stableValue(profile));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAgentType(value) {
  const normalized = trimString(value).toLowerCase();
  return SUPPORTED_AGENT_TYPES.has(normalized) ? normalized : '';
}

export function normalizeProtocol(value) {
  const normalized = trimString(value).toLowerCase();
  return PROVIDER_PROTOCOLS.has(normalized) ? normalized : '';
}

export function normalizeQuotaPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = trimString(value.mode).toLowerCase();
  const adapter = trimString(value.adapter).toLowerCase();
  if (!mode && !adapter) return null;
  return {
    mode: PROVIDER_QUOTA_MODES.has(mode) ? mode : '',
    ...(adapter ? { adapter } : {}),
  };
}

export function normalizeProviderStatus(value) {
  const normalized = trimString(value).toLowerCase();
  return PROVIDER_STATUSES.has(normalized) ? normalized : 'ready';
}

// A ProviderProfile rows carries no credential material.  authProfileId is the
// only bridge to an AuthProfile.
export function validateProviderProfile(profile) {
  const errors = [];
  const id = trimString(profile?.id);
  const agentType = normalizeAgentType(profile?.agentType);
  const protocol = normalizeProtocol(profile?.protocol);
  const authProfileId = trimString(profile?.authProfileId);
  const syncId = trimString(profile?.syncId || id);
  const quotaPolicy = normalizeQuotaPolicy(profile?.quotaPolicy);
  if (!id) errors.push('id is required');
  if (!syncId || syncId.length > 256) errors.push('syncId must be a non-empty string of at most 256 characters');
  if (!agentType) errors.push('agentType must be a supported native client or harness');
  if (!protocol) errors.push('protocol must be openai-responses, openai-chat, anthropic-messages, agy, or github-copilot');
  if (!authProfileId) errors.push('authProfileId is required (providers never embed credentials)');
  const baseUrl = trimString(profile?.baseUrl);
  const baseUrlOptional = agentType === 'agy'
    || (agentType === 'copilot' && protocol === 'github-copilot');
  if (!baseUrlOptional && !baseUrl) errors.push('baseUrl is required');
  else if (baseUrl && !/^https?:\/\//.test(baseUrl)) errors.push('baseUrl must be an http(s) URL');
  if (agentType === 'codex' && !['openai-responses', 'openai-chat'].includes(protocol)) {
    errors.push('codex providers must use the openai-responses or openai-chat protocol');
  }
  if (agentType === 'claude' && protocol !== 'anthropic-messages') {
    errors.push('claude providers must use the anthropic-messages protocol');
  }
  if (agentType === 'agy' && protocol !== 'agy') {
    errors.push('agy providers must use the agy protocol');
  }
  if (agentType === 'copilot' && !['github-copilot', 'openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)) {
    errors.push('copilot providers must use github-copilot, openai-chat, openai-responses, or anthropic-messages');
  }
  if (profile?.quotaPolicy !== undefined && profile?.quotaPolicy !== null && !quotaPolicy) {
    errors.push('quotaPolicy must be an object with a supported mode or adapter');
  } else if (quotaPolicy) {
    if (!quotaPolicy.mode || !PROVIDER_QUOTA_MODES.has(quotaPolicy.mode)) {
      errors.push('quotaPolicy.mode must be official_subscription, coding_plan, or payg_balance');
    }
    if (quotaPolicy.adapter && !PROVIDER_QUOTA_ADAPTERS.has(quotaPolicy.adapter)) {
      errors.push(`quotaPolicy.adapter is unsupported: ${quotaPolicy.adapter}`);
    }
  }
  if (profile?.status !== undefined && !PROVIDER_STATUSES.has(trimString(profile.status).toLowerCase())) {
    errors.push(`status is unsupported: ${trimString(profile.status)}`);
  }
  return { ok: errors.length === 0, errors };
}

// Official-account profiles (OAuth against the first-party endpoint) are a
// distinct shape: no relay base URL override beyond the official endpoint, and
// the AuthProfile must hold an OAuth-type credential.  They stay in the same
// registry so resolution has one code path.
export function isOfficialProviderProfile(profile) {
  return trimString(profile?.baseUrl) === ''
    || /(^|\.)openai\.com$/.test(hostOf(profile?.baseUrl))
    || /(^|\.)anthropic\.com$/.test(hostOf(profile?.baseUrl));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// AuthProfile: who authenticates.  authType is the credential shape;
// storageType + storageRef point into the SecretStore — the row itself never
// carries the secret.
export function validateAuthProfile(profile) {
  const errors = [];
  const id = trimString(profile?.id);
  const agentType = normalizeAgentType(profile?.agentType);
  const authType = trimString(profile?.authType);
  const storageType = trimString(profile?.storageType);
  const storageRef = trimString(profile?.storageRef);
  if (!id) errors.push('id is required');
  if (!agentType) errors.push('agentType must be a supported native client or harness');
  if (!['api-key', 'oauth', 'oauth-token'].includes(authType)) {
    errors.push('authType must be api-key, oauth, or oauth-token');
  }
  if (agentType === 'claude' && authType === 'oauth') {
    errors.push('Claude normal OAuth is unsupported; use oauth-token from claude setup-token or api-key');
  }
  if (storageType !== 'secret-store') errors.push('storageType must be secret-store');
  if (!storageRef) errors.push('storageRef is required');
  return { ok: errors.length === 0, errors };
}

export function createNativeProviderRegistry({
  configDir,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
} = {}) {
  const registryDir = join(configDir, 'native-provider-runtime');
  const providersFile = join(registryDir, 'providers.json');
  const authFile = join(registryDir, 'auth-profiles.json');

  async function ensureRegistryDir() {
    await mkdirImpl(registryDir, { recursive: true, mode: 0o700 });
  }

  async function readRegistryFile(filePath) {
    try {
      const text = await readFileImpl(filePath, 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeRegistryFile(filePath, payload) {
    await ensureRegistryDir();
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFileImpl(tempPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600, flush: true });
    await renameImpl(tempPath, filePath);
  }

  // —— ProviderProfiles ——

  async function listProviderProfiles() {
    const registry = await readRegistryFile(providersFile);
    const rows = Array.isArray(registry.profiles) ? registry.profiles : [];
    return rows.map((row) => ({ ...row, revision: computeProfileRevision(row) }));
  }

  async function getProviderProfile(providerId) {
    const id = trimString(providerId);
    if (!id) return null;
    const rows = await listProviderProfiles();
    return rows.find((row) => row.id === id) || null;
  }

  async function upsertProviderProfile(profile) {
    const validation = validateProviderProfile(profile);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const rows = (await readRegistryFile(providersFile));
    const profiles = Array.isArray(rows.profiles) ? rows.profiles : [];
    const id = trimString(profile.id);
    const existingIndex = profiles.findIndex((row) => row.id === id);
    const nowIso = new Date().toISOString();
    const quotaPolicy = normalizeQuotaPolicy(profile.quotaPolicy);
    const semantic = {
      id,
      syncId: trimString(profile.syncId) || id,
      agentType: normalizeAgentType(profile.agentType),
      protocol: normalizeProtocol(profile.protocol),
      displayName: trimString(profile.displayName) || id,
      baseUrl: trimString(profile.baseUrl),
      authProfileId: trimString(profile.authProfileId),
      modelPolicy: profile.modelPolicy && typeof profile.modelPolicy === 'object'
        ? profile.modelPolicy
        : null,
      quotaPolicy,
      enabled: profile.enabled !== false,
      status: normalizeProviderStatus(profile.status),
    };
    const createdAt = trimString(existingIndex >= 0 ? profiles[existingIndex].createdAt : '') || nowIso;
    // Re-importing identical content must be a no-op (byte-stable registry
    // files); only a real semantic change bumps updatedAt.
    const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
    const unchanged = existing
      && existing.agentType === semantic.agentType
      && trimString(existing.syncId || existing.id) === semantic.syncId
      && existing.protocol === semantic.protocol
      && trimString(existing.displayName) === semantic.displayName
      && trimString(existing.baseUrl) === semantic.baseUrl
      && trimString(existing.authProfileId) === semantic.authProfileId
      && JSON.stringify(existing.modelPolicy || null) === JSON.stringify(semantic.modelPolicy)
      && JSON.stringify(existing.quotaPolicy || null) === JSON.stringify(semantic.quotaPolicy)
      && (existing.enabled !== false) === semantic.enabled
      && normalizeProviderStatus(existing.status) === semantic.status;
    const nextRow = unchanged
      ? existing
      : { ...semantic, createdAt, updatedAt: nowIso };
    if (existingIndex >= 0) {
      profiles[existingIndex] = nextRow;
    } else {
      profiles.push(nextRow);
    }
    await writeRegistryFile(providersFile, {
      version: NATIVE_PROVIDER_REGISTRY_VERSION,
      profiles,
    });
    return { ok: true, profile: { ...nextRow, revision: computeProfileRevision(nextRow) } };
  }

  async function deleteProviderProfile(providerId) {
    const id = trimString(providerId);
    const rows = await readRegistryFile(providersFile);
    const profiles = Array.isArray(rows.profiles) ? rows.profiles : [];
    const nextProfiles = profiles.filter((row) => row.id !== id);
    if (nextProfiles.length === profiles.length) return { ok: false, reason: 'not-found' };
    await writeRegistryFile(providersFile, {
      version: NATIVE_PROVIDER_REGISTRY_VERSION,
      profiles: nextProfiles,
    });
    return { ok: true };
  }

  // —— AuthProfiles ——

  async function listAuthProfiles() {
    const registry = await readRegistryFile(authFile);
    const rows = Array.isArray(registry.profiles) ? registry.profiles : [];
    return rows.map((row) => ({ ...row, revision: computeProfileRevision(row) }));
  }

  async function getAuthProfile(authProfileId) {
    const id = trimString(authProfileId);
    if (!id) return null;
    const rows = await listAuthProfiles();
    return rows.find((row) => row.id === id) || null;
  }

  async function upsertAuthProfile(profile) {
    const validation = validateAuthProfile(profile);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const rows = await readRegistryFile(authFile);
    const profiles = Array.isArray(rows.profiles) ? rows.profiles : [];
    const id = trimString(profile.id);
    const existingIndex = profiles.findIndex((row) => row.id === id);
    const nowIso = new Date().toISOString();
    const semantic = {
      id,
      agentType: normalizeAgentType(profile.agentType),
      authType: trimString(profile.authType),
      displayName: trimString(profile.displayName) || id,
      storageType: 'secret-store',
      storageRef: trimString(profile.storageRef),
      accountMetadata: profile.accountMetadata && typeof profile.accountMetadata === 'object'
        ? profile.accountMetadata
        : null,
    };
    const createdAt = trimString(existingIndex >= 0 ? profiles[existingIndex].createdAt : '') || nowIso;
    const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
    const unchanged = existing
      && existing.agentType === semantic.agentType
      && existing.authType === semantic.authType
      && trimString(existing.displayName) === semantic.displayName
      && trimString(existing.storageRef) === semantic.storageRef
      && JSON.stringify(existing.accountMetadata || null) === JSON.stringify(semantic.accountMetadata);
    const nextRow = unchanged
      ? existing
      : { ...semantic, createdAt, updatedAt: nowIso };
    if (existingIndex >= 0) {
      profiles[existingIndex] = nextRow;
    } else {
      profiles.push(nextRow);
    }
    await writeRegistryFile(authFile, {
      version: NATIVE_PROVIDER_REGISTRY_VERSION,
      profiles,
    });
    return { ok: true, profile: { ...nextRow, revision: computeProfileRevision(nextRow) } };
  }

  async function deleteAuthProfile(authProfileId) {
    const id = trimString(authProfileId);
    const rows = await readRegistryFile(authFile);
    const profiles = Array.isArray(rows.profiles) ? rows.profiles : [];
    // Refuse to delete an AuthProfile a ProviderProfile still references.
    const providers = await listProviderProfiles();
    if (providers.some((row) => row.authProfileId === id)) {
      return { ok: false, reason: 'referenced-by-provider' };
    }
    const remainingProfiles = profiles.filter((row) => row.id !== id);
    if (remainingProfiles.length === profiles.length) return { ok: false, reason: 'not-found' };
    await writeRegistryFile(authFile, {
      version: NATIVE_PROVIDER_REGISTRY_VERSION,
      profiles: remainingProfiles,
    });
    return { ok: true };
  }

  return {
    listProviderProfiles,
    getProviderProfile,
    upsertProviderProfile,
    deleteProviderProfile,
    listAuthProfiles,
    getAuthProfile,
    upsertAuthProfile,
    deleteAuthProfile,
  };
}
