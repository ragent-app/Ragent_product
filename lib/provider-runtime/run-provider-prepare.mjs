// Dual-track integration seam (Phase 2).
//
// Run preparation resolves the Run's provider through the native registry
// instead of mirroring legacy provider rows
// into the managed provider home.  The output contract is unchanged from the
// caller's perspective: a scoped provider home directory containing the
// agent's config + credentials + the .agentoc-provider-id marker the sidecar
// verifies, plus AGENTOC_PROVIDER_HOMES_DIR pointing at it.
//
// The native path writes the provider home DIRECTLY from the registry
// snapshot (provider + auth profile + secret) — there is no global "current
// provider" state anywhere in this path, which is the architectural point:
// per-Run isolation instead of global switching.
//

import { createHash } from 'crypto';
import { codexRunBindingPath, createCodexRunBinding } from './codex-run-binding.mjs';
import { assertCodexHomeNotFenced } from './codex-home-fence.mjs';
import { resolveBoundCodexAccountHome } from './codex-account-route.mjs';
import { coordinateCodexAccountRoute } from './codex-account-automatic-handoff.mjs';
import { resolveCodexProfileAccountHome } from './codex-profile-account-home.mjs';
import { codexWindowsSandboxConfig } from './codex-windows-sandbox.mjs';
import { migrateManagedHomeOwnership } from '../linux-managed-home-migration.mjs';
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { AGY_CONTROL_HOME_DIR } from '../config.mjs';
import { AGY_AUTH_RELATIVE_PATH, resolveAgyAuthFile } from '../agy-runtime.mjs';
import { createNativeProviderRegistry } from './registry.mjs';
import { createSecretStore } from './secret-store.mjs';
import { createAgyRotationStore } from './agy-rotation.mjs';
import {
  getExternalCodexOwnershipRecord,
  normalizeExternalOAuthHandoffPolicy,
  observeExternalCodexOwnership,
} from './external-codex-ownership.mjs';
import {
  RuntimeConfigResolutionError,
  resolveRuntimeConfig,
  sanitizeRuntimeEnvironment,
} from './resolver.mjs';
import {
  buildHarnessProviderFiles,
  resolveHarnessProviderCompatibility,
} from './harness-bridge.mjs';
import {
  acquireNativeOAuthLock,
  nativeOAuthLockPath,
} from './oauth-lock.mjs';
import { resolveClaudeModelContract } from './claude-model-contract.mjs';
import {
  codexAppServerBrokerSocketPath,
  codexAppServerBrokerLockPath,
  isCodexAppServerBrokerReady,
} from '../../chat/codex-app-server-broker.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const NATIVE_OAUTH_STATE_FILE = '.agentoc-oauth-state.json';

let providerAtomicWriteSequence = 0;

