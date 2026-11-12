import { WORKBENCH_EXECUTION_POLICY, assertWorkbenchProviderSetup } from '../lib/workbench-execution-policy.mjs';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'node:perf_hooks';
import { chmod, mkdir, readFile, readdir, rm, stat } from 'fs/promises';
import { delimiter, dirname, join } from 'path';

import { CONFIG_DIR } from '../lib/config.mjs';
import {
  ACCOUNT_POLICY_SYNC_KEY,
  loadAccountPolicy,
  normalizeAccountPermissionPolicy,
  saveAccountPolicy,
} from '../lib/account-policy.mjs';
import { buildPlatformSpawnSpec } from '../lib/executable-resolution.mjs';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from '../lib/windows-managed-spawn.mjs';
import {
  AGY_AUTH_RELATIVE_PATH,
  buildAgyRuntimeEnv,
  buildAgyRuntimeLaunchSpec,
  buildAgyRuntimeShellCommand,
} from '../lib/agy-runtime.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';
import { getHarnessDefinition } from '../lib/harness-registry.mjs';
import { resolveRunnerProxyEnvironment } from '../lib/network-proxy.mjs';
import { applyAgentSyncProfile, listAgentSyncProfiles } from './apps.mjs';
import { normalizeQuotaPolicy } from '../lib/provider-runtime/registry.mjs';
import {
  compareSyncVersions,
  mergeAccountSyncRecords,
  normalizeAccountSyncRecord,
  normalizeProviderSyncRecord,
  isMachineLocalOAuthProvider,
  isMachineLocalOAuthSyncRecord,
} from '../lib/provider-runtime/sync.mjs';
import {
  createCredentialMutationLedger,
  credentialSecretFingerprint,
} from '../lib/provider-runtime/credential-mutation.mjs';
import { syncRecordIdentity } from '../lib/account-sync.mjs';
import { inferProviderQuotaPolicy } from '../lib/provider-runtime/quota.mjs';
import { migrateLegacyAgyProvider } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { getAdaptiveConcurrencyBudget } from './adaptive-concurrency-registry.mjs';
import { createProviderSyncLedger } from '../lib/provider-runtime/sync-ledger.mjs';
import { assertProviderSyncHistory } from '../lib/provider-runtime/json-data.mjs';

const NATIVE_LOGIN_ROOT = join(CONFIG_DIR, 'native-provider-runtime', 'login-jobs');
const HARNESS_AGENT_TYPES = new Set(['pi', 'deepseek-harness', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo']);
const SUPPORTED_AGENT_TYPES = new Set(['codex', 'claude', 'agy', ...HARNESS_AGENT_TYPES]);
const LOGIN_AGENT_TYPES = new Set(['codex', 'agy']);
export const AGY_OFFICIAL_PROVIDER_ID = 'agy-official';
export const CODEX_DEVICE_LOGIN_URL = 'https://auth.openai.com/codex/device';
// AgY only emits its browser OAuth handoff from print mode. An empty argv
// starts the interactive TUI and never exposes the URL to the control plane.
const AGY_BROWSER_LOGIN_PROMPT = 'Sign in to Ragent in your browser.';
const loginJobs = new Map();
const provisionQueue = createSerialTaskQueue();
const providerIoBudget = getAdaptiveConcurrencyBudget('providerIO');

function terminateLoginProcess(child) {
  if (!child) return;
  terminateProviderProcessTree(child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    terminateProviderProcessTree(child, 'SIGKILL');
  }, 5_000);
  killTimer.unref?.();
}

// Provider credential/status reads are independent but may touch several
// files per profile. Bound the fan-out so a large account catalog does not
// create an unbounded burst of secret-store and quota I/O.
async function mapWithConcurrency(items, concurrency, mapper, { priority = 'interactive' } = {}) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];
  const results = new Array(source.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      const startedAt = performance.now();
      const lease = await providerIoBudget.acquire({
        priority,
        wait: true,
        deadlineMs: 30_000,
      });
      if (!lease) throw new Error('providerIO adaptive budget unavailable');
      try {
        results[index] = await mapper(source[index], index);
        lease.release({ durationMs: performance.now() - startedAt, outcome: 'success' });
      } catch (error) {
        lease.release({ durationMs: performance.now() - startedAt, outcome: 'error' });
        throw error;
      }
    }
  };
  const effectiveConcurrency = Math.max(
    1,
    Math.min(
      source.length,
      Math.max(1, concurrency),
      Number.isInteger(providerIoBudget.effectiveLimit)
        ? providerIoBudget.effectiveLimit
        : concurrency,
    ),
  );
  await Promise.all(Array.from({
    length: Math.min(Math.max(1, effectiveConcurrency), source.length),
  }, () => worker()));
  return results;
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAgentType(value) {
  const normalized = trim(value).toLowerCase();
  const canonical = normalized === 'kilo-code' ? 'kilo' : normalized;
  return SUPPORTED_AGENT_TYPES.has(canonical) ? canonical : '';
}

function normalizeLoginAgentType(value) {
  const normalized = trim(value).toLowerCase();
  return LOGIN_AGENT_TYPES.has(normalized) ? normalized : '';
}

