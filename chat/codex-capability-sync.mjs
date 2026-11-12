import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { nativeCodexAccountId, nativeProviderHomeKey, nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { acquireNativeOAuthLock } from '../lib/provider-runtime/oauth-lock.mjs';
import { codexAppServerBrokerSocketPath, isCodexAppServerBrokerReady } from './codex-app-server-broker.mjs';
import { listCodexAppServerCapabilities } from './codex-app-server-client.mjs';

const VALID = new Set(['waiting_for_runtime', 'discovered', 'partial']);
const POLICIES = new Set(['approved-auto', 'manual', 'disabled']);
const scheduled = new Map();
function statePath(configDir, binding, providerId) {
  if (!/^[a-f0-9]{64}$/.test(binding || '') || typeof providerId !== 'string' || !providerId.trim()) throw new Error('Verified Codex account and provider required');
  // Until a legacy provider home has safely handed off, its discovery result
  // must not be borrowed by another profile of the same account.
  return join(configDir, 'native-provider-runtime', 'codex-capability-sync', 'by-account', binding, `${nativeProviderHomeKey('codex', providerId)}.json`);
}

function policyPath(configDir, binding) {
  if (!/^[a-f0-9]{64}$/.test(binding || '')) throw new Error('Verified Codex account required');
  return join(configDir, 'native-provider-runtime', 'codex-capability-sync', 'policies', `${binding}.json`);
}

export async function readCodexSyncPolicy(configDir, binding) {
  let policy;
  try { policy = JSON.parse(await readFile(policyPath(configDir, binding), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return 'approved-auto'; throw error; }
  if (policy?.version !== 1 || !POLICIES.has(policy.mode)) throw new Error('Invalid Codex capability sync policy');
  return policy.mode;
}

export async function writeCodexSyncPolicy(configDir, binding, mode) {
  if (!POLICIES.has(mode)) throw new Error('Invalid Codex capability sync policy');
  const file = policyPath(configDir, binding);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = await acquireNativeOAuthLock(`${file}.lock`, { waitMs: 5_000 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try { await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); }
    finally { await lock.release(); }
  }
  return mode;
}

export async function resolveCodexSyncAccount(providerId, { configDir = CONFIG_DIR,
  registry = createNativeProviderRegistry({ configDir }), secretStore = createSecretStore({ configDir }) } = {}) {
  const profile = await registry.getProviderProfile(providerId).catch(() => null);
  if (!profile || profile.agentType !== 'codex') return null;
  const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
  const secret = auth?.storageRef ? await secretStore.resolveSecret(auth.storageRef).catch(() => null) : null;
  if (secret?.authType !== 'oauth') return null;
  const binding = managedCodexMcpAccountBinding(secret);
  const accountId = nativeCodexAccountId(secret.tokens);
  return binding && accountId ? { profile, binding, accountId } : null;
}

export async function readCodexCapabilitySync(configDir, binding, providerId) {
  let state;
  try { state = JSON.parse(await readFile(statePath(configDir, binding, providerId), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const caps = state?.capabilities;
  if (state?.version !== 1 || !VALID.has(state.status) || typeof state.checkedAt !== 'string' || !Number.isFinite(Date.parse(state.checkedAt))
    || !caps || typeof caps !== 'object' || !['unknown', 'discovered'].includes(caps.apps)
    || !['unknown', 'discovered'].includes(caps.mcp) || caps.skills !== 'requires_session' || caps.plugins !== 'unsupported') {
    throw new Error('Invalid Codex capability sync state');
  }
  return { version: 1, status: state.status, checkedAt: state.checkedAt,
    capabilities: { apps: caps.apps, mcp: caps.mcp, skills: caps.skills, plugins: caps.plugins } };
}

async function saveCodexCapabilitySync(configDir, binding, providerId, state) {
  const file = statePath(configDir, binding, providerId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = await acquireNativeOAuthLock(`${file}.lock`, { waitMs: 5_000 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try { await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; }); }
    finally { await lock.release(); }
  }
}

function discoveryState(result) {
  const capabilities = { apps: result?.apps?.ok && result?.installedApps?.ok ? 'discovered' : 'unknown',
    mcp: result?.mcp?.ok ? 'discovered' : 'unknown', skills: 'requires_session', plugins: 'unsupported' };
  return { version: 1, status: capabilities.apps === 'discovered' && capabilities.mcp === 'discovered' ? 'discovered' : 'partial',
    checkedAt: new Date().toISOString(), capabilities };
}

export async function recordCodexCapabilitySyncResult(providerId, expectedBinding, result, options = {}) {
  const configDir = options.configDir || CONFIG_DIR;
  const account = await resolveCodexSyncAccount(providerId, options);
  if (!account || account.binding !== expectedBinding) return null;
  if (await readCodexSyncPolicy(configDir, account.binding) === 'disabled') return null;
  const state = discoveryState(result);
  await saveCodexCapabilitySync(configDir, account.binding, account.profile.id, state);
  return state;
}

// Login performs only non-blocking discovery against an already-running,
// account-attested broker. It never starts another OAuth owner or installs a
// plugin. A missing broker is represented as pending, not as an empty catalog.
export async function refreshCodexCapabilitySync(providerId, { configDir = CONFIG_DIR,
  managedHomeDir = configDir === CONFIG_DIR ? CODEX_MANAGED_HOME_DIR : join(configDir, 'provider-runtime-homes', 'codex'),
  registry = createNativeProviderRegistry({ configDir }), secretStore = createSecretStore({ configDir }),
  brokerReady = isCodexAppServerBrokerReady, discover = listCodexAppServerCapabilities, automatic = false, expectedBinding = '' } = {}) {
  const options = { configDir, registry, secretStore };
  const account = await resolveCodexSyncAccount(providerId, options);
  if (!account || (expectedBinding && account.binding !== expectedBinding)) return null;
  const mode = await readCodexSyncPolicy(configDir, account.binding);
  if (automatic && mode !== 'approved-auto') return null;
  if (!automatic && mode === 'disabled') throw Object.assign(new Error('Codex capability synchronization is disabled'), { code: 'CODEX_SYNC_DISABLED' });
  const candidate = nativeProviderHomeRoot(dirname(managedHomeDir), 'codex', account.profile.id);
  const homeRoot = await resolveCodexAccountHomeRoot({ configDir, providerHomeRoot: candidate,
    providerProfileId: account.profile.id, accountId: account.accountId });
  const codexHomeDir = join(homeRoot, 'codex');
  const ready = await brokerReady(codexAppServerBrokerSocketPath(codexHomeDir), 250).catch(() => false);
  let capabilities = { apps: 'unknown', mcp: 'unknown', skills: 'requires_session', plugins: 'unsupported' };
  let status = 'waiting_for_runtime';
  if (ready) {
    try {
      const result = await discover({ codexHomeDir, cwd: dirname(managedHomeDir), expectedAccountId: account.accountId, existingBrokerOnly: true, refresh: true });
      const found = discoveryState(result);
      capabilities = found.capabilities;
      status = found.status;
    } catch { status = 'partial'; }
  }
  const current = await resolveCodexSyncAccount(providerId, options);
  if (!current || current.binding !== account.binding) return null;
  const currentMode = await readCodexSyncPolicy(configDir, account.binding);
  if (currentMode === 'disabled' || (automatic && currentMode !== 'approved-auto')) return null;
  const state = { version: 1, status, checkedAt: new Date().toISOString(), capabilities };
  await saveCodexCapabilitySync(configDir, account.binding, account.profile.id, state);
  return state;
}

// A login or newly launched task may precede broker readiness, and the native
// app catalog can also fail transiently after the broker is ready. Coalesce
// repeated requests and retry incomplete discovery without blocking tasks.
export function scheduleCodexCapabilitySync(providerId, options = {}) {
  if (typeof providerId !== 'string' || !providerId.trim()) return;
  const key = `${options.configDir || CONFIG_DIR}\0${providerId}`;
  const existing = scheduled.get(key);
  if (existing) { existing.restartRequested = true; return; }
  const delays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length > 0
    && options.retryDelaysMs.every((delay) => Number.isInteger(delay) && delay >= 0 && delay <= 60_000)
    ? options.retryDelaysMs.slice(0, 20) : [0, 1_000, 2_000, 4_000, 8_000, 15_000];
  const token = { restartRequested: false };
  scheduled.set(key, token);
  const attempt = (index) => {
    const timer = setTimeout(() => {
      void refreshCodexCapabilitySync(providerId, { ...options, automatic: true }).then((state) => {
        if (scheduled.get(key) !== token) return;
        if (!state || state.status === 'discovered') scheduled.delete(key);
        else if (index + 1 < delays.length) attempt(index + 1);
        else if (token.restartRequested) { token.restartRequested = false; attempt(0); }
        else scheduled.delete(key);
      }).catch(() => { if (scheduled.get(key) === token) scheduled.delete(key); });
    }, delays[index]);
    timer.unref?.();
  };
  attempt(0);
}