async function writeProviderFileAtomic(path, content, options, {
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
} = {}) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${providerAtomicWriteSequence += 1}`;
  try {
    await writeFileImpl(temporaryPath, content, options);
    for (let attempt = 0; ; attempt++) {
      try { await renameImpl(temporaryPath, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) throw error;
        // Windows readers/AV can briefly hold a replace-denying handle. Keep
        // the same staged bytes, never unlink the destination, and bound retry.
        await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
      }
    }
  } finally {
    await unlinkImpl(temporaryPath).catch(() => {});
  }
}

async function verifyPreparedProviderFiles(files, { statImpl = stat } = {}) {
  for (const file of [...new Set(files.filter(Boolean))]) {
    let info;
    try {
      info = await statImpl(file);
    } catch (error) {
      const verificationError = new Error('Prepared provider home is missing a required file');
      verificationError.code = 'PROVIDER_HOME_VERIFY_FAILED';
      verificationError.stage = 'verify';
      verificationError.resource = file;
      verificationError.causeCode = error?.code || '';
      throw verificationError;
    }
    if (!info.isFile() || info.size <= 0) {
      const verificationError = new Error('Prepared provider home contains an invalid required file');
      verificationError.code = 'PROVIDER_HOME_VERIFY_FAILED';
      verificationError.stage = 'verify';
      verificationError.resource = file;
      throw verificationError;
    }
  }
}

function stableOAuthValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableOAuthValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableOAuthValue(value[key])]),
  );
}

export function nativeOAuthTokenFingerprint(tokens) {
  return createHash('sha256')
    .update(JSON.stringify(stableOAuthValue(tokens || {})))
    .digest('hex')
    .slice(0, 16);
}

// Codex includes the ChatGPT account identity in its OAuth token bundle.
export function nativeOAuthAccountId(tokens) {
  for (const key of [
    'account_id',
    'accountId',
    'account_uuid',
    'accountUuid',
    'user_id',
    'userId',
  ]) {
    const value = trimString(tokens?.[key]);
    if (value) return value;
  }
  return '';
}

// Every Codex OAuth refresh produces a generation with a later expiry, so
// expiry is a safe ordering key for credential copies. Ordering matters
// because writing an older generation over a newer one would re-introduce an
// already-consumed refresh token, which the identity provider treats as token
// reuse and answers by revoking the whole token family.
export function nativeOAuthGenerationExpiresAt(tokens) {
  const expiresAt = Number(tokens?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  }
  const segments = trimString(tokens?.access_token).split('.');
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function isNativeOAuthGenerationNewer(candidateTokens, referenceTokens) {
  const candidate = nativeOAuthGenerationExpiresAt(candidateTokens);
  const reference = nativeOAuthGenerationExpiresAt(referenceTokens);
  if (candidate === null || reference === null) return false;
  return candidate > reference;
}

function nativeOAuthRefreshTokenFingerprint(tokens) {
  const refreshToken = trimString(tokens?.refresh_token || tokens?.refreshToken);
  return refreshToken
    ? createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
    : '';
}

function oauthCredentialsBelongToSameAccount(left, right) {
  const leftAccountId = nativeOAuthAccountId(left);
  const rightAccountId = nativeOAuthAccountId(right);
  if (leftAccountId && rightAccountId) return leftAccountId === rightAccountId;
  const leftRefreshFingerprint = nativeOAuthRefreshTokenFingerprint(left);
  const rightRefreshFingerprint = nativeOAuthRefreshTokenFingerprint(right);
  return Boolean(leftRefreshFingerprint && leftRefreshFingerprint === rightRefreshFingerprint);
}

function hasOAuthTokenPair(tokens) {
  const accessToken = trimString(tokens?.access_token || tokens?.accessToken);
  const refreshToken = trimString(tokens?.refresh_token || tokens?.refreshToken);
  return Boolean(accessToken && refreshToken);
}

async function readJsonIfPresent(path, readFileImpl) {
  try {
    return JSON.parse(await readFileImpl(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    return null;
  }
}

export function resolveExternalCodexAuthFile(value, environment = process.env, homeDir = homedir()) {
  const explicit = trimString(value)
    || trimString(environment?.AGENTOC_EXTERNAL_CODEX_AUTH_FILE);
  if (explicit) return explicit;
  const externalHome = trimString(environment?.AGENTOC_EXTERNAL_CODEX_HOME);
  return externalHome ? join(externalHome, 'auth.json') : join(homeDir, '.codex', 'auth.json');
}

// Used by the explicitly invoked standalone claude-oauth command. This does
// not enable external-Claude credential inheritance for managed Runs.
export function resolveExternalClaudeCredentialsFile(value, environment = process.env, homeDir = homedir()) {
  return trimString(value) || trimString(environment?.AGENTOC_EXTERNAL_CLAUDE_CREDENTIALS_FILE)
    || join(trimString(environment?.CLAUDE_CONFIG_DIR) || join(homeDir, '.claude'), '.credentials.json');
}

export async function inspectExternalClaudeAuth({ externalClaudeCredentialsFile = resolveExternalClaudeCredentialsFile(), readFileImpl = readFile } = {}) {
  const empty = { accountId: '', ownershipKey: '', fingerprint: '' };
  let auth;
  try { auth = JSON.parse(await readFileImpl(externalClaudeCredentialsFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, status: 'missing', ...empty };
    return { ok: false, status: 'unreadable', reason: 'external-claude-auth-unreadable', ...empty };
  }
  const tokens = auth?.claudeAiOauth;
  const access = trimString(tokens?.accessToken);
  const refresh = trimString(tokens?.refreshToken);
  if (!access && !refresh) return { ok: true, status: 'logged-out', ...empty };
  const fingerprint = createHash('sha256').update(refresh || access).digest('hex').slice(0, 16);
  return { ok: true, status: 'logged-in', accountId: '',
    ownershipKey: `${refresh ? 'refresh' : 'access'}:${fingerprint}`, fingerprint };
}

// External Codex is the active refresh owner while it is logged into the
// selected account. Once it switches or logs out, automatic mode promotes the
// latest vault backup to the refresh owner. Explicit mode is retained only for
// installations that require a manual ownership handoff.
export function resolveExternalCodexHandoffPolicy(environment = process.env) {
  return normalizeExternalOAuthHandoffPolicy(
    environment?.AGENTOC_CODEX_EXTERNAL_OAUTH_HANDOFF_POLICY,
    'automatic',
  );
}

function tokensWithoutRefreshToken(tokens) {
  if (!tokens || typeof tokens !== 'object') return {};
  return Object.fromEntries(
    Object.entries(tokens).filter(([key]) => key !== 'refresh_token' && key !== 'refreshToken'),
  );
}

export async function inspectExternalCodexAuth({
  externalCodexAuthFile,
  readFileImpl = readFile,
} = {}) {
  let externalAuth;
  try {
    externalAuth = JSON.parse(await readFileImpl(externalCodexAuthFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: true,
        status: 'missing',
        authFile: externalCodexAuthFile,
        accountId: '',
        fingerprint: '',
        tokens: null,
        lastRefresh: null,
      };
    }
    return {
      ok: false,
      status: 'unreadable',
      authFile: externalCodexAuthFile,
      reason: 'external-codex-auth-unreadable',
    };
  }

  const externalTokens = externalAuth?.tokens;
  const hasAccessToken = Boolean(trimString(externalTokens?.access_token || externalTokens?.accessToken));
  const hasRefreshToken = Boolean(trimString(externalTokens?.refresh_token || externalTokens?.refreshToken));
  const accountId = nativeOAuthAccountId(externalTokens);
  if (!hasAccessToken && !hasRefreshToken) {
    return {
      ok: true,
      status: 'logged-out',
      authFile: externalCodexAuthFile,
      accountId: '',
      fingerprint: '',
      tokens: null,
      lastRefresh: externalAuth?.last_refresh || null,
    };
  }
  return {
    ok: true,
    status: accountId ? 'logged-in' : 'account-unknown',
    authFile: externalCodexAuthFile,
    accountId,
    fingerprint: nativeOAuthTokenFingerprint(externalTokens),
    tokens: externalTokens,
    lastRefresh: externalAuth?.last_refresh || null,
  };
}

async function detectExternalOAuthOwner({
  agentType,
  externalProvider,
  secret,
  externalAuthSnapshot,
}) {
  if (agentType !== externalProvider?.agentType || secret?.authType !== 'oauth') return null;
  if (!externalAuthSnapshot?.ok) {
    return {
      error: externalAuthSnapshot?.reason
        || `${externalProvider?.source || 'external-oauth'}-auth-unreadable`,
    };
  }
  const externalTokens = externalAuthSnapshot.tokens;
  if (!hasOAuthTokenPair(externalTokens)) return null;
  if (!oauthCredentialsBelongToSameAccount(secret.tokens, externalTokens)) return null;
  return {
    source: externalProvider.source,
    authFile: externalAuthSnapshot.authFile,
    tokens: tokensWithoutRefreshToken(externalTokens),
    lastRefresh: externalAuthSnapshot.lastRefresh,
    accountId: externalAuthSnapshot.accountId,
  };
}

// External Codex homes may carry user-specific model providers, MCP servers,
// and legacy settings that do not apply to AgentoC. Keep the generated Run
// config authoritative, but make auth.json point at the external CLI's
// canonical rotating credential file. This keeps token rotation shared
// without importing an external config.toml into the managed process.
async function materializeExternalCodexAuth({ agentHome, externalAuthFile }) {
  const authPath = join(agentHome, 'auth.json');
  try {
    const existing = await lstat(authPath);
    if (existing.isSymbolicLink() && await readlink(authPath) === externalAuthFile) {
      return { ok: true, linked: true };
    }
    await unlink(authPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, reason: 'external-codex-auth-link-inspect-failed' };
    }
  }

  try {
    await symlink(externalAuthFile, authPath);
    return { ok: true, linked: true };
  } catch {
    // A copy keeps the Run usable on filesystems that forbid symlinks. The
    // next Run will resync from the external source before launching.
    try {
      const temporaryPath = `${authPath}.tmp-${process.pid}-${Date.now()}-${providerAtomicWriteSequence += 1}`;
      try {
        await copyFile(externalAuthFile, temporaryPath);
        await rename(temporaryPath, authPath);
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
      await chmod(authPath, 0o600).catch(() => {});
      return { ok: true, linked: false };
    } catch {
      return { ok: false, reason: 'external-codex-auth-link-failed' };
    }
  }
}

async function reconcileNativeOAuthCredentials({
  agentType,
  agentHome,
  storageRef,
  secret,
  secretStore,
  readFileImpl,
}) {
  const authPath = join(agentHome, agentType === 'codex' ? 'auth.json' : '.credentials.json');
  const runtimeAuth = await readJsonIfPresent(authPath, readFileImpl);
  const runtimeTokens = agentType === 'codex'
    ? runtimeAuth?.tokens
    : runtimeAuth?.claudeAiOauth;
  const currentFingerprint = nativeOAuthTokenFingerprint(secret.tokens);
  const runtimeFingerprint = hasOAuthTokenPair(runtimeTokens)
    ? nativeOAuthTokenFingerprint(runtimeTokens)
    : '';
  const state = await readJsonIfPresent(join(agentHome, NATIVE_OAUTH_STATE_FILE), readFileImpl);
  const recordedFingerprint = trimString(state?.sourceFingerprint);

  if (!runtimeFingerprint || runtimeFingerprint === currentFingerprint) {
    return {
      ok: true,
      secret,
      persisted: false,
      runtimeFingerprint,
      runtimeLastRefresh: runtimeAuth?.last_refresh || null,
    };
  }

  // A re-login can change the account while the previous Codex process has
  // independently refreshed its home. A newer expiry from that old account
  // must never overwrite the newly selected account in the credential store.
  const runtimeAccountId = nativeOAuthAccountId(runtimeTokens);
  const selectedAccountId = nativeOAuthAccountId(secret.tokens);
  if (runtimeAccountId && selectedAccountId && runtimeAccountId !== selectedAccountId) {
    return { ok: true, secret, persisted: false, runtimeFingerprint, runtimeLastRefresh: null };
  }

  // If the runtime file still matches the last credential snapshot, the
  // SecretStore was changed externally (for example by re-login).  Prefer the
  // newer vault value and do not roll it back from an older home.
  if (recordedFingerprint && runtimeFingerprint === recordedFingerprint) {
    return {
      ok: true,
      secret,
      persisted: false,
      runtimeFingerprint,
      runtimeLastRefresh: null,
    };
  }

  // The vault can legitimately be newer than the home (external re-login, a
  // peer sync).  Never persist an older runtime generation over it.
  if (isNativeOAuthGenerationNewer(secret.tokens, runtimeTokens)) {
    return {
      ok: true,
      secret,
      persisted: false,
      runtimeFingerprint,
      runtimeLastRefresh: runtimeAuth?.last_refresh || null,
    };
  }

  if (!secretStore || typeof secretStore.writeSecret !== 'function') {
    return { ok: false, reason: 'oauth-persist-unavailable' };
  }
  const written = await secretStore.writeSecret(storageRef, {
    authType: 'oauth',
    tokens: runtimeTokens,
  });
  if (!written?.ok) {
    return { ok: false, reason: 'oauth-persist-failed', error: written?.reason || 'secret-store-write-failed' };
  }
  const refreshedSecret = await secretStore.resolveSecret(storageRef);
  if (!refreshedSecret?.ok || refreshedSecret.authType !== 'oauth') {
    return { ok: false, reason: 'oauth-persist-readback-failed' };
  }
  return {
    ok: true,
    secret: refreshedSecret,
    persisted: true,
    runtimeFingerprint,
    runtimeLastRefresh: runtimeAuth?.last_refresh || null,
  };
}

async function writeNativeOAuthState({
  agentHome,
  storageRef,
  tokens,
  oauthOwner = 'agentoc',
  accountId = '',
  sourceAuthFile = '',
  sourceFingerprint = '',
  writeFileImpl,
  chmodImpl,
  renameImpl = rename,
  unlinkImpl = unlink,
}) {
  const statePath = join(agentHome, NATIVE_OAUTH_STATE_FILE);
  await writeProviderFileAtomic(
    statePath,
    JSON.stringify({
      version: 1,
      storageRef,
      oauthOwner,
      ...(accountId ? { accountId } : {}),
      ...(sourceAuthFile ? { sourceAuthFile } : {}),
      sourceFingerprint: sourceFingerprint || nativeOAuthTokenFingerprint(tokens),
      recordedAt: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600 },
    { writeFileImpl, renameImpl, unlinkImpl },
  );
  await chmodImpl(statePath, 0o600).catch(() => {});
}

// Map the run manifest's shape (tool / options.providerProfile / model) onto
// the native selection shape.  The native registry keys providers by
// ProviderProfile id, so a Run always resolves against an explicit native
// provider profile.
export function resolveNativeSelectionFromManifest(manifest) {
  const options = manifest?.options || {};
  const tool = trimString(manifest?.tool);
  const runtimeFamily = trimString(options.runtimeFamily || manifest?.runtimeFamily);
  const nativeAgentType = tool === 'claude' || tool === 'claude-bidi'
    || runtimeFamily.startsWith('claude-')
    ? 'claude'
    : (tool === 'codex' || tool === 'codex-cli' || runtimeFamily.startsWith('codex-')
      ? 'codex'
      : (tool === 'agy' || runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json'
        ? 'agy'
        : ''));
  const requestedHarnessId = tool || ({
    'pi-rpc-jsonl': 'pi', 'qwen-code-acp': 'qwen-code',
    'opencode-json': 'opencode', 'kimi-code-acp': 'kimi-code',
    'goose-headless': 'goose', 'openhands-headless': 'openhands',
    'copilot-json': 'copilot', 'hermes-acp': 'hermes',
    'cline-json': 'cline', 'kilo-json': 'kilo',
  }[runtimeFamily] || '');
  const harnessId = requestedHarnessId === 'kilo-code' ? 'kilo' : requestedHarnessId;
  const genericHarnesses = new Set(['pi', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo']);
  const agentType = nativeAgentType || (genericHarnesses.has(harnessId) ? 'harness' : '');
  const model = trimString(options.model);
  const serviceTier = trimString(options.serviceTier);
  // Both native catalogs scope ids as `model@providerId`; the suffix selects
  // the provider but must never reach the CLI's --model flag.  Only known
  // provider-id shapes split, so a model id that itself contains '@' is kept
  // whole (same rule as parseScopedCodexModel in chat/models.mjs).
  let scopedProviderId = '';
  if (model.includes('@')) {
    const at = model.lastIndexOf('@');
    const candidate = model.slice(at + 1);
    if (at > 0 && /^[A-Za-z0-9._-]+$/.test(candidate)) scopedProviderId = candidate;
  }
  return {
    agentType,
    // A custom tool may intentionally expose a native runtime family (the
    // test and plugin surfaces do this for AgY/Codex doubles).  Its tool id is
    // not a harness provider type and must not narrow native default-provider
    // resolution to an impossible `agentType === tool` match.
    harnessId: agentType === 'harness' ? harnessId : '',
    providerProfileId: trimString(options.providerProfile) || scopedProviderId,
    model,
    serviceTier,
  };
}

// Before the multi-account runtime existed, AgY login wrote one opaque token
// file under agy-control.  Import it exactly once into the vault when a
// registry has no equivalent profile.  The source is never deleted or used as
// a live Run home, so an older CLI process cannot overwrite a new account.
export async function migrateLegacyAgyProvider({
  registry,
  secretStore,
  legacyAuthFile = resolveAgyAuthFile(AGY_CONTROL_HOME_DIR),
  providerId = 'agy-official',
  displayName = 'agy legacy account',
  readFileImpl = readFile,
} = {}) {
  if (!registry || !secretStore) return null;
  const existing = await registry.getProviderProfile(providerId).catch(() => null);
  if (existing?.agentType === 'agy') return existing;
  let tokenFile;
  try {
    tokenFile = await readFileImpl(legacyAuthFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!String(tokenFile || '').trim()) return null;

  const authProfileId = `auth-${providerId}`;
  const storageRef = `secret-${providerId}`;
  const stored = await secretStore.writeSecret(storageRef, {
    authType: 'oauth',
    tokens: { tokenFile: String(tokenFile) },
  });
  if (!stored?.ok) throw new Error(`Unable to migrate AgY credential (${stored.reason || 'secret-store-failed'})`);
  const authResult = await registry.upsertAuthProfile({
    id: authProfileId,
    agentType: 'agy',
    authType: 'oauth',
    displayName,
    storageType: 'secret-store',
    storageRef,
    accountMetadata: { migratedFrom: legacyAuthFile },
  });
  if (!authResult?.ok) throw new Error(authResult.errors?.join(', ') || 'Unable to migrate AgY auth profile');
  const providerResult = await registry.upsertProviderProfile({
    id: providerId,
    agentType: 'agy',
    protocol: 'agy',
    displayName,
    baseUrl: '',
    authProfileId,
    modelPolicy: null,
    quotaPolicy: { mode: 'official_subscription', adapter: 'agy' },
  });
  if (!providerResult?.ok) throw new Error(providerResult.errors?.join(', ') || 'Unable to migrate AgY provider profile');
  return providerResult.profile;
}

// —— Default provider resolution ——
//
// The native runtime has no global "current provider", but a Run with no
// explicit selection (no session preference, no `model@providerId` suffix)
// still needs a deterministic answer instead of a refusal.  Resolution
// order: most-recently-used oauth row → most-recently-used any row →
// registry updatedAt (newest) as a first-boot fallback.  Official OAuth
// ranks first because an api-key relay must never silently take over a
// session the user signed in with.

function usageStatePath(configDir) {
  return join(configDir, 'native-provider-runtime', 'selection-usage.json');
}

async function readSelectionUsage(configDir, readFileImpl) {
  try {
    const text = await readFileImpl(usageStatePath(configDir), 'utf8');
    const parsed = JSON.parse(text);
    const usage = parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : {};
    const clean = {};
    for (const [key, value] of Object.entries(usage)) {
      const agentType = typeof key === 'string' ? key.trim() : '';
      const at = typeof value?.at === 'string' ? value.at : '';
      if ((agentType === 'codex' || agentType === 'claude' || agentType === 'agy'
        || agentType.startsWith('harness:')) && at) {
        clean[agentType] = { at, providerId: trimString(value.providerId) };
      }
    }
    return clean;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    return {};
  }
}

export async function recordSelectionUsage(configDir, agentType, providerId, {
  readFileImpl = readFile, writeFileImpl = writeFile, mkdirImpl = mkdir,
  renameImpl = rename, unlinkImpl = unlink, harnessId = '',
} = {}) {
  const usageKey = agentType === 'harness' && trimString(harnessId)
    ? `harness:${trimString(harnessId)}`
    : agentType;
  await mkdirImpl(join(configDir, 'native-provider-runtime'), { recursive: true, mode: 0o700 });
  const usagePath = usageStatePath(configDir);
  const lock = await acquireNativeOAuthLock(`${usagePath}.lock`, { waitMs: 2_000, pollMs: 10 });
  try {
    const usage = await readSelectionUsage(configDir, readFileImpl);
    const previous = usage[usageKey] || {};
    if (previous.providerId === providerId && previous.at) return; // idempotent
    usage[usageKey] = { at: new Date().toISOString(), providerId };
    await writeProviderFileAtomic(usagePath, `${JSON.stringify({ usage }, null, 2)}\n`,
      { mode: 0o600 }, { writeFileImpl, renameImpl, unlinkImpl });
  } finally {
    await lock.release();
  }
}

export async function resolveDefaultProviderProfileId(agentType, { configDir, registry, readFileImpl, rotationStore, harnessId = '' }) {
  const profiles = await registry.listProviderProfiles().catch(() => []);
  if (agentType === 'agy' && rotationStore) {
    const rotated = await rotationStore.selectNext(profiles);
    if (rotated?.id) return rotated.id;
  }
  const usage = await readSelectionUsage(configDir, readFileImpl);
  const usageKey = agentType === 'harness' && trimString(harnessId)
    ? `harness:${trimString(harnessId)}`
    : agentType;
  const lastUsed = trimString(usage[usageKey]?.providerId);
  if (lastUsed) {
    const profile = await registry.getProviderProfile(lastUsed).catch(() => null);
    const profileMatches = harnessId
      ? profile?.agentType === harnessId
      : agentType === 'harness' || profile?.agentType === agentType;
    if (profileMatches) return profile.id;
  }
  // No usage recorded (fresh install): newest registry row wins, oauth first.
  const candidates = profiles.filter((row) => harnessId
    ? row.agentType === harnessId
    : (agentType === 'harness' || row.agentType === agentType));
  if (candidates.length === 0) return '';
  const authRows = await registry.listAuthProfiles().catch(() => []);
  const authTypeById = new Map(authRows.map((row) => [row.id, row.authType]));
  const rank = (row) => (authTypeById.get(row.authProfileId) === 'oauth' ? 1 : 0);
  candidates.sort((a, b) => rank(b) - rank(a)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return candidates[0].id;
}

function hasRunnerOwner(ownerUid, ownerGid) {
  return Number.isInteger(ownerUid) && ownerUid >= 0
    && Number.isInteger(ownerGid) && ownerGid >= 0;
}

function isCurrentOwner(ownerUid, ownerGid) {
  return ownerUid === process.getuid?.() && ownerGid === process.getgid?.();
}

async function convergeRunnerDirectory(path, {
  runnerReadable,
  runnerOwnerUid,
  runnerOwnerGid,
  chownImpl,
  chmodImpl,
}) {
  if (hasRunnerOwner(runnerOwnerUid, runnerOwnerGid)
    && !isCurrentOwner(runnerOwnerUid, runnerOwnerGid)) {
    // The lifecycle broker is root-owned, while the transient Run is not.
    // Converge the complete directory chain before writing files so a newly
    // created (or previously root-owned 0700) provider key cannot strand the
    // runner after the broker launches it.
    await chownImpl(path, runnerOwnerUid, runnerOwnerGid);
  }
  if (runnerReadable) {
    try {
      await chmodImpl(path, 0o2770);
    } catch (error) {
      // Unprivileged development/test users cannot set the setgid bit on
      // some filesystems.  Ownership and group traversal still provide the
      // required contract; privileged package installs retain 02770.
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
      await chmodImpl(path, 0o770);
    }
  }
}

async function convergeRunnerFile(path, {
  runnerReadable,
  runnerOwnerUid,
  runnerOwnerGid,
  chownImpl,
  chmodImpl,
}) {
  if (hasRunnerOwner(runnerOwnerUid, runnerOwnerGid)
    && !isCurrentOwner(runnerOwnerUid, runnerOwnerGid)) {
    // A file may predate this preparation and therefore already exist with a
    // different owner.  ENOENT is tolerated only for optional files (for
    // example auth.json on an unusual provider shape); other errors remain a
    // hard preparation failure instead of becoming a later EACCES.
    try {
      await chownImpl(path, runnerOwnerUid, runnerOwnerGid);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (runnerReadable) await chmodImpl(path, 0o640).catch(() => {});
}

// Prepare a scoped provider home for one Run from the native registry.
// Returns the scoped provider-home preparation shape used by the runner:
//   { ok, synced, providerId, homeDir }  — or { ok:false, reason } on refusal.
export async function prepareNativeRunProviderHome(runId, manifest, {
  configDir,
  providerHomesRoot,
  externalCodexAuthFile = resolveExternalCodexAuthFile(),
  externalCodexHandoffPolicy = resolveExternalCodexHandoffPolicy(),
  // Codex OAuth is machine-local by contract. Never let a native Codex Run
  // inspect or symlink to ~/.codex/auth.json. Passing true is rejected below
  // so old launchers fail closed instead of silently reintroducing the bridge.
  externalOAuthOwnership = null,
  // Launchers hold the provider-scoped lock through preparation and hand it
  // off to the sidecar, so no later Run can overwrite auth.json before Codex
  // has finished a refresh. Direct callers get a prepare-only lock.
  holdNativeOAuthLock = false,
  runnerReadable = false,
  // Control-side background work (labels, task cards, compact extractors)
  // must never share a mutable Claude home with a foreground Run.  The normal
  // CLI resume path still uses the provider-scoped home; callers that do not
  // resume can explicitly request an ephemeral per-operation home.
  forceRunScopedHome = false,
  // Control-side Codex OAuth must use the foreground broker's canonical home.
  // Static credentials and other Harnesses retain their isolated operation home.
  codexOAuthProviderHomesRoot = '',
  runnerOwnerUid = null,
  runnerOwnerGid = null,
  previousRunnerOwnerUid = null,
  migrateManagedHomeOwnershipImpl = migrateManagedHomeOwnership,
  registry = createNativeProviderRegistry({ configDir }),
  secretStore = createSecretStore({ configDir }),
  mkdirImpl = mkdir,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
  chownImpl = chown,
  renameImpl = rename,
  unlinkImpl = unlink,
  statImpl = stat,
  legacyAgyAuthFile = resolveAgyAuthFile(AGY_CONTROL_HOME_DIR),
  rotationStore = createAgyRotationStore({ configDir }),
} = {}) {
  const selection = resolveNativeSelectionFromManifest(manifest);
  if (!selection.agentType) {
    return { ok: true, synced: false, providerId: '', reason: 'not-a-provider-runtime' };
  }
  const requiredFiles = [];
  if (selection.agentType === 'agy') {
    await migrateLegacyAgyProvider({
      registry,
      secretStore,
      legacyAuthFile: legacyAgyAuthFile,
      readFileImpl,
    }).catch(() => null);
  }
  if (!selection.providerProfileId) {
    // No explicit selection: fall back to the deterministic default (last
    // used, oauth first) instead of refusing.  The chosen id is recorded so
    // the next implicit Run keeps hitting the same provider.
    selection.providerProfileId = await resolveDefaultProviderProfileId(selection.agentType, {
      configDir, registry, readFileImpl, rotationStore, harnessId: selection.harnessId,
    });
    if (!selection.providerProfileId) {
      return {
        ok: false,
        synced: false,
        reason: 'native-provider-not-selected',
        error: `No ${selection.agentType} provider profile is registered; import or create one first.`,
      };
    }
  }

  let snapshot;
  try {
    snapshot = await resolveRuntimeConfig({
      runRequest: { ...selection, runId },
      registry,
      secretStore,
    });
  } catch (error) {
    if (error instanceof RuntimeConfigResolutionError) {
      return { ok: false, synced: false, reason: error.code, error: error.message };
    }
    return { ok: false, synced: false, reason: 'resolution-failed', error: error?.message || String(error) };
  }

  const provider = await registry.getProviderProfile(selection.providerProfileId);
  let resolvedClaudeModelContract = null;
  if (provider?.enabled === false || (provider?.status && provider.status !== 'ready')) {
    return {
      ok: false,
      synced: false,
      providerId: selection.providerProfileId,
      reason: provider?.status === 'disabled' ? 'provider-disabled' : 'provider-not-ready',
      error: `${selection.harnessId || selection.agentType} provider profile ${selection.providerProfileId} is not available for new Runs`,
    };
  }
  const authProfile = await registry.getAuthProfile(provider.authProfileId);
  if (selection.agentType === 'harness') {
    const compatibility = resolveHarnessProviderCompatibility(selection.harnessId, provider);
    if (!compatibility.ok) {
      return {
        ok: false,
        synced: false,
        providerId: selection.providerProfileId,
        reason: compatibility.reason,
        error: `Provider ${provider.id} protocol ${provider.protocol} is not supported by ${selection.harnessId}`,
      };
    }
    if (authProfile?.authType !== 'api-key') {
      return {
        ok: false,
        synced: false,
        providerId: selection.providerProfileId,
        reason: 'harness-provider-api-key-required',
        error: `${selection.harnessId} provider bridge currently supports API-key profiles only`,
      };
    }
  }
  let secret = await secretStore.resolveSecret(authProfile.storageRef);
  if (!secret?.ok) {
    return { ok: false, synced: false, reason: 'credential-missing', error: `Credential ${authProfile.storageRef} unavailable: ${secret?.reason}` };
  }
  if (selection.agentType === 'claude' && secret.authType === 'oauth') {
    return {
      ok: false,
      synced: false,
      providerId: selection.providerProfileId,
      reason: 'claude-oauth-unsupported',
      error: 'Claude normal OAuth is no longer supported; use claude setup-token on this machine or an API key.',
    };
  }

  const allowExternalOAuthOwnership = externalOAuthOwnership === null
    ? false
    : externalOAuthOwnership === true;
  if (selection.agentType === 'codex' && secret.authType === 'oauth' && allowExternalOAuthOwnership) {
    return {
      ok: false,
      synced: false,
      providerId: selection.providerProfileId,
      reason: 'external-codex-oauth-disabled',
      error: 'Native Codex OAuth is machine-local; sign in through AgentoC on this machine instead of reusing ~/.codex/auth.json.',
    };
  }

  // When the legacy Codex compatibility ownership mode is enabled, decide
  // account ownership before reconciling the persistent native home. This
  // keeps external logout and account switches explicit instead of allowing
  // an implicit refresh takeover.
  let externalAuthSnapshot = null;
  let externalOwnershipState = null;
  const externalProvider = allowExternalOAuthOwnership && selection.agentType === 'codex'
    ? {
      agentType: 'codex',
      source: 'external-codex',
      authFile: externalCodexAuthFile,
      inspect: inspectExternalCodexAuth,
      observe: observeExternalCodexOwnership,
      getRecord: getExternalCodexOwnershipRecord,
      externalFileKey: 'externalCodexAuthFile',
    }
      : null;
  if (externalProvider) {
    externalAuthSnapshot = await externalProvider.inspect({
      [externalProvider.externalFileKey]: externalProvider.authFile,
      readFileImpl,
    });
    if (externalAuthSnapshot.ok) {
      const observed = await externalProvider.observe({
        configDir,
        accountId: externalAuthSnapshot.status === 'logged-in'
          ? (externalAuthSnapshot.ownershipKey || externalAuthSnapshot.accountId)
          : '',
        fingerprint: externalAuthSnapshot.status === 'logged-in'
          ? externalAuthSnapshot.fingerprint
          : '',
        ...(selection.agentType === 'codex'
          ? { handoffPolicy: externalCodexHandoffPolicy }
          : {}),
      });
      if (!observed.ok && secret.authType === 'oauth') {
        return {
          ok: false,
          synced: false,
          reason: observed.reason,
          error: `External ${selection.agentType} ownership state could not be updated safely; refusing to refresh an official OAuth account.`,
        };
      }
      externalOwnershipState = observed.state || null;
    }
  }

  if (externalProvider && secret.authType === 'oauth') {
    if (!externalAuthSnapshot?.ok) {
      return {
        ok: false,
        synced: false,
        reason: externalAuthSnapshot?.reason || `${externalProvider.source}-auth-unreadable`,
        error: `External ${selection.agentType} auth exists but cannot be read safely; refusing to refresh an official OAuth account from Agentoc.`,
      };
    }
    if (externalAuthSnapshot.status === 'account-unknown') {
      return {
        ok: false,
        synced: false,
        reason: `${externalProvider.source}-account-unknown`,
        error: `External ${selection.agentType} is logged in but its account identity is unavailable; refusing to choose a refresh owner.`,
      };
    }
    const selectedStableAccountId = nativeOAuthAccountId(secret.tokens);
    const selectedAccountId = selectedStableAccountId;
    const currentExternalAccountId = externalAuthSnapshot.status === 'logged-in'
      ? (externalAuthSnapshot.ownershipKey || externalAuthSnapshot.accountId)
      : '';
    const priorOwnership = externalProvider.getRecord(externalOwnershipState, selectedAccountId);
    if (priorOwnership?.status === 'handoff-pending'
      && currentExternalAccountId !== selectedAccountId) {
      return {
        ok: false,
        synced: false,
        reason: `${externalProvider.source}-handoff-pending`,
        error: `This OAuth account was previously owned by external ${selection.agentType} and is awaiting explicit takeover.`,
      };
    }
  }

  // Native Codex OAuth is machine-local. The optional external-provider branch
  // is retained only for the legacy Codex compatibility policy; the default
  // prepared provider home is the only refresh owner on this machine.
  const externalOAuthOwner = await detectExternalOAuthOwner({
    agentType: selection.agentType,
    externalProvider,
    secret,
    externalAuthSnapshot,
  });
  if (externalOAuthOwner?.error) {
    return {
      ok: false,
      synced: false,
      reason: externalOAuthOwner.error,
      error: `External ${selection.agentType} auth exists but cannot be read safely; refusing to refresh an official OAuth account from Agentoc.`,
    };
  }

  // Keep a permission-restricted backup of the legacy external Codex owner's
  // latest complete credential. It is never selected while that external
  // account is active, but makes handoff viable after the external CLI logs
  // out or switches accounts (refresh-token rotation otherwise strands the
  // older AgentoC credential).
  if (externalOAuthOwner && secret.authType === 'oauth') {
    const syncedFallback = await secretStore.writeSecret(authProfile.storageRef, {
      authType: 'oauth',
      tokens: externalAuthSnapshot.tokens,
    });
    if (!syncedFallback?.ok) {
      return {
        ok: false,
        synced: false,
        reason: 'external-oauth-fallback-sync-failed',
        error: `External ${selection.agentType} OAuth fallback credentials could not be stored safely.`,
      };
    }
    const refreshedSecret = await secretStore.resolveSecret(authProfile.storageRef);
    if (!refreshedSecret?.ok || refreshedSecret.authType !== 'oauth') {
      return {
        ok: false,
        synced: false,
        reason: 'external-oauth-fallback-sync-readback-failed',
        error: `External ${selection.agentType} OAuth fallback credentials could not be verified.`,
      };
    }
    secret = refreshedSecret;
    try {
      snapshot = await resolveRuntimeConfig({
        runRequest: { ...selection, runId },
        registry,
        secretStore,
      });
    } catch (error) {
      return {
        ok: false,
        synced: false,
        reason: error instanceof RuntimeConfigResolutionError ? error.code : 'resolution-failed',
        error: error?.message || String(error),
      };
    }
  }

  // Codex OAuth uses one machine-local provider home per provider profile. The
  // app-server broker later owns that home for all ordinary concurrent Runs;
  // preparation only materializes the current credential generation here.
  const providerKey = createHash('sha256')
    .update(`${selection.agentType}:${selection.providerProfileId}`)
    .digest('hex')
    .slice(0, 32);
  const runKey = createHash('sha256')
    .update(String(runId || ''))
    .digest('hex')
    .slice(0, 32);
  const sharedCodexOAuth = selection.agentType === 'codex' && secret.authType === 'oauth'
    && !externalOAuthOwner && Boolean(trimString(codexOAuthProviderHomesRoot));
  if (sharedCodexOAuth) providerHomesRoot = trimString(codexOAuthProviderHomesRoot);
  const providerHomesByProviderRoot = join(providerHomesRoot, 'by-provider');
  const providerHomeRoot = join(providerHomesByProviderRoot, providerKey);
  const candidateHomeRoot = selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner
    ? await resolveCodexProfileAccountHome({ configDir, providerHomeRoot, providerProfileId: selection.providerProfileId,
      accountId: nativeOAuthAccountId(secret.tokens), initialize: !sharedCodexOAuth && !forceRunScopedHome })
    : providerHomeRoot;
  const providerRunsRoot = join(providerHomeRoot, 'by-run');
  const externalRunHomeRoot = join(providerHomeRoot, 'by-run', runKey);
  let homeRoot = selection.agentType === 'agy'
    ? join(providerHomeRoot, 'by-run', runKey)
    : ((forceRunScopedHome && !sharedCodexOAuth) || externalOAuthOwner || secret.authType === 'oauth-token'
      ? externalRunHomeRoot
      : candidateHomeRoot);
  if (selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner && homeRoot === candidateHomeRoot) {
    const routeAccountHome = sharedCodexOAuth ? resolveBoundCodexAccountHome : coordinateCodexAccountRoute;
    homeRoot = await routeAccountHome({ configDir, providerHomesRoot,
      candidateHomeRoot, accountId: nativeOAuthAccountId(secret.tokens) });
  }
  const agentHome = join(homeRoot, selection.agentType === 'harness' ? selection.harnessId : selection.agentType);
  if (sharedCodexOAuth) {
    // Resolve only. Control services must not create/chown the ordinary
    // execution owner's home or rewrite its live config/auth/rotation marker.
    // The IPC client refuses an absent broker without spawning a replacement.
    return {
      ok: true, synced: false, providerId: selection.providerProfileId,
      homeDir: homeRoot, codexHomeDir: agentHome, oauthOwner: 'agentoc',
      oauthAccountId: nativeOAuthAccountId(secret.tokens),
      snapshot: { model: snapshot.model },
    };
  }
  // Once the machine-local Codex broker is ready, its auth.json is the live
  // refresh owner. A later Run preparation must not copy an older SecretStore
  // generation over the broker's newer file between two turns.
  let codexBrokerReady = selection.agentType === 'codex'
    && secret.authType === 'oauth'
    && await isCodexAppServerBrokerReady(codexAppServerBrokerSocketPath(agentHome), 250);
  // mkdir(2) with setgid is rejected for non-root users on some local
  // filesystems, including when the directory already exists.  The
  // convergence pass below upgrades to 02770 whenever the caller is allowed
  // to do so; 0770 is the portable creation mode.
  let nativeOAuthLock = null;
  let codexCreationLock = null;
  let nativeOAuthLockHandedOff = false;
  await mkdirImpl(providerHomesRoot, { recursive: true, mode: 0o770 });
  await mkdirImpl(providerHomesByProviderRoot, { recursive: true, mode: 0o770 });
  await mkdirImpl(providerHomeRoot, { recursive: true, mode: 0o770 });
  try {
    if (selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner) {
      // Coordinate with broker initialization, not only ready brokers. Otherwise
      // preparation can overwrite a just-rotated auth.json before initialize ends.
      codexCreationLock = await acquireNativeOAuthLock(codexAppServerBrokerLockPath(agentHome));
      await assertCodexHomeNotFenced(homeRoot);
      codexBrokerReady = await isCodexAppServerBrokerReady(codexAppServerBrokerSocketPath(agentHome), 250);
    }
    if (codexBrokerReady && selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner) {
      const liveAuth = await readJsonIfPresent(join(agentHome, 'auth.json'), readFileImpl);
      const liveAccountId = nativeOAuthAccountId(liveAuth?.tokens);
      const selectedAccountId = nativeOAuthAccountId(secret.tokens);
      if (liveAccountId && selectedAccountId && liveAccountId !== selectedAccountId) {
        return { ok: false, synced: false, reason: 'codex-broker-account-changed',
          error: 'The selected Codex account changed while its previous broker is active; retry after that broker has stopped.' };
      }
    }
    if (secret.authType === 'oauth' && !externalOAuthOwner && selection.agentType === 'codex' && !codexBrokerReady) {
      nativeOAuthLock = await acquireNativeOAuthLock(nativeOAuthLockPath(homeRoot));
    }
    await mkdirImpl(providerRunsRoot, { recursive: true, mode: 0o770 });
    await mkdirImpl(homeRoot, { recursive: true, mode: 0o770 });
    await mkdirImpl(agentHome, { recursive: true, mode: 0o770 });
    // A shared Codex home may contain SQLite databases, lock files and session
    // directories created under a previous runner identity. Migrate that one
    // managed home while the OAuth/broker locks are held, before changing its
    // directory owner. A live shared broker must never have its files moved.
    if (process.platform === 'linux' && process.getuid?.() === 0
        && selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner && !codexBrokerReady
        && hasRunnerOwner(runnerOwnerUid, runnerOwnerGid) && runnerOwnerUid > 0 && runnerOwnerGid > 0) {
      await migrateManagedHomeOwnershipImpl(agentHome, {
        targetUid:runnerOwnerUid, targetGid:runnerOwnerGid,
        additionalSourceUid:previousRunnerOwnerUid,
      });
    }
    if (runnerReadable || hasRunnerOwner(runnerOwnerUid, runnerOwnerGid)) {
      for (const directory of [
        providerHomesRoot,
        providerHomesByProviderRoot,
        providerHomeRoot,
        ...(homeRoot === candidateHomeRoot && candidateHomeRoot !== providerHomeRoot ? [join(providerHomeRoot, 'by-account')] : []),
        providerRunsRoot,
        homeRoot,
        agentHome,
      ]) {
        await convergeRunnerDirectory(directory, {
          runnerReadable,
          runnerOwnerUid,
          runnerOwnerGid,
          chownImpl,
          chmodImpl,
        });
      }
    }

    let reconciledOAuth = null;
    if (secret.authType === 'oauth' && !externalOAuthOwner && selection.agentType !== 'harness' && !codexBrokerReady) {
      reconciledOAuth = await reconcileNativeOAuthCredentials({
        agentType: selection.agentType,
        agentHome,
        storageRef: authProfile.storageRef,
        secret,
        secretStore,
        readFileImpl,
      });
      if (!reconciledOAuth.ok) {
        return {
          ok: false,
          synced: false,
          reason: reconciledOAuth.reason,
          error: reconciledOAuth.error || 'Native OAuth credentials could not be persisted safely',
        };
      }
      secret = reconciledOAuth.secret;
      if (reconciledOAuth.persisted) {
        try {
          snapshot = await resolveRuntimeConfig({
            runRequest: { ...selection, runId },
            registry,
            secretStore,
          });
        } catch (error) {
          if (error instanceof RuntimeConfigResolutionError) {
            return { ok: false, synced: false, reason: error.code, error: error.message };
          }
          return { ok: false, synced: false, reason: 'resolution-failed', error: error?.message || String(error) };
        }
      }
    }

  if (selection.agentType === 'agy') {
    const tokenFile = trimString(secret.tokens?.tokenFile);
    if (!tokenFile) {
      return {
        ok: false,
        synced: false,
        reason: 'agy-credential-malformed',
        error: 'The selected AgY credential does not contain a token payload.',
      };
    }
    const authPath = join(agentHome, AGY_AUTH_RELATIVE_PATH);
    await mkdirImpl(join(agentHome, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o770 });
    await writeProviderFileAtomic(
      authPath,
      tokenFile,
      { mode: runnerReadable ? 0o640 : 0o600 },
      { writeFileImpl, renameImpl, unlinkImpl },
    );
    await chmodImpl(authPath, runnerReadable ? 0o640 : 0o600).catch(() => {});
    requiredFiles.push(authPath);
  } else if (selection.agentType === 'codex') {
    const isOfficial = secret.authType === 'oauth';
    const runtimeOAuthTokens = secret.tokens;
    const configLines = [
      '# AgentoC native provider runtime — generated from the provider registry.',
      `# snapshot ${snapshot.configHash}`,
      `model = ${JSON.stringify(snapshot.model)}`,
    ];
    if (isOfficial) {
      configLines.push(
        'model_provider = "agentoc-official"',
        '',
        '[model_providers.agentoc-official]',
        'name = "AgentoC Official ChatGPT"',
        `base_url = ${JSON.stringify(provider.baseUrl || 'https://chatgpt.com/backend-api/codex')}`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
      );
    } else {
      configLines.push(
        'model_provider = "agentoc-runtime-provider"',
        '',
        '[model_providers.agentoc-runtime-provider]',
        'name = "AgentoC Runtime Provider"',
        `base_url = ${JSON.stringify(provider.baseUrl)}`,
        // Codex always speaks Responses. provider.protocol describes the
        // upstream API format for the conversion gateway, not Codex wire_api.
        'wire_api = "responses"',
        // API-key profiles are materialized as OPENAI_API_KEY in the
        // Run-scoped auth.json below.  Codex only loads that file for a
        // custom provider when the provider opts into the OpenAI auth store.
        'requires_openai_auth = true',
      );
    }
    configLines.push(
      '',
      ...codexWindowsSandboxConfig(),
      '[features]',
      'plugins = false',
      'unified_exec = false',
      '',
      // Codex's current config schema models the file credential store as a
      // boolean.  The historical string value ("file") is rejected before
      // the provider can start: invalid type, expected a boolean.
      'cli_auth_credentials_store = true',
      '',
    );
    const configPath = join(agentHome, 'config.toml');
    await writeProviderFileAtomic(
      configPath,
      configLines.join('\n'),
      { mode: 0o600 },
      { writeFileImpl, renameImpl, unlinkImpl },
    );
    requiredFiles.push(configPath);
    if (isOfficial && externalOAuthOwner?.authFile) {
      const materialized = await materializeExternalCodexAuth({
        agentHome,
        externalAuthFile: externalOAuthOwner.authFile,
      });
      if (!materialized.ok) {
        return {
          ok: false,
          synced: false,
          reason: materialized.reason,
          error: 'External Codex credentials could not be materialized for the isolated Run home.',
        };
      }
      requiredFiles.push(join(agentHome, 'auth.json'));
    } else if (isOfficial && codexBrokerReady) {
      // The broker owns this live file. Only verify it below; never restore
      // the SecretStore copy while the upstream app-server can be refreshing.
      requiredFiles.push(join(agentHome, 'auth.json'));
    } else if (isOfficial) {
      const authPath = join(agentHome, 'auth.json');
      // A live provider process can rotate auth.json between the reconcile
      // read above and this write. Re-read the file and never overwrite a
      // newer generation: restoring a consumed refresh token makes the next
      // refresh fail with "refresh token was already used" and revokes the
      // account's whole token family. The newer file is authoritative and the
      // next preparation's reconcile persists it into the vault.
      const currentRuntimeAuth = await readJsonIfPresent(authPath, readFileImpl);
      const currentRuntimeTokens = currentRuntimeAuth?.tokens;
      const currentRuntimeAccountId = nativeOAuthAccountId(currentRuntimeTokens);
      const selectedRuntimeAccountId = nativeOAuthAccountId(runtimeOAuthTokens);
      const accountsDiffer = currentRuntimeAccountId && selectedRuntimeAccountId && currentRuntimeAccountId !== selectedRuntimeAccountId;
      const runtimeGenerationNewer = hasOAuthTokenPair(currentRuntimeTokens)
        && !accountsDiffer
        && isNativeOAuthGenerationNewer(currentRuntimeTokens, runtimeOAuthTokens);
      if (!runtimeGenerationNewer) {
        await writeProviderFileAtomic(
          authPath,
          JSON.stringify({
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: null,
            tokens: runtimeOAuthTokens,
            last_refresh: externalOAuthOwner?.lastRefresh
              || (reconciledOAuth?.runtimeFingerprint === nativeOAuthTokenFingerprint(secret.tokens)
              ? reconciledOAuth.runtimeLastRefresh
              : null),
          }) + '\n',
          { mode: 0o600 },
          { writeFileImpl, renameImpl, unlinkImpl },
        );
      }
      requiredFiles.push(authPath);
    } else if (!isOfficial) {
      // API-key rows keep the credential in auth.json's OPENAI_API_KEY shape —
      // that is what codex reads for env_key-less custom providers when the
      // env var is not present; the launcher also injects it as env.
      const authPath = join(agentHome, 'auth.json');
      await writeProviderFileAtomic(
        authPath,
        JSON.stringify({ OPENAI_API_KEY: secret.apiKey }) + '\n',
        { mode: 0o600 },
        { writeFileImpl, renameImpl, unlinkImpl },
      );
      requiredFiles.push(authPath);
    }
  } else if (selection.agentType === 'claude') {
    // One Run may cause Claude Code to emit both a foreground `--model` call
    // and hidden small-model calls such as generate_session_title.  They must
    // all use the same concrete, validated model.  Do not independently copy
    // a stale `haiku` policy into this home.
    const modelPolicy = provider.modelPolicy && typeof provider.modelPolicy === 'object'
      ? provider.modelPolicy
      : {};
    const contractResult = resolveClaudeModelContract({
      contract: manifest?.options?.claudeModelContract,
      providerProfileId: selection.providerProfileId,
      providerRevision: snapshot.providerRevision,
      requestedModel: manifest?.options?.model,
      snapshotModel: snapshot.model,
      modelPolicy,
    });
    if (!contractResult.ok) {
      return {
        ok: false,
        synced: false,
        providerId: selection.providerProfileId,
        reason: contractResult.code || 'claude-model-contract-invalid',
        error: contractResult.message || 'Claude model contract is invalid.',
      };
    }
    const claudeModelContract = contractResult.contract;
    resolvedClaudeModelContract = claudeModelContract;
    const settings = {
      env: secret.authType === 'oauth-token'
        ? {
          // setup-token is a long-lived bearer credential. It is safe to
          // expose to this isolated Run, but it must never be written as a
          // rotating .credentials.json bundle.
          CLAUDE_CODE_OAUTH_TOKEN: secret.token,
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
        }
        : {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ...(snapshot.authToken ? { ANTHROPIC_AUTH_TOKEN: snapshot.authToken } : {}),
          ANTHROPIC_API_KEY: secret.apiKey,
          ANTHROPIC_MODEL: claudeModelContract.aliases.default,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeModelContract.aliases.haiku,
          ANTHROPIC_DEFAULT_SONNET_MODEL: claudeModelContract.aliases.sonnet,
          ANTHROPIC_DEFAULT_OPUS_MODEL: claudeModelContract.aliases.opus,
          ANTHROPIC_DEFAULT_FABLE_MODEL: claudeModelContract.aliases.fable,
          ANTHROPIC_SMALL_FAST_MODEL: claudeModelContract.aliases.smallFast,
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
        },
    };
    const settingsPath = join(agentHome, 'settings.json');
    await writeProviderFileAtomic(
      settingsPath,
      JSON.stringify(settings, null, 2) + '\n',
      { mode: 0o600 },
      { writeFileImpl, renameImpl, unlinkImpl },
    );
    requiredFiles.push(settingsPath);
  } else if (selection.agentType === 'harness') {
    const bridge = buildHarnessProviderFiles(selection.harnessId, snapshot, secret);
    if (!bridge.ok) {
      return { ok: false, synced: false, providerId: selection.providerProfileId, reason: bridge.reason, error: `Unable to prepare ${selection.harnessId} provider bridge` };
    }
    for (const file of bridge.files) {
      await mkdirImpl(dirname(join(agentHome, file.name)), { recursive: true, mode: 0o770 });
      const filePath = join(agentHome, file.name);
      await writeProviderFileAtomic(
        filePath,
        file.content,
        { mode: 0o600 },
        { writeFileImpl, renameImpl, unlinkImpl },
      );
      requiredFiles.push(filePath);
    }
  }

  if (secret.authType === 'oauth' && selection.agentType !== 'claude') {
    await writeNativeOAuthState({
      agentHome,
      storageRef: authProfile.storageRef,
      tokens: externalOAuthOwner?.tokens || secret.tokens,
      oauthOwner: externalOAuthOwner?.source || 'agentoc',
      accountId: externalOAuthOwner?.accountId || nativeOAuthAccountId(secret.tokens),
      sourceAuthFile: externalOAuthOwner?.authFile || '',
      sourceFingerprint: externalOAuthOwner?.source
        ? externalAuthSnapshot?.fingerprint
        : nativeOAuthTokenFingerprint(secret.tokens),
      writeFileImpl,
      chmodImpl,
      renameImpl,
      unlinkImpl,
    });
  }

  // The sidecar's drift guard reads this marker.
  const markerPath = join(agentHome, '.agentoc-provider-id');
  await writeProviderFileAtomic(
    markerPath,
    `${selection.providerProfileId}\n`,
    { mode: 0o600 },
    { writeFileImpl, renameImpl, unlinkImpl },
  );
  requiredFiles.push(markerPath);
  if (selection.agentType === 'codex' && secret.authType === 'oauth' && !externalOAuthOwner && nativeOAuthAccountId(secret.tokens)) {
    const bindingPath = codexRunBindingPath(agentHome, String(runId || ''));
    const bindingDirectory = dirname(bindingPath);
    await mkdirImpl(bindingDirectory, { recursive: true, mode: 0o770 });
    if (runnerReadable || hasRunnerOwner(runnerOwnerUid, runnerOwnerGid)) {
      await convergeRunnerDirectory(bindingDirectory, { runnerReadable, runnerOwnerUid, runnerOwnerGid, chownImpl, chmodImpl });
    }
    const binding = createCodexRunBinding({ runId: String(runId || ''), providerId: selection.providerProfileId, accountId: nativeOAuthAccountId(secret.tokens) });
    await writeProviderFileAtomic(bindingPath, `${JSON.stringify(binding)}\n`, { mode: runnerReadable ? 0o640 : 0o600 },
      { writeFileImpl, renameImpl, unlinkImpl });
    if (runnerReadable || hasRunnerOwner(runnerOwnerUid, runnerOwnerGid)) {
      await convergeRunnerFile(bindingPath, { runnerReadable, runnerOwnerUid, runnerOwnerGid, chownImpl, chmodImpl });
    }
    requiredFiles.push(bindingPath);
  }
  await verifyPreparedProviderFiles(requiredFiles, { statImpl });
  // Track the last provider that actually prepared for this agent type, so
  // an implicit (no-selection) Run resolves to the user's working provider.
  await recordSelectionUsage(configDir, selection.agentType, selection.providerProfileId, {
    readFileImpl, writeFileImpl, mkdirImpl, renameImpl, unlinkImpl, harnessId: selection.harnessId,
  }).catch(() => {});
  if (runnerReadable) {
    const runnerFiles = ['config.toml', 'config.yaml', 'settings.json', '.credentials.json', '.agentoc-provider.env', 'opencode.json', '.agentoc-openhands.env', '.qwen/settings.json', '.kimi-code/config.toml', 'settings/providers.json', 'kilo.jsonc', '.agentoc-provider-id'];
    // Legacy external-owned auth files may be symlinks. Do not chmod or chown
    // a user-owned source through such a link.
    if (!(selection.agentType === 'codex' && externalOAuthOwner?.authFile)) {
      runnerFiles.splice(1, 0, 'auth.json');
    }
    for (const name of runnerFiles) {
      await convergeRunnerFile(join(agentHome, name), {
        runnerReadable,
        runnerOwnerUid,
        runnerOwnerGid,
        chownImpl,
        chmodImpl,
      });
    }
    if (selection.agentType === 'agy') {
      await convergeRunnerFile(join(agentHome, AGY_AUTH_RELATIVE_PATH), {
        runnerReadable,
        runnerOwnerUid,
        runnerOwnerGid,
        chownImpl,
        chmodImpl,
      });
    }
  }

  if (nativeOAuthLock && (runnerReadable || hasRunnerOwner(runnerOwnerUid, runnerOwnerGid))) {
    await convergeRunnerFile(nativeOAuthLock.path, {
      runnerReadable,
      runnerOwnerUid,
      runnerOwnerGid,
      chownImpl,
      chmodImpl,
    });
  }

  nativeOAuthLockHandedOff = Boolean(nativeOAuthLock && holdNativeOAuthLock);
  return {
    ok: true,
    synced: true,
    providerId: selection.providerProfileId,
    homeDir: homeRoot,
    configHash: snapshot.configHash,
    oauthOwner: externalOAuthOwner?.source || (secret.authType === 'oauth' ? 'agentoc' : null),
    oauthSourceFingerprint: externalOAuthOwner?.source
      ? externalAuthSnapshot?.fingerprint || ''
      : (secret.authType === 'oauth' ? nativeOAuthTokenFingerprint(secret.tokens) : ''),
    oauthAccountId: externalOAuthOwner?.accountId || nativeOAuthAccountId(secret.tokens),
    ...(nativeOAuthLockHandedOff
      ? {
        oauthLock: {
          path: nativeOAuthLock.path,
          token: nativeOAuthLock.token,
          release: nativeOAuthLock.release,
        },
      }
      : {}),
    preparation: {
      state: 'ready',
      stage: 'verified',
      attempt: 1,
      maxAttempts: 1,
    },
    // The Run always uses its generated config. A native Codex Run never
    // inherits the interactive ~/.codex config or auth chain.
    ...(selection.agentType === 'codex' ? { codexHomeDir: agentHome } : {}),
    ...(selection.agentType === 'claude' ? { claudeHomeDir: agentHome } : {}),
    ...(selection.agentType === 'agy' ? { agyHomeDir: agentHome } : {}),
    snapshot: {
      runId,
      agentType: snapshot.agentType,
      providerProfileId: snapshot.providerProfileId,
      providerRevision: snapshot.providerRevision,
      authProfileId: snapshot.authProfileId,
      model: snapshot.model,
      serviceTier: snapshot.serviceTier,
      baseUrl: snapshot.baseUrl,
      credentialFingerprint: snapshot.credentialFingerprint,
      ...(Number.isSafeInteger(snapshot.credentialVersion)
        ? { credentialVersion: snapshot.credentialVersion }
        : {}),
      ...(trimString(snapshot.credentialInstanceId)
        ? { credentialInstanceId: trimString(snapshot.credentialInstanceId) }
        : {}),
      configHash: snapshot.configHash,
      resolvedAt: snapshot.resolvedAt,
      ...(resolvedClaudeModelContract
        ? { claudeModelContract: resolvedClaudeModelContract }
        : {}),
    },
  };
  } finally {
    if (nativeOAuthLock && !nativeOAuthLockHandedOff) await nativeOAuthLock.release();
    await codexCreationLock?.release();
  }
}