function safeLabel(value, fallback) {
  const normalized = trim(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || fallback;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLoginText(value, deviceCode = '') {
  let text = String(value || '')
    .replace(/https?:\/\/[^\s"'<>\u001b]+/gi, (candidate) => {
      try {
        const url = new URL(candidate.replace(/[),.;]+$/, ''));
        url.search = '';
        url.hash = '';
        return url.toString().replace(/[),.;]+$/, '');
      } catch {
        return candidate.replace(/[?#].*$/, '');
      }
    })
    .replace(/(bearer\s+|(?:access|refresh|id)[_-]?token\s*[:=]\s*|(?:api[_-]?key|user[_-]?code|device[_-]?code|code|state|token|key|secret|credential)\s*[:=]\s*)[^\s,;|}]+/gi, '$1[redacted]')
    .replace(/("(?:access[_-]?token|refresh[_-]?token|id[_-]?token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token)\s+[^\s,;|}]+/gi, (match) => `${match.split(/\s+/)[0]} [redacted]`);
  if (deviceCode) {
    text = text.replace(new RegExp(escapeRegExp(deviceCode), 'g'), '[redacted]');
  }
  return text;
}

function summarizeLoginFailure(raw, exitCode, signal = '', deviceCode = '') {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .replace(/\s+/g, ' ');
  const detail = sanitizeLoginText(lines, deviceCode).slice(-1000);
  const exit = Number.isInteger(exitCode) ? `exit ${exitCode}` : signal ? `signal ${signal}` : 'unknown exit';
  return detail ? `LOGIN_FAILED (${exit}): ${detail}` : `LOGIN_FAILED (${exit})`;
}

function classifyLoginFailure({ agentType, raw, exitCode, signal, deviceCode, timedOut = false } = {}) {
  const normalized = String(raw || '').toLowerCase();
  if (timedOut) {
    return {
      failureCode: 'timeout',
      phase: 'timed-out',
      error: 'LOGIN_TIMEOUT: official sign-in did not finish within 10 minutes',
    };
  }
  const error = summarizeLoginFailure(raw, exitCode, signal, deviceCode);
  if (/cloudflare|cf-chl|verify you are human|security challenge|challenge required/.test(normalized)) {
    return { failureCode: 'cloudflare', phase: 'cloudflare-failed', error };
  }
  if (/(?:failed|unable) to authorize(?: this device)?|device authorization (?:failed|denied)|authorization (?:failed|denied)|device code[^\n]*(?:invalid|expired)|code[^\n]*(?:invalid|expired)/.test(normalized)) {
    return { failureCode: 'official-auth', phase: 'official-auth-failed', error };
  }
  if (agentType === 'codex' && !deviceCode) {
    return { failureCode: 'device-code', phase: 'device-code-failed', error };
  }
  return { failureCode: 'process', phase: 'process-failed', error };
}

function providerDefaults(agentType) {
  return agentType === 'codex'
    ? { protocol: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex' }
    : agentType === 'claude'
      ? { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }
      : agentType === 'agy'
        ? { protocol: 'agy', baseUrl: '' }
        : agentType === 'copilot'
          ? { protocol: 'github-copilot', baseUrl: '' }
          : { protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1' };
}

function normalizeCodexProtocol(value) {
  const normalized = trim(value).toLowerCase();
  if (normalized === 'chat' || normalized === 'openai-chat') return 'openai-chat';
  return 'openai-responses';
}

function normalizeHarnessProtocol(value, fallback = 'openai-chat') {
  const normalized = trim(value).toLowerCase();
  if (normalized === 'chat') return 'openai-chat';
  if (normalized === 'responses') return 'openai-responses';
  if (normalized === 'anthropic') return 'anthropic-messages';
  if (normalized === 'github' || normalized === 'github-copilot') return 'github-copilot';
  return ['openai-chat', 'openai-responses', 'anthropic-messages', 'github-copilot'].includes(normalized)
    ? normalized
    : fallback;
}

function quotaPolicyFromPayload(payload = {}, fallback = null) {
  const hasExplicit = payload.quotaPolicy !== undefined
    || payload.quotaMode !== undefined
    || payload.billingMode !== undefined
    || payload.quotaAdapter !== undefined
    || payload.quotaProvider !== undefined;
  if (!hasExplicit) return fallback;
  const source = payload.quotaPolicy && typeof payload.quotaPolicy === 'object'
    ? payload.quotaPolicy
    : {
      mode: payload.quotaMode ?? payload.billingMode,
      adapter: payload.quotaAdapter ?? payload.quotaProvider,
    };
  return normalizeQuotaPolicy(source);
}

function credentialIdentity(provider, auth) {
  const metadata = auth?.accountMetadata && typeof auth.accountMetadata === 'object'
    ? auth.accountMetadata
    : {};
  const accountId = trim(metadata.accountId);
  const accountKey = trim(metadata.accountKey)
    || (accountId ? `account:${provider.agentType}:${accountId}` : '')
    || `provider:${provider.agentType}:${trim(provider.syncId || provider.id)}`;
  const derivedInstance = `instance-${createHash('sha256')
    .update(`${accountKey}:${trim(auth?.storageRef)}`)
    .digest('hex')
    .slice(0, 32)}`;
  return {
    accountKey,
    credentialInstanceId: trim(metadata.credentialInstanceId) || derivedInstance,
  };
}

function credentialMutationError(result) {
  const status = trim(result?.status) || 'rejected';
  const error = new Error(`Credential mutation ${status}.`);
  error.code = `credential_${status.replaceAll('-', '_')}`;
  error.statusCode = status === 'conflict' ? 409 : status === 'tombstoned' ? 410 : 409;
  return error;
}

async function restoreCredentialSecret(secretStore, storageRef, previous) {
  if (previous?.ok && previous.authType === 'api-key') {
    await secretStore.writeSecret(storageRef, {
      authType: 'api-key',
      apiKey: previous.apiKey,
    });
    return;
  }
  if (previous?.ok && previous.authType === 'oauth') {
    await secretStore.writeSecret(storageRef, {
      authType: 'oauth',
      tokens: previous.tokens,
    });
    return;
  }
  if (previous?.ok && previous.authType === 'oauth-token') {
    await secretStore.writeSecret(storageRef, {
      authType: 'oauth-token',
      token: previous.token,
    });
    return;
  }
  await secretStore.deleteSecret(storageRef);
}

// All credential writes pass through this helper. The payload is briefly
// handed to SecretStore, while the CAS ledger receives only metadata. A
// rejected CAS restores the prior local secret so stale writers cannot alter
// the active credential even transiently.
async function commitCredentialMutation({
  registry,
  secretStore,
  credentialLedger,
  provider,
  auth,
  secretPayload,
  sourceInstanceId,
  configDir = CONFIG_DIR,
  rotate = false,
  deleted = false,
  previousAuthProfile = null,
} = {}) {
  const mutationLedger = credentialLedger || createCredentialMutationLedger({ configDir });
  const identity = credentialIdentity(provider, auth);
  const current = await mutationLedger.getRecord(identity.accountKey);
  let previous = null;
  const authToRestore = previousAuthProfile || auth;
  const previousAuth = {
    ...authToRestore,
    ...(authToRestore.accountMetadata && typeof authToRestore.accountMetadata === 'object'
      ? { accountMetadata: { ...authToRestore.accountMetadata } }
      : {}),
  };
  const sideEffect = {
    apply: async ({ record }) => {
      previous = await secretStore.resolveSecret(auth.storageRef).catch(() => null);
      if (deleted) {
        const deletedSecret = await secretStore.deleteSecret(auth.storageRef);
        if (!deletedSecret?.ok) {
          throw new Error(`Unable to remove provider credential (${deletedSecret?.reason || 'secret-store-failed'})`);
        }
      } else {
        const secretResult = await secretStore.writeSecret(auth.storageRef, secretPayload);
        if (!secretResult?.ok) {
          throw new Error(`Unable to store provider credential (${secretResult.reason || 'secret-store-failed'})`);
        }
      }
      const nextMetadata = {
        ...(auth.accountMetadata && typeof auth.accountMetadata === 'object' ? auth.accountMetadata : {}),
        accountKey: identity.accountKey,
        credentialInstanceId: record.credentialInstanceId,
        credentialVersion: record.credentialVersion,
      };
      const authResult = await registry.upsertAuthProfile({
        ...auth,
        accountMetadata: nextMetadata,
      });
      if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to update credential metadata');
    },
    rollback: async () => {
      await restoreCredentialSecret(secretStore, auth.storageRef, previous);
      await registry.upsertAuthProfile(previousAuth).catch(() => {});
    },
  };
  let result;
  if (deleted) {
    result = await mutationLedger.remove({
      accountKey: identity.accountKey,
      credentialInstanceId: current?.credentialInstanceId || identity.credentialInstanceId,
      expectedVersion: current?.credentialVersion || 0,
      sourceDeviceId: sourceInstanceId,
    }, sideEffect);
  } else {
    result = rotate
      ? await mutationLedger.rotate({
        accountKey: identity.accountKey,
        previousCredentialInstanceId: current?.credentialInstanceId || '',
        newCredentialInstanceId: `instance-${randomUUID()}`,
        secretPayload,
        secretRef: auth.storageRef,
        sourceDeviceId: sourceInstanceId,
      }, sideEffect)
      : await mutationLedger.submit({
        accountKey: identity.accountKey,
        credentialInstanceId: current?.credentialInstanceId || identity.credentialInstanceId,
        expectedVersion: current?.credentialVersion || 0,
        secretPayload,
        secretRef: auth.storageRef,
        sourceDeviceId: sourceInstanceId,
      }, sideEffect);
  }
  if (result?.status !== 'accepted') {
    throw credentialMutationError(result);
  }
  return {
    ...result,
    authProfile: await registry.getAuthProfile(auth.id),
    accountKey: identity.accountKey,
  };
}

export function projectLoginOutput(value) {
  const text = String(value || '').slice(-12_000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const url = text.match(/https?:\/\/[^\s"'<>\u001b]+/i)?.[0]?.replace(/[),.;]+$/, '') || '';
  // Codex prints "command-line" in its welcome banner before the actual
  // device code. Device codes are uppercase; keep the match case-sensitive
  // so prose cannot become a sticky false-positive.
  const code = text.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+\b/)?.[0] || '';
  return { url, code };
}

function safeJob(job) {
  if (!job) return null;
  const {
    child,
    raw,
    stagingDir,
    providerHome,
    authHomeDir,
    targetAuthHomeDir,
    baselineAuthSignature,
    ...publicJob
  } = job;
  return { ...publicJob, requiresInput: publicJob.requiresInput && !publicJob.inputSubmitted && publicJob.state === 'awaiting-input' };
}

async function ensureLoginRoot() {
  await mkdir(NATIVE_LOGIN_ROOT, { recursive: true, mode: 0o700 });
  await chmod(NATIVE_LOGIN_ROOT, 0o700).catch(() => {});
}

async function removeStaging(job) {
  if (!job?.stagingDir) return;
  await rm(job.stagingDir, { recursive: true, force: true }).catch(() => {});
}

async function readOAuthTokens(job) {
  if (job.agentType !== 'codex') {
    throw new Error('Only Codex supports Ragent-managed interactive OAuth login');
  }
  const file = join(job.providerHome, 'auth.json');
  // Windows-created JSON may carry a UTF-8/UTF-16 byte-order mark. Decode
  // explicitly; never expose JSON.parse's input excerpt for a credential file.
  const bytes = await readFile(file);
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2) throw new Error('Codex login result has an invalid UTF-16 encoding');
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2) throw new Error('Codex login result has an invalid UTF-16 encoding');
    text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  } else {
    text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Codex login result is not valid JSON (auth.json); no credential contents are included');
  }
  const source = parsed?.tokens;
  const accessToken = trim(source?.access_token || source?.accessToken);
  const refreshToken = trim(source?.refresh_token || source?.refreshToken);
  if (!accessToken || !refreshToken) throw new Error('OAuth login did not return a complete Codex token pair');
  return {
    tokens: {
      ...source,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    accountMetadata: {
      accountId: trim(source?.account_id || source?.accountId || source?.account_uuid || source?.accountUuid),
    },
  };
}

async function inspectAgyAuth({ homeDir = '', statImpl = stat, readFileImpl = readFile } = {}) {
  if (!String(homeDir || '').trim()) return { loggedIn: false, signature: '', authFile: '' };
  const authFile = join(homeDir, AGY_AUTH_RELATIVE_PATH);
  try {
    const info = await statImpl(authFile);
    if (!info.isFile() || info.size <= 0) return { loggedIn: false, signature: '', authFile };
    const contents = await readFileImpl(authFile, 'utf8');
    if (!String(contents || '').trim()) return { loggedIn: false, signature: '', authFile };
    return {
      loggedIn: true,
      signature: `${info.size}:${createHash('sha256').update(String(contents).trim()).digest('hex')}`,
      authFile,
    };
  } catch {
    return { loggedIn: false, signature: '', authFile };
  }
}

export async function getAgyOfficialProviderProfile({
  checkCommand = true,
  registry,
  secretStore,
} = {}) {
  if (checkCommand) {
    const command = await resolveToolCommandPathAsync('agy').catch(() => null);
    if (!command) return null;
  }
  const nativeRegistry = registry || (await import('../lib/provider-runtime/registry.mjs'))
    .createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const nativeSecretStore = secretStore || (await import('../lib/provider-runtime/secret-store.mjs'))
    .createSecretStore({ configDir: CONFIG_DIR });
  const provider = await nativeRegistry.getProviderProfile(AGY_OFFICIAL_PROVIDER_ID).catch(() => null);
  if (provider?.agentType !== 'agy') return null;
  const authProfile = await nativeRegistry.getAuthProfile(provider.authProfileId).catch(() => null);
  if (!authProfile) return null;
  const described = await nativeSecretStore.describeSecret(authProfile.storageRef).catch(() => null);
  if (!described?.ok) return null;
  return {
    ...provider,
    id: provider.id,
    agentType: provider.agentType,
    displayName: provider.displayName || provider.id,
    modelCount: Array.isArray(provider.modelPolicy?.models) ? provider.modelPolicy.models.length : 0,
    authType: authProfile.authType,
    credentialOk: true,
    hasRefreshToken: described.hasRefreshToken === true,
    credentialFingerprint: described.fingerprint || '',
    credentialStored: true,
  };
}

function buildProvisioningPayload({ agentType, displayName, baseUrl, protocol, modelPolicy, authType, tokens, apiKey, token, accountMetadata, quotaPolicy }) {
  const defaults = providerDefaults(agentType);
  const label = trim(displayName) || `${agentType} provider`;
  const id = `${safeLabel(label, agentType)}-${randomUUID().slice(0, 8)}`;
  const authProfileId = `auth-${id}`;
  const storageRef = `secret-${id}`;
  return {
    provider: {
      id,
      agentType,
      protocol: protocol || defaults.protocol,
      displayName: label,
      baseUrl: trim(baseUrl) || defaults.baseUrl,
      authProfileId,
      modelPolicy: modelPolicy && typeof modelPolicy === 'object' ? modelPolicy : null,
      quotaPolicy: quotaPolicy || null,
    },
    auth: {
      id: authProfileId,
      agentType,
      authType,
      displayName: label,
      storageType: 'secret-store',
      storageRef,
      accountMetadata: accountMetadata && typeof accountMetadata === 'object' ? accountMetadata : null,
    },
    secret: authType === 'api-key'
      ? { authType, apiKey }
      : authType === 'oauth-token'
        ? { authType, token }
        : { authType, tokens },
  };
}

async function provisionNativeProvider({ registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir = CONFIG_DIR, ...payload }) {
  return provisionQueue(async () => {
    assertWorkbenchProviderSetup({ agentType: payload.agentType, authType: payload.authType });
    if (WORKBENCH_EXECUTION_POLICY && (await registry.listProviderProfiles()).length) {
      throw Object.assign(new Error('This workbench permits one official Provider'), { code: 'WORKBENCH_EXECUTION_POLICY_DENIED', statusCode: 403 });
    }
    const result = buildProvisioningPayload(payload);
    const authResult = await registry.upsertAuthProfile(result.auth);
    if (!authResult?.ok) {
      throw new Error(authResult.errors?.join(', ') || 'Unable to create auth profile');
    }
    const providerResult = await registry.upsertProviderProfile(result.provider);
    if (!providerResult?.ok) {
      await registry.deleteAuthProfile(result.auth.id);
      throw new Error(providerResult.errors?.join(', ') || 'Unable to create provider profile');
    }
    let credentialResult;
    try {
      credentialResult = await commitCredentialMutation({
        registry,
        secretStore,
        credentialLedger,
        provider: providerResult.profile,
        auth: authResult.profile,
        secretPayload: result.secret,
        sourceInstanceId,
        configDir,
      });
    } catch (error) {
      await registry.deleteProviderProfile(result.provider.id);
      await registry.deleteAuthProfile(result.auth.id);
      await secretStore.deleteSecret(result.auth.storageRef);
      throw error;
    }
    await recordProviderSyncMutation({
      registry,
      secretStore,
      ledger,
      provider: providerResult.profile,
      sourceInstanceId,
    });
    return {
      provider: providerResult.profile,
      authProfile: credentialResult.authProfile,
    };
  });
}

export async function listNativeProviderProfiles({ registry, secretStore, quotaStore, includeAgy = false } = {}) {
  if (includeAgy) {
    await migrateLegacyAgyProvider({
      registry,
      secretStore,
      displayName: 'agy legacy account',
    }).catch(() => null);
  }
  const [providers, authProfiles] = await Promise.all([
    registry.listProviderProfiles(),
    registry.listAuthProfiles(),
  ]);
  const authById = new Map(authProfiles.map((profile) => [profile.id, profile]));
  const rows = await mapWithConcurrency(providers, 8, async (profile) => {
    const authProfile = authById.get(profile.authProfileId);
    if (!authProfile || !SUPPORTED_AGENT_TYPES.has(profile.agentType)) return null;
    const described = await secretStore.describeSecret(authProfile.storageRef).catch(() => null);
    const claudeOAuthRemoved = profile.agentType === 'claude' && authProfile.authType === 'oauth';
    return {
      id: profile.id,
      syncId: profile.syncId || profile.id,
      enabled: profile.enabled !== false,
      agentType: profile.agentType,
      displayName: profile.displayName || profile.id,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      modelPolicy: profile.modelPolicy || null,
      modelCount: Array.isArray(profile.modelPolicy?.models) ? profile.modelPolicy.models.length : 0,
      quotaPolicy: profile.quotaPolicy || null,
      quota: quotaStore ? await quotaStore.get(profile.id).catch(() => null) : null,
      authType: authProfile.authType,
      credentialOk: described?.ok === true && !claudeOAuthRemoved,
      ...(claudeOAuthRemoved ? { migrationRequired: 'claude-setup-token' } : {}),
      hasRefreshToken: described?.hasRefreshToken === true,
      hasLongLivedToken: described?.hasLongLivedToken === true,
      credentialFingerprint: described?.fingerprint || '',
      revision: profile.revision,
      createdAt: profile.createdAt || '',
      updatedAt: profile.updatedAt || '',
    };
  });
  return rows.filter(Boolean);
}

// The sync representation is intentionally separate from the UI projection:
// it contains the complete credential payload, but only callers behind the
// device-to-device encrypted envelope may request it.
export async function listProviderSyncRecords({ registry, secretStore, sourceInstanceId } = {}) {
  const [providers, authProfiles] = await Promise.all([
    registry.listProviderProfiles(),
    registry.listAuthProfiles(),
  ]);
  const authById = new Map(authProfiles.map((profile) => [profile.id, profile]));
  const providerRecords = await mapWithConcurrency(providers, 8, async (provider) => {
    if (!SUPPORTED_AGENT_TYPES.has(provider.agentType)) return null;
    const auth = authById.get(provider.authProfileId);
    if (!auth) return null;
    // Official native OAuth credentials (Codex/AgY) and Claude setup tokens
    // are machine-local. Their credential payloads must never enter a peer
    // sync snapshot, even though the transport envelope is encrypted.
    if (isMachineLocalOAuthProvider({ provider, auth })) return null;
    const secret = await secretStore.resolveSecret(auth.storageRef).catch(() => null);
    if (!secret?.ok) return null;
    const updatedAt = [provider.updatedAt, auth.updatedAt]
      .map((value) => Date.parse(value || ''))
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), 0);
    return {
      scope: 'provider',
      ...normalizeProviderSyncRecord({
        key: provider.syncId || provider.id,
        version: {
          updatedAt: new Date(updatedAt || Date.now()).toISOString(),
          counter: 0,
          writerId: sourceInstanceId,
        },
        provider,
        auth,
        secret: {
          ...(secret.authType === 'api-key' ? { authType: 'api-key', apiKey: secret.apiKey }
            : secret.authType === 'oauth-token' ? { authType: 'oauth-token', token: secret.token }
              : { authType: 'oauth', tokens: secret.tokens }),
        },
      }, sourceInstanceId),
    };
  });
  const records = providerRecords.filter(Boolean);
  return records;
}

async function recordProviderSyncMutation({
  registry,
  secretStore,
  ledger,
  provider,
  sourceInstanceId,
} = {}) {
  if (!ledger?.nextVersion || !provider || !sourceInstanceId) return;
  const records = await listProviderSyncRecords({ registry, secretStore, sourceInstanceId });
  const record = records.find((item) => item.key === (provider.syncId || provider.id));
  if (!record) return;
  // The credential may change without changing the ProviderProfile row. Use
  // the mutation time so an API-key/OAuth refresh is still a real LWW write.
  record.scope = 'provider';
  record.version = await ledger.nextVersion(sourceInstanceId);
  await ledger.merge([record]);
}

async function listCredentialSyncRecords({
  registry,
  secretStore,
  credentialLedger,
  sourceInstanceId,
  configDir = CONFIG_DIR,
} = {}) {
  const mutationLedger = credentialLedger || createCredentialMutationLedger({ configDir });
  const [providers, authProfiles, knownRecords] = await Promise.all([
    registry.listProviderProfiles(),
    registry.listAuthProfiles(),
    mutationLedger.listRecords(),
  ]);
  const authById = new Map(authProfiles.map((profile) => [profile.id, profile]));
  const knownByKey = new Map(knownRecords.map((record) => [record.key, record]));
  const providerRecords = await mapWithConcurrency(providers, 8, async (provider) => {
    if (!SUPPORTED_AGENT_TYPES.has(provider.agentType)) return null;
    const auth = authById.get(provider.authProfileId);
    if (!auth) return null;
    if (isMachineLocalOAuthProvider({ provider, auth })) return null;
    const secret = await secretStore.resolveSecret(auth.storageRef).catch(() => null);
    if (!secret?.ok) return null;
    const identity = credentialIdentity(provider, auth);
    const known = knownByKey.get(identity.accountKey);
    if (known?.deletedAt) return null;
    const updatedAt = [provider.updatedAt, auth.updatedAt]
      .map((value) => Date.parse(value || ''))
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), 0);
    const version = known?.version || {
      updatedAt: new Date(updatedAt || Date.now()).toISOString(),
      counter: known?.credentialVersion || 0,
      writerId: sourceInstanceId,
    };
    return {
      scope: 'provider-credential',
      key: identity.accountKey,
      credentialInstanceId: known?.credentialInstanceId || identity.credentialInstanceId,
      credentialVersion: known?.credentialVersion || 0,
      agentType: provider.agentType,
      authType: secret.authType,
      secretRef: auth.storageRef,
      credentialFingerprint: known?.credentialFingerprint || credentialSecretFingerprint({
        authType: secret.authType,
        ...(secret.authType === 'api-key' ? { apiKey: secret.apiKey }
          : secret.authType === 'oauth-token' ? { token: secret.token }
            : { tokens: secret.tokens }),
      }),
      ...(known?.previousFingerprint ? { previousFingerprint: known.previousFingerprint } : {}),
      ...(known?.updatedByDeviceId ? { updatedByDeviceId: known.updatedByDeviceId } : {}),
      version,
      secret: secret.authType === 'api-key'
        ? { authType: 'api-key', apiKey: secret.apiKey }
        : secret.authType === 'oauth-token'
          ? { authType: 'oauth-token', token: secret.token }
          : { authType: 'oauth', tokens: secret.tokens },
    };
  });
  const records = providerRecords.filter(Boolean);
  // A deleted credential has no provider row left to enumerate, but its
  // tombstone must still be published so an offline peer cannot resurrect it.
  for (const record of knownRecords) {
    if (record.deletedAt && !records.some((entry) => entry.key === record.key)) {
      records.push(record);
    }
  }
  return records;
}

async function ledgerRecordMap(ledger) {
  const state = await ledger?.readState?.() || { records: [] };
  return new Map((state.records || []).map((record) => [
    syncRecordIdentity(record.scope || 'provider', record.key),
    record,
  ]));
}

export async function listAgentSyncRecords({ sourceInstanceId, ledger } = {}) {
  const records = [];
  const ledgerByIdentity = await ledgerRecordMap(ledger);
  for (const agent of await listAgentSyncProfiles()) {
    const key = agent.id;
    const known = ledgerByIdentity.get(syncRecordIdentity('agent-profile', key));
    const version = known?.version || {
      updatedAt: agent.updatedAt || agent.createdAt || new Date().toISOString(),
      counter: 0,
      writerId: sourceInstanceId,
    };
    if (agent.deleted) {
      records.push({ scope: 'agent-profile', key, version, deletedAt: agent.deletedAt || version.updatedAt });
    } else {
      records.push({ scope: 'agent-profile', key, version, agent });
    }
  }
  return records;
}

// The account permission policy is a single fixed-key record. An instance
// that never published a policy emits nothing: receiving instances keep their
// own value until an owner sets or clears the policy somewhere in the
// account. A clear is published as a newer record with an empty mode (there
// are no tombstones for this scope), and is only emitted when the ledger
// shows this instance actually mutated the record before.
export async function listRuntimePolicySyncRecords({ sourceInstanceId, ledger, filePath } = {}) {
  const [policy, ledgerVersion] = await Promise.all([
    loadAccountPolicy(filePath),
    ledgerRuntimePolicyVersion(ledger, ACCOUNT_POLICY_SYNC_KEY),
  ]);
  const mode = policy?.permissionPolicy;
  const isSet = Boolean(normalizeAccountPermissionPolicy(mode));
  if (!isSet && !ledgerVersion) return [];
  const version = ledgerVersion || {
    updatedAt: policy.updatedAt || new Date().toISOString(),
    counter: 0,
    writerId: sourceInstanceId,
  };
  return [{
    scope: 'runtime-policy',
    key: ACCOUNT_POLICY_SYNC_KEY,
    version,
    policy: { permissionPolicy: isSet ? mode : '' },
  }];
}

async function ledgerRuntimePolicyVersion(ledger, key) {
  const ledgerByIdentity = await ledgerRecordMap(ledger);
  return ledgerByIdentity.get(syncRecordIdentity('runtime-policy', key))?.version || null;
}

export async function listAccountSyncRecords({
  registry,
  secretStore,
  ledger,
  credentialLedger,
  sourceInstanceId,
  configDir = CONFIG_DIR,
} = {}) {
  if (ledger?.readState) assertProviderSyncHistory(await ledger.readState());
  const [providers, agents, credentials, runtimePolicies] = await Promise.all([
    listProviderSyncRecords({ registry, secretStore, sourceInstanceId }),
    listAgentSyncRecords({ sourceInstanceId, ledger }),
    listCredentialSyncRecords({ registry, secretStore, credentialLedger, sourceInstanceId, configDir }),
    listRuntimePolicySyncRecords({ sourceInstanceId, ledger }),
  ]);
  const ledgerByIdentity = await ledgerRecordMap(ledger);
  const records = providers.map((record) => ({
    ...record,
    version: ledgerByIdentity.get(syncRecordIdentity('provider', record.key))?.version || record.version,
  }));
  const activeIdentities = new Set(records.map((record) => syncRecordIdentity(record.scope, record.key)));
  for (const record of agents) {
    records.push(record);
    activeIdentities.add(syncRecordIdentity(record.scope, record.key));
  }
  for (const record of credentials) {
    records.push(record);
    activeIdentities.add(syncRecordIdentity(record.scope, record.key));
  }
  for (const record of runtimePolicies) {
    records.push(record);
    activeIdentities.add(syncRecordIdentity(record.scope, record.key));
  }
  for (const record of ledgerByIdentity.values()) {
    const identity = syncRecordIdentity(record.scope || 'provider', record.key);
    if (record.deletedAt && !activeIdentities.has(identity)) {
      records.push({ scope: record.scope || 'provider', key: record.key, version: record.version, deletedAt: record.deletedAt });
    }
  }
  return records;
}

export async function recordAgentProfileSyncMutation({ ledger, sourceInstanceId, agent, deleted = false } = {}) {
  const key = typeof agent?.id === 'string' ? agent.id.trim() : '';
  if (!ledger?.nextVersion || !sourceInstanceId || !key) return;
  const version = await ledger.nextVersion(sourceInstanceId);
  await ledger.merge([{
    scope: 'agent-profile',
    key,
    version,
    ...(deleted ? { deletedAt: version.updatedAt } : {}),
  }]);
}

export async function recordRuntimePolicySyncMutation({ ledger, sourceInstanceId } = {}) {
  const key = ACCOUNT_POLICY_SYNC_KEY;
  if (!ledger?.nextVersion || !sourceInstanceId || !key) return;
  const version = await ledger.nextVersion(sourceInstanceId);
  await ledger.merge([{ scope: 'runtime-policy', key, version }]);
}

async function applyProviderSyncRecord({
  registry,
  secretStore,
  record,
  writeCredential = true,
  credentialRecord = null,
} = {}) {
  const providers = await registry.listProviderProfiles();
  const localProvider = providers.find((item) => (item.syncId || item.id) === record.key);
  if (record.deletedAt) {
    if (localProvider) {
      const auth = await registry.getAuthProfile(localProvider.authProfileId);
      await registry.deleteProviderProfile(localProvider.id);
      if (auth) {
        const deletedAuth = await registry.deleteAuthProfile(auth.id);
        if (deletedAuth?.ok) await secretStore.deleteSecret(auth.storageRef);
      }
    }
    return;
  }
  if (!record.provider || !record.auth || (writeCredential && !record.secret)) {
    throw new Error('Provider sync record payload is incomplete');
  }
  if (localProvider && localProvider.id !== record.provider.id) {
    const oldAuth = await registry.getAuthProfile(localProvider.authProfileId);
    await registry.deleteProviderProfile(localProvider.id);
    if (oldAuth) {
      await registry.deleteAuthProfile(oldAuth.id);
      await secretStore.deleteSecret(oldAuth.storageRef);
    }
  }
  const currentAuth = localProvider ? await registry.getAuthProfile(localProvider.authProfileId) : null;
  const oldAuth = currentAuth
    && (currentAuth.id !== record.auth.id || currentAuth.storageRef !== record.auth.storageRef)
    ? currentAuth
    : null;
  if (writeCredential) {
    const secretResult = await secretStore.writeSecret(record.auth.storageRef, record.secret);
    if (!secretResult?.ok) throw new Error(`Unable to import provider credential (${secretResult.reason || 'secret-store-failed'})`);
  }
  const authMetadata = credentialRecord && !credentialRecord.deletedAt
    ? {
      ...(record.auth.accountMetadata && typeof record.auth.accountMetadata === 'object'
        ? record.auth.accountMetadata
        : {}),
      accountKey: credentialRecord.key,
      credentialInstanceId: credentialRecord.credentialInstanceId,
      credentialVersion: credentialRecord.credentialVersion,
    }
    : null;
  const authResult = await registry.upsertAuthProfile({
    ...record.auth,
    ...(authMetadata ? { accountMetadata: authMetadata } : {}),
  });
  if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to import provider auth profile');
  const providerResult = await registry.upsertProviderProfile(record.provider);
  if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to import provider profile');
  if (oldAuth) {
    await registry.deleteAuthProfile(oldAuth.id);
    if (oldAuth.storageRef !== record.auth.storageRef) await secretStore.deleteSecret(oldAuth.storageRef);
  }
}

async function applyCredentialSyncRecord({ registry, secretStore, record } = {}) {
  const providers = await registry.listProviderProfiles();
  const authProfiles = await registry.listAuthProfiles();
  const authById = new Map(authProfiles.map((profile) => [profile.id, profile]));
  const localAuth = providers
    .map((provider) => authById.get(provider.authProfileId))
    .find((auth) => {
      const metadata = auth?.accountMetadata && typeof auth.accountMetadata === 'object'
        ? auth.accountMetadata
        : {};
      return trim(metadata.accountKey) === trim(record.key)
        || trim(auth?.storageRef) === trim(record.secretRef);
    });
  const targetRef = localAuth?.storageRef || record.secretRef;
  const refs = [...new Set([record.secretRef, targetRef].filter(Boolean))];
  const changes = await Promise.all(refs.map(async (ref) => ({
    ref,
    previous: await secretStore.resolveSecret(ref).catch(() => null),
  })));
  const previousAuth = localAuth
    ? {
      ...localAuth,
      ...(localAuth.accountMetadata && typeof localAuth.accountMetadata === 'object'
        ? { accountMetadata: { ...localAuth.accountMetadata } }
        : {}),
    }
    : null;
  let authMetadataApplied = false;
  const rollback = async () => {
    for (const change of [...changes].reverse()) {
      await restoreCredentialSecret(secretStore, change.ref, change.previous);
    }
    if (authMetadataApplied && previousAuth) {
      await registry.upsertAuthProfile(previousAuth).catch(() => {});
    }
  };
  try {
    if (record.deletedAt) {
      for (const ref of refs) await secretStore.deleteSecret(ref);
      return { changes, rollback };
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  if (!targetRef || !record.secret || typeof record.secret !== 'object') {
    throw new Error('Credential sync record payload is incomplete');
  }
  try {
    const result = await secretStore.writeSecret(targetRef, record.secret);
    if (!result?.ok) throw new Error(`Unable to import provider credential (${result.reason || 'secret-store-failed'})`);
    if (localAuth) {
      const currentMetadata = localAuth.accountMetadata && typeof localAuth.accountMetadata === 'object'
        ? localAuth.accountMetadata
        : {};
      const authResult = await registry.upsertAuthProfile({
        ...localAuth,
        accountMetadata: {
          ...currentMetadata,
          accountKey: record.key,
          credentialInstanceId: record.credentialInstanceId,
          credentialVersion: record.credentialVersion,
        },
      });
      if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to import credential metadata');
      authMetadataApplied = true;
    }
    return { changes, rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function applyAccountSyncRecords({
  registry,
  secretStore,
  ledger,
  credentialLedger,
  localInstanceId = 'local',
  incoming = [],
  configDir = CONFIG_DIR,
} = {}) {
  if (!ledger?.readState || !ledger?.writeState) {
    throw new Error('Account sync ledger is required');
  }
  const state = await ledger.readState();
  assertProviderSyncHistory(state);
  const mutationLedger = credentialLedger || createCredentialMutationLedger({ configDir });
  const machineLocalIncoming = incoming.filter((record) => isMachineLocalOAuthSyncRecord(record));
  const safeIncoming = incoming.filter((record) => !isMachineLocalOAuthSyncRecord(record));
  const credentialIncoming = safeIncoming.filter((record) => (record?.scope || 'provider') === 'provider-credential');
  const unknownPolicyIncoming = safeIncoming.filter((record) => {
    if (record?.scope !== 'runtime-policy') return false;
    const mode = record?.policy?.permissionPolicy;
    return typeof mode !== 'string' || (mode !== '' && !normalizeAccountPermissionPolicy(mode));
  });
  const regularIncoming = safeIncoming.filter((record) => (
    (record?.scope || 'provider') !== 'provider-credential'
    && !unknownPolicyIncoming.includes(record)
  ));
  const appliedCredentialChanges = [];
  const credentialMerged = await mutationLedger.merge(credentialIncoming, {
    apply: async ({ merged }) => {
      for (const record of merged.acceptedRecords) {
        appliedCredentialChanges.push(await applyCredentialSyncRecord({ registry, secretStore, record }));
      }
    },
    rollback: async () => {
      for (const applied of appliedCredentialChanges.reverse()) await applied?.rollback?.();
    },
  });
  const localRecords = await listAccountSyncRecords({
    registry,
    secretStore,
    ledger,
    credentialLedger: mutationLedger,
    sourceInstanceId: localInstanceId,
    configDir,
  });
  const known = new Map();
  for (const record of [...state.records, ...localRecords].filter((entry) => (entry?.scope || 'provider') !== 'provider-credential')) {
    const normalized = normalizeAccountSyncRecord(record, localInstanceId);
    const identity = syncRecordIdentity(normalized.scope, normalized.key);
    const prior = known.get(identity);
    if (!prior || compareSyncVersions(normalized.version, prior.version) > 0) known.set(identity, normalized);
  }
  const merged = mergeAccountSyncRecords([...known.values()], regularIncoming, localInstanceId);
  const acceptedRecords = merged.acceptedRecords;
  for (const record of acceptedRecords) {
    if (record.scope === 'provider') {
      const accountKey = trim(record.auth?.accountMetadata?.accountKey);
      const dedicatedCredential = credentialIncoming.find((credential) => (
        trim(credential.key) === accountKey
        || trim(credential.secretRef) === trim(record.auth?.storageRef)
      )) || null;
      await applyProviderSyncRecord({
        registry,
        secretStore,
        record,
        writeCredential: !dedicatedCredential,
        credentialRecord: dedicatedCredential
          ? credentialMerged.records.find((credential) => (
            trim(credential.key) === trim(dedicatedCredential.key)
            || trim(credential.secretRef) === trim(dedicatedCredential.secretRef)
          )) || dedicatedCredential
          : null,
      });
    } else if (record.scope === 'agent-profile') {
      await applyAgentSyncProfile(record.deletedAt ? { id: record.key, deletedAt: record.deletedAt } : record.agent);
    } else if (record.scope === 'runtime-policy') {
      // '' is a published clear. An unknown future mode must not become the
      // built-in full-auto default on an older instance.
      if (record.policy && typeof record.policy.permissionPolicy === 'string') {
        const mode = record.policy.permissionPolicy;
        if (mode === '' || normalizeAccountPermissionPolicy(mode)) {
          await saveAccountPolicy({ permissionPolicy: mode });
        }
      }
    }
  }
  await ledger.writeState({
    ...state,
    records: merged.records,
    counter: state.counter,
  });
  return {
    accepted: [
      ...credentialMerged.accepted.map((identity) => identity),
      ...acceptedRecords.map((record) => record.scope === 'provider' ? record.key : `${record.scope}:${record.key}`),
    ],
    ignored: [
      ...credentialMerged.ignored,
      ...merged.ignored,
      ...unknownPolicyIncoming.map((record) => syncRecordIdentity(record.scope, record.key)),
      ...machineLocalIncoming.map((record) => syncRecordIdentity(
        record?.scope || 'provider',
        record?.key || record?.accountKey || record?.provider?.id || 'machine-local-oauth',
      )),
    ],
    machineLocalIgnored: machineLocalIncoming.length,
    records: [...merged.records, ...(await mutationLedger.listRecords())],
  };
}

export async function applyProviderSyncRecords(options = {}) {
  const result = await applyAccountSyncRecords({
    ...options,
    incoming: (options.incoming || []).map((record) => ({ scope: 'provider', ...record })),
  });
  return {
    ...result,
    accepted: result.accepted.filter((key) => !key.includes(':')),
    ignored: result.ignored.filter((key) => !key.includes(':')),
    records: result.records.filter((record) => (record.scope || 'provider') === 'provider'),
  };
}

export async function createNativeApiProvider({ registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir = CONFIG_DIR, payload = {} } = {}) {
  assertWorkbenchProviderSetup({ agentType: payload.agentType, authType: 'api-key' });
  const agentType = normalizeAgentType(payload.agentType);
  if (!agentType || agentType === 'agy') throw new Error('agentType must be a supported API-key harness or native client');
  if (trim(payload.authType) === 'oauth-token') {
    if (agentType !== 'claude') {
      throw new Error('oauth-token authentication is supported only for Claude');
    }
    const token = trim(payload.oauthToken || payload.token);
    if (!token) throw new Error('oauthToken is required');
    const defaultModel = trim(payload.defaultModel);
    const result = await provisionNativeProvider({
      registry,
      secretStore,
      ledger,
      credentialLedger,
      sourceInstanceId,
      configDir,
      agentType: 'claude',
      displayName: payload.displayName,
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic-messages',
      modelPolicy: defaultModel ? { defaultModel } : null,
      quotaPolicy: quotaPolicyFromPayload(payload) || {
        mode: 'official_subscription',
        adapter: 'claude',
      },
      authType: 'oauth-token',
      token,
      accountMetadata: { credentialMode: 'setup-token', source: 'claude-setup-token' },
    });
    return result;
  }
  const apiKey = trim(payload.apiKey);
  if (!apiKey) throw new Error('apiKey is required');
  const protocol = agentType === 'codex'
    ? normalizeCodexProtocol(payload.protocol)
    : normalizeHarnessProtocol(payload.protocol, providerDefaults(agentType).protocol);
  const baseUrl = trim(payload.baseUrl)
    || (agentType === 'codex' ? 'https://api.openai.com/v1' : providerDefaults(agentType).baseUrl);
  if (!(agentType === 'agy' || (agentType === 'copilot' && protocol === 'github-copilot'))
      && !/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl must be an http(s) URL');
  const defaultModel = trim(payload.defaultModel);
  const modelPolicy = defaultModel ? { defaultModel } : null;
  const quotaPolicy = quotaPolicyFromPayload(payload)
    || inferProviderQuotaPolicy({ baseUrl });
  const result = await provisionNativeProvider({
    registry,
    secretStore,
    ledger,
    credentialLedger,
    sourceInstanceId,
    configDir,
    agentType,
    displayName: payload.displayName,
    baseUrl,
    protocol,
    modelPolicy,
    quotaPolicy,
    authType: 'api-key',
    apiKey,
  });
  if (agentType !== 'codex' || payload.discoverModels === false) return result;
  const hydrated = await hydrateCodexModelPolicy({
    result,
    registry,
    discoverModels: payload.discoverModels,
    requestedDefaultModel: defaultModel,
  });
  await recordProviderSyncMutation({
    registry,
    secretStore,
    ledger,
    provider: hydrated.provider,
    sourceInstanceId,
  });
  return hydrated;
}

export async function updateNativeProvider({ registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir = CONFIG_DIR, providerId: rawProviderId, payload = {} } = {}) {
  assertWorkbenchProviderSetup({ agentType: 'codex', authType: 'oauth' });
  return provisionQueue(async () => {
    const providerId = trim(rawProviderId);
    if (!providerId) throw new Error('providerId is required');
    const provider = await registry.getProviderProfile(providerId);
    if (!provider) throw new Error('Provider not found');
    const auth = await registry.getAuthProfile(provider.authProfileId);
    if (!auth) throw new Error('Provider credential profile not found');

    const displayName = trim(payload.displayName) || provider.displayName || provider.id;
    const migratingLegacyClaudeOAuth = auth.authType === 'oauth' && provider.agentType === 'claude';
    if (auth.authType === 'oauth-token' || migratingLegacyClaudeOAuth) {
      if (provider.agentType !== 'claude') {
        throw new Error('oauth-token authentication is supported only for Claude');
      }
      const token = trim(payload.oauthToken || payload.token);
      if (migratingLegacyClaudeOAuth && !token) {
        throw new Error('Claude normal OAuth is no longer supported; paste a token from claude setup-token to migrate this provider.');
      }
      const nextAuth = {
        ...auth,
        ...(migratingLegacyClaudeOAuth ? { authType: 'oauth-token' } : {}),
        displayName,
        accountMetadata: {
          ...(auth.accountMetadata && typeof auth.accountMetadata === 'object' ? auth.accountMetadata : {}),
          credentialMode: 'setup-token',
          source: 'claude-setup-token',
        },
      };
      const authResult = migratingLegacyClaudeOAuth
        ? null
        : await registry.upsertAuthProfile(nextAuth);
      if (authResult && !authResult.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to update auth profile');
      const defaultModel = trim(payload.defaultModel);
      const providerResult = await registry.upsertProviderProfile({
        ...provider,
        displayName,
        ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(defaultModel ? { modelPolicy: { ...(provider.modelPolicy || {}), defaultModel } } : {}),
        quotaPolicy: quotaPolicyFromPayload(payload, provider.quotaPolicy || {
          mode: 'official_subscription',
          adapter: 'claude',
        }),
      });
      if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to update provider profile');
      const credentialResult = token
        ? await commitCredentialMutation({
          registry,
          secretStore,
          credentialLedger,
          provider: providerResult.profile,
          auth: authResult?.profile || nextAuth,
          secretPayload: { authType: 'oauth-token', token },
          sourceInstanceId,
          configDir,
          rotate: migratingLegacyClaudeOAuth,
          previousAuthProfile: migratingLegacyClaudeOAuth ? auth : null,
        })
        : null;
      await recordProviderSyncMutation({
        registry,
        secretStore,
        ledger,
        provider: providerResult.profile,
        sourceInstanceId,
        configDir,
      });
      return { provider: providerResult.profile, authProfile: credentialResult?.authProfile || authResult?.profile || nextAuth };
    }
    if (auth.authType === 'oauth') {
      if (provider.agentType === 'claude') {
        throw new Error('Claude normal OAuth is no longer supported; migrate this provider with claude setup-token.');
      }
      const authResult = await registry.upsertAuthProfile({
        ...auth,
        displayName,
      });
      if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to update auth profile');
      const providerResult = await registry.upsertProviderProfile({
        ...provider,
        displayName,
        ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        quotaPolicy: quotaPolicyFromPayload(payload, provider.quotaPolicy || {
          mode: 'official_subscription',
          adapter: provider.agentType,
        }),
      });
      if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to update provider profile');
      await recordProviderSyncMutation({
        registry,
        secretStore,
        ledger,
        provider: providerResult.profile,
        sourceInstanceId,
        configDir,
      });
      return { provider: providerResult.profile, authProfile: authResult.profile };
    }

    const baseUrl = trim(payload.baseUrl) || provider.baseUrl;
    const protocol = provider.agentType === 'codex'
      ? normalizeCodexProtocol(payload.protocol || provider.protocol)
      : HARNESS_AGENT_TYPES.has(provider.agentType)
        ? normalizeHarnessProtocol(payload.protocol || provider.protocol, provider.protocol)
        : providerDefaults(provider.agentType).protocol;
    if (!(provider.agentType === 'agy' || (provider.agentType === 'copilot' && protocol === 'github-copilot'))
        && !/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl must be an http(s) URL');
    const defaultModel = trim(payload.defaultModel);
    const existingPolicy = provider.modelPolicy && typeof provider.modelPolicy === 'object'
      ? provider.modelPolicy
      : null;
    const modelPolicy = defaultModel
      ? { ...(existingPolicy || {}), defaultModel }
      : null;
    const quotaPolicy = quotaPolicyFromPayload(
      payload,
      provider.quotaPolicy || inferProviderQuotaPolicy({ baseUrl }),
    );
    const apiKey = trim(payload.apiKey);
    const authResult = await registry.upsertAuthProfile({
      ...auth,
      displayName,
    });
    if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to update auth profile');
    const providerResult = await registry.upsertProviderProfile({
      ...provider,
      displayName,
      ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
      ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
      baseUrl,
      protocol,
      modelPolicy,
      quotaPolicy,
    });
    if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to update provider profile');
    const credentialResult = apiKey
      ? await commitCredentialMutation({
        registry,
        secretStore,
        credentialLedger,
        provider: providerResult.profile,
        auth: authResult.profile,
        secretPayload: { authType: 'api-key', apiKey },
        sourceInstanceId,
        configDir,
      })
      : null;
    await recordProviderSyncMutation({
      registry,
      secretStore,
      ledger,
      provider: providerResult.profile,
      sourceInstanceId,
    });
    return { provider: providerResult.profile, authProfile: credentialResult?.authProfile || authResult.profile };
  });
}

async function defaultDiscoverCodexModels() {
  const { getModelsForTool } = await import('./models.mjs');
  return getModelsForTool('codex');
}

async function hydrateCodexModelPolicy({ result, registry, discoverModels, requestedDefaultModel }) {
  let catalog;
  try {
    catalog = await (typeof discoverModels === 'function'
      ? discoverModels(result.provider.id)
      : defaultDiscoverCodexModels());
  } catch {
    // Adding a credential must remain useful even when the upstream is
    // temporarily unavailable. The next /api/models call can retry, while a
    // previously persisted modelPolicy remains available as the fallback.
    return result;
  }
  const suffix = `@${result.provider.id}`;
  const models = (Array.isArray(catalog?.models) ? catalog.models : [])
    .filter((model) => String(model?.id || '').endsWith(suffix))
    .map((model) => {
      const normalized = {
        id: String(model.id).slice(0, -suffix.length),
        // `/api/models` labels already carry the provider display suffix. Store
        // the upstream label only; the catalog adds the suffix when rendering,
        // which avoids `Model · Provider · Provider` after a probe fallback.
        label: String(model.label || model.id).replace(/\s*·\s*[^·]+$/, '').trim(),
      };
      for (const key of ['capabilities', 'contextWindow', 'defaultEffort', 'effortLevels', 'serviceTiers']) {
        if (model[key] !== undefined) normalized[key] = model[key];
      }
      return normalized;
    })
    .filter((model) => model.id);
  if (models.length === 0) return result;
  const requested = requestedDefaultModel.includes('@')
    ? requestedDefaultModel.slice(0, requestedDefaultModel.lastIndexOf('@'))
    : requestedDefaultModel;
  const defaultModel = models.some((model) => model.id === requested)
    ? requested
    : models[0].id;
  const modelPolicy = {
    ...(result.provider.modelPolicy && typeof result.provider.modelPolicy === 'object'
      ? result.provider.modelPolicy
      : {}),
    defaultModel,
    models,
  };
  const updated = await registry.upsertProviderProfile({
    ...result.provider,
    modelPolicy,
  });
  if (!updated?.ok) return result;
  return {
    ...result,
    provider: updated.profile,
  };
}

export async function deleteNativeProvider({ registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir = CONFIG_DIR, providerId } = {}) {
  assertWorkbenchProviderSetup({ agentType: 'codex', authType: 'oauth' });
  return provisionQueue(async () => {
    const provider = await registry.getProviderProfile(trim(providerId));
    if (!provider) return { ok: false, reason: 'not-found' };
    const auth = await registry.getAuthProfile(provider.authProfileId);
    const credentialResult = auth ? await commitCredentialMutation({
      registry,
      secretStore,
      credentialLedger,
      provider,
      auth,
      sourceInstanceId,
      configDir,
      deleted: true,
    }) : null;
    if (credentialResult?.status !== 'accepted') return { ok: false, reason: `credential-${credentialResult.status}` };
    const deleted = await registry.deleteProviderProfile(provider.id);
    if (!deleted?.ok) return deleted;
    if (auth) {
      const authDeleted = await registry.deleteAuthProfile(auth.id);
      if (authDeleted?.ok) await secretStore.deleteSecret(auth.storageRef);
    }
    if (ledger?.nextVersion && sourceInstanceId) {
      const version = await ledger.nextVersion(sourceInstanceId, new Date().toISOString());
      await ledger.merge([{
        scope: 'provider',
        key: provider.syncId || provider.id,
        version,
        deletedAt: version.updatedAt,
      }]);
    }
    return { ok: true };
  });
}

async function finalizeOAuthJob(job, { registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir = CONFIG_DIR }) {
  if (job.agentType === 'agy') {
    const auth = await inspectAgyAuth({ homeDir: job.authHomeDir });
    if (!auth.loggedIn) throw new Error('agy login did not produce a usable authentication token');
    if (job.baselineAuthSignature && auth.signature === job.baselineAuthSignature) {
      throw new Error('agy login did not change the linked account');
    }
    const tokenFile = await readFile(auth.authFile, 'utf8');
    const providerId = trim(job.targetProviderId)
      || `agy-${safeLabel(job.displayName, 'account')}-${randomUUID().slice(0, 8)}`;
    const existingProvider = await registry.getProviderProfile(providerId);
    const authProfileId = existingProvider?.authProfileId || `auth-${providerId}`;
    const existingAuth = await registry.getAuthProfile(authProfileId);
    const storageRef = existingAuth?.storageRef || `secret-${providerId}`;
    const authResult = await registry.upsertAuthProfile({
      id: authProfileId,
      agentType: 'agy',
      authType: 'oauth',
      displayName: job.displayName,
      storageType: 'secret-store',
      storageRef,
      accountMetadata: {
        ...(existingAuth?.accountMetadata && typeof existingAuth.accountMetadata === 'object'
          ? existingAuth.accountMetadata
          : {}),
        loginSource: 'agy-cli',
      },
    });
    if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to store AgY auth profile');
    const providerResult = await registry.upsertProviderProfile({
      id: providerId,
      agentType: 'agy',
      protocol: 'agy',
      displayName: job.displayName,
      baseUrl: '',
      authProfileId,
      modelPolicy: existingProvider?.modelPolicy || null,
      quotaPolicy: existingProvider?.quotaPolicy || { mode: 'official_subscription', adapter: 'agy' },
    });
    if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to store AgY provider profile');
    const credentialResult = await commitCredentialMutation({
      registry,
      secretStore,
      credentialLedger,
      provider: providerResult.profile,
      auth: authResult.profile,
      secretPayload: { authType: 'oauth', tokens: { tokenFile } },
      sourceInstanceId,
      configDir,
      rotate: Boolean(existingProvider),
    });
    await recordProviderSyncMutation({
      registry,
      secretStore,
      ledger,
      provider: providerResult.profile,
      sourceInstanceId,
    });
    job.providerId = providerId;
    job.profile = {
      id: providerId,
      agentType: 'agy',
      displayName: job.displayName,
      authType: 'oauth',
      credentialStored: credentialResult.status === 'accepted',
    };
    return;
  }
  if (job.agentType !== 'codex') {
    throw new Error('Only Codex supports Ragent-managed interactive OAuth login');
  }
  const { tokens, accountMetadata } = await readOAuthTokens(job);
  if (job.targetProviderId) {
    const existingProvider = await registry.getProviderProfile(job.targetProviderId);
    if (!existingProvider) throw new Error('Provider to re-authenticate was not found');
    if (existingProvider.agentType !== 'codex') {
      throw new Error('Provider to re-authenticate does not match the OAuth runtime');
    }
    const existingAuth = await registry.getAuthProfile(existingProvider.authProfileId);
    if (!existingAuth || existingAuth.authType !== 'oauth') {
      throw new Error('Provider to re-authenticate does not have an OAuth credential');
    }
    const existingMetadata = existingAuth.accountMetadata && typeof existingAuth.accountMetadata === 'object'
      ? existingAuth.accountMetadata
      : {};
    // A re-login replaces the credential in the existing provider slot. Keep
    // its chain key stable so peers do not see a second account while the
    // credential mutation ledger rotates the instance id atomically.
    const accountKey = trim(existingMetadata.accountKey)
      || (trim(existingMetadata.accountId)
        ? `account:${job.agentType}:${trim(existingMetadata.accountId)}`
        : `provider:${job.agentType}:${trim(existingProvider.syncId || existingProvider.id)}`);
    const auth = {
      ...existingAuth,
      displayName: job.displayName || existingAuth.displayName,
      accountMetadata: {
        ...existingMetadata,
        ...(trim(accountMetadata?.accountId) ? { accountId: trim(accountMetadata.accountId) } : {}),
        accountKey,
      },
    };
    const providerResult = await registry.upsertProviderProfile({
      ...existingProvider,
      displayName: job.displayName || existingProvider.displayName,
    });
    if (!providerResult?.ok) {
      throw new Error(providerResult.errors?.join(', ') || 'Unable to update provider profile after OAuth login');
    }
    const credentialResult = await commitCredentialMutation({
      registry,
      secretStore,
      credentialLedger,
      provider: providerResult.profile,
      auth,
      secretPayload: { authType: 'oauth', tokens },
      sourceInstanceId,
      configDir,
      rotate: true,
    });
    await recordProviderSyncMutation({
      registry,
      secretStore,
      ledger,
      provider: providerResult.profile,
      sourceInstanceId,
    });
    job.providerId = providerResult.profile.id;
    job.profile = {
      id: providerResult.profile.id,
      agentType: providerResult.profile.agentType,
      displayName: providerResult.profile.displayName,
      authType: 'oauth',
      credentialStored: credentialResult.status === 'accepted',
    };
    return;
  }
  const result = await provisionNativeProvider({
    registry,
    secretStore,
    ledger,
    credentialLedger,
    sourceInstanceId,
    configDir,
    agentType: 'codex',
    displayName: job.displayName,
    baseUrl: providerDefaults(job.agentType).baseUrl,
    protocol: providerDefaults(job.agentType).protocol,
    modelPolicy: null,
    authType: 'oauth',
    quotaPolicy: { mode: 'official_subscription', adapter: job.agentType },
    tokens,
    accountMetadata,
  });
  job.providerId = result.provider.id;
  job.profile = {
    id: result.provider.id,
    agentType: result.provider.agentType,
    displayName: result.provider.displayName,
    authType: 'oauth',
  };
}

export async function startNativeOAuthLogin({
  registry,
  secretStore,
  ledger,
  credentialLedger,
  sourceInstanceId,
  configDir = CONFIG_DIR,
  onProviderChanged,
  agentType: rawAgentType,
  displayName: rawDisplayName,
  replaceExisting = false,
  providerId: rawProviderId = '',
  commandPath = '',
  resolveProxyEnvironment = resolveRunnerProxyEnvironment,
} = {}) {
  if (trim(rawAgentType).toLowerCase() === 'claude') {
    const error = new Error('Claude normal OAuth login has been removed; run claude setup-token on this machine and save the setup token in Ragent.');
    error.code = 'CLAUDE_OAUTH_REMOVED';
    error.statusCode = 410;
    throw error;
  }
  assertWorkbenchProviderSetup({ agentType: rawAgentType, authType: 'oauth' });
  if (WORKBENCH_EXECUTION_POLICY) {
    const existing = await registry.listProviderProfiles();
    if (existing.length && !(replaceExisting && existing.length === 1 && existing[0].id === rawProviderId)) {
      throw Object.assign(new Error('This workbench permits one official Provider'), { code: 'WORKBENCH_EXECUTION_POLICY_DENIED', statusCode: 403 });
    }
  }
  const agentType = normalizeLoginAgentType(rawAgentType);
  if (!agentType) throw new Error('agentType must be codex or agy');
  const harness = trim(commandPath) ? null : await getHarnessDefinition(agentType);
  const command = trim(commandPath) || (harness?.installed ? trim(harness.path) : '');
  if (!command) {
    const error = new Error(`${agentType} internal runtime is unavailable. Install it in Ragent Harness management first.`);
    error.code = 'HARNESS_RUNTIME_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }

  // Validate the complete save prerequisites before asking the user to
  // authorize a new credential. Damaged metadata must fail before CLI spawn.
  await Promise.all([
    (credentialLedger || createCredentialMutationLedger({ configDir })).listRecords(),
    (ledger || createProviderSyncLedger({ configDir })).readState(),
  ]);

  const requestedProviderId = trim(rawProviderId);
  if (requestedProviderId && !/^[A-Za-z0-9._-]{1,128}$/.test(requestedProviderId)) {
    throw new Error('providerId contains unsupported characters');
  }
  const targetProviderId = agentType === 'agy'
    ? (requestedProviderId || (replaceExisting ? AGY_OFFICIAL_PROVIDER_ID : ''))
    : (replaceExisting ? requestedProviderId : '');
  if (agentType === 'agy' && targetProviderId === AGY_OFFICIAL_PROVIDER_ID) {
    await migrateLegacyAgyProvider({ registry, secretStore }).catch(() => null);
  }
  const activeAgyLogin = agentType === 'agy'
    ? [...loginJobs.values()].find((job) => job.agentType === 'agy' && !['completed', 'failed', 'cancelled'].includes(job.state))
    : null;
  if (activeAgyLogin) {
    const error = new Error('agy login is already in progress');
    error.code = 'AGY_LOGIN_IN_PROGRESS';
    error.statusCode = 409;
    throw error;
  }
  if (replaceExisting && !targetProviderId) {
    throw new Error('providerId is required when replacing an OAuth provider');
  }
  const existingTargetProvider = targetProviderId
    ? await registry.getProviderProfile(targetProviderId).catch(() => null)
    : null;
  if (replaceExisting && !existingTargetProvider) {
    const error = new Error('Provider to re-authenticate was not found');
    error.statusCode = 404;
    throw error;
  }
  if (existingTargetProvider && existingTargetProvider.agentType !== agentType) {
    throw new Error('Provider to re-authenticate does not match the OAuth runtime');
  }
  const existingTargetAuth = existingTargetProvider
    ? await registry.getAuthProfile(existingTargetProvider.authProfileId).catch(() => null)
    : null;
  if (replaceExisting && (!existingTargetAuth || existingTargetAuth.authType !== 'oauth')) {
    throw new Error('Provider to re-authenticate does not have an OAuth credential');
  }
  const existingTargetSecret = existingTargetAuth
    ? await secretStore.resolveSecret(existingTargetAuth.storageRef).catch(() => null)
    : null;
  const baselineAuthSignature = existingTargetSecret?.ok && existingTargetSecret.authType === 'oauth'
    ? `${String(existingTargetSecret.tokens?.tokenFile || '').length}:${createHash('sha256').update(String(existingTargetSecret.tokens?.tokenFile || '')).digest('hex')}`
    : '';
  await ensureLoginRoot();
  const id = randomUUID();
  const stagingDir = join(NATIVE_LOGIN_ROOT, id);
  const providerHome = agentType === 'codex' ? join(stagingDir, 'codex') : '';
  const tempHome = join(stagingDir, 'home');
  if (providerHome) await mkdir(providerHome, { recursive: true, mode: 0o700 });
  await mkdir(tempHome, { recursive: true, mode: 0o700 });
  const displayName = trim(rawDisplayName) || `${agentType} official account`;
  const job = {
    id,
    agentType,
    provider: agentType,
    displayName,
    state: 'pending',
    phase: 'starting',
    failureCode: '',
    url: agentType === 'codex' ? CODEX_DEVICE_LOGIN_URL : '',
    code: '',
    providerId: '',
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    stagingDir,
    providerHome,
    authHomeDir: agentType === 'agy' ? tempHome : providerHome,
    targetProviderId,
    targetAuthHomeDir: '',
    baselineAuthSignature,
    inputSubmitted: false,
    requiresInput: agentType === 'agy',
    raw: '',
  };
  const proxyEnv = await resolveProxyEnvironment();
  const env = agentType === 'agy'
    ? await buildAgyRuntimeEnv({ ...process.env, ...proxyEnv }, { homeDir: tempHome })
    : {
      ...process.env,
      ...proxyEnv,
      HOME: tempHome,
      CODEX_HOME: providerHome,
      // npm's owned command shim launches Node. Use AgentoC's own runtime
      // first even on clean machines without a global Node installation.
      PATH: [dirname(process.execPath), process.env.PATH || process.env.Path].filter(Boolean).join(delimiter),
    };
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    delete env[key];
  }
  const args = agentType === 'codex'
    ? ['login', '--device-auth']
    : ['--print', AGY_BROWSER_LOGIN_PROMPT];
  let spawnSpec;
  if (agentType === 'agy' && process.platform !== 'win32') {
    const scriptCommand = await resolveToolCommandPathAsync('script').catch(() => null);
    if (scriptCommand) {
      const launcherCommand = buildAgyRuntimeShellCommand({ command, args });
      // The PTY is necessary for the CLI's interactive input, but its
      // default echo would copy the authorization text into captured output.
      const terminalCommand = `stty -echo || exit 1; exec ${launcherCommand}`;
      const scriptArgs = process.platform === 'darwin'
        ? ['-q', '/dev/null', 'sh', '-c', terminalCommand]
        : ['-q', '-e', '-f', '-c', terminalCommand, '/dev/null'];
      spawnSpec = buildPlatformSpawnSpec(scriptCommand, scriptArgs, { env });
    }
  }
  if (!spawnSpec) {
    spawnSpec = agentType === 'agy'
      ? buildAgyRuntimeLaunchSpec({ command, args, env })
      : buildPlatformSpawnSpec(command, args, { env });
  }
  const child = await spawnManagedProviderProcess(spawnSpec, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  job.child = child;
  loginJobs.set(id, job);
  const capture = (chunk) => {
    job.raw = `${job.raw}${chunk}`.slice(-12_000);
    Object.assign(job, projectLoginOutput(job.raw));
    if (job.agentType === 'codex') {
      job.phase = job.code ? 'awaiting-device-auth' : job.url ? 'generating-device-code' : 'starting';
    }
    if (job.agentType === 'agy' && job.url && job.state === 'pending') {
      job.state = 'awaiting-input';
      job.phase = 'awaiting-browser-input';
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.stdin?.on('error', (error) => {
    if (['cancelled', 'failed', 'finalizing', 'completed'].includes(job.state)) return;
    job.state = 'failed';
    job.phase = 'input-failed';
    job.failureCode = 'stdin';
    job.error = `LOGIN_INPUT_FAILED: ${sanitizeLoginText(error?.code || error?.message || 'provider input pipe closed', job.code)}`;
    job.finishedAt = new Date().toISOString();
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    job.phase = 'timed-out';
    terminateLoginProcess(child);
  }, 10 * 60 * 1000);
  timeout.unref?.();
  child.on('error', (error) => {
    void (async () => {
    clearTimeout(timeout);
    if (['cancelled', 'failed', 'finalizing', 'completed'].includes(job.state)) return;
    job.state = 'failed';
    job.phase = 'start-failed';
    job.failureCode = 'spawn';
    job.error = `LOGIN_START_FAILED: ${sanitizeLoginText(error.code || error.message || 'provider process could not be started', job.code)}`;
    job.finishedAt = new Date().toISOString();
    delete job.child;
    await removeStaging(job).catch(() => {});
    })().catch((handlerError) => {
      console.error(`[native-provider] OAuth login error cleanup failed: ${handlerError?.message || String(handlerError)}`);
    });
  });
  child.on('exit', (exitCode, signal) => {
    void (async () => {
    clearTimeout(timeout);
    delete job.child;
    if (['cancelled', 'failed', 'completed'].includes(job.state)) {
      await removeStaging(job).catch(() => {});
      return;
    }
    if (exitCode !== 0) {
      job.state = 'failed';
      const failure = classifyLoginFailure({
        agentType: job.agentType,
        raw: job.raw,
        exitCode,
        signal,
        deviceCode: job.code,
        timedOut,
      });
      job.phase = failure.phase;
      job.failureCode = failure.failureCode;
      job.error = failure.error;
      job.finishedAt = new Date().toISOString();
      await removeStaging(job).catch(() => {});
      return;
    }
    job.state = 'finalizing';
    job.phase = 'finalizing';
    try {
      await finalizeOAuthJob(job, { registry, secretStore, ledger, credentialLedger, sourceInstanceId, configDir });
      job.state = 'completed';
      job.phase = 'completed';
      job.failureCode = '';
      await Promise.resolve(onProviderChanged?.()).catch(() => {});
    } catch (error) {
      job.state = 'failed';
      job.phase = 'finalize-failed';
      job.failureCode = 'finalize';
      // V8 SyntaxError messages include input excerpts. Other JSON files read
      // during finalization can also contain credentials, so redact centrally.
      const message = error instanceof SyntaxError
        ? 'A provider data file contains invalid JSON; no credential contents are included'
        : error?.message || 'Unable to save the OAuth account';
      job.error = `LOGIN_FINALIZE_FAILED: ${sanitizeLoginText(message, job.code)}`;
    }
    job.finishedAt = new Date().toISOString();
    await removeStaging(job).catch(() => {});
    })().catch((handlerError) => {
      if (!['cancelled', 'failed', 'completed'].includes(job.state)) {
        job.state = 'failed';
        job.phase = 'finalize-failed';
        job.failureCode = 'cleanup';
        job.error = `LOGIN_CLEANUP_FAILED: ${sanitizeLoginText(handlerError?.message || 'OAuth login cleanup failed', job.code)}`;
        job.finishedAt = new Date().toISOString();
      }
      console.error(`[native-provider] OAuth login exit cleanup failed: ${handlerError?.message || String(handlerError)}`);
      void removeStaging(job).catch(() => {});
    });
  });
  return safeJob(job);
}

export function getNativeOAuthLoginJob(id) {
  return safeJob(loginJobs.get(trim(id)));
}

export function normalizeAgyLoginInput(rawInput) {
  const input = trim(rawInput);
  if (!input) throw new Error('credential is required');
  if (/[\r\n]/.test(input)) throw new Error('credential must be a single line');
  if (input.length > 64 * 1024) throw new Error('credential is too large');
  return input;
}

export async function sendNativeOAuthLoginInput(id, rawInput) {
  const job = loginJobs.get(trim(id));
  if (!job) return null;
  if (job.agentType !== 'agy') throw new Error('Only agy login accepts browser credential input');
  if (job.state !== 'awaiting-input') throw new Error('agy login is not ready to accept credential input');
  const input = normalizeAgyLoginInput(rawInput);
  if (!job.child?.stdin?.writable) throw new Error('agy login terminal is no longer available');
  // Reserve the job before awaiting I/O so concurrent submissions cannot
  // deliver the same (or conflicting) credential twice.
  job.state = 'authenticating';
  job.phase = 'authenticating';
  try {
    await new Promise((resolve, reject) => {
      job.child.stdin.write(`${input}\n`, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    terminateLoginProcess(job.child);
    throw new Error(`agy login input could not be delivered: ${error?.message || String(error)}`);
  }
  job.inputSubmitted = true;
  return safeJob(job);
}

export async function cancelNativeOAuthLogin(id) {
  const job = loginJobs.get(trim(id));
  if (!job) return null;
  if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
    job.state = 'cancelled';
    job.phase = 'cancelled';
    job.failureCode = 'cancelled';
    job.finishedAt = new Date().toISOString();
    terminateLoginProcess(job.child);
    await removeStaging(job).catch(() => {});
  }
  return safeJob(job);
}

export async function cleanupNativeOAuthLoginJobs({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  await ensureLoginRoot();
  const now = Date.now();
  let entries = [];
  try {
    entries = await readdir(NATIVE_LOGIN_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(NATIVE_LOGIN_ROOT, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > maxAgeMs) await rm(path, { recursive: true, force: true });
    } catch {}
  }));
}
