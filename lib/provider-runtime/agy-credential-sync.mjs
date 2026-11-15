// Persist a refreshed AgY OAuth token from a completed Run.
//
// AgY refreshes its opaque credential file inside the Run HOME.  The runner
// must not write the control-plane SecretStore directly, so the server-side
// Run observer performs this reconciliation after the provider exits.  The
// Run's .ragent-oauth-state.json is the compare-and-swap generation captured
// before spawn; a later login or another Run wins over a stale writer.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AGY_AUTH_RELATIVE_PATH } from '../agy-runtime.mjs';
import { createCredentialMutationLedger } from './credential-mutation.mjs';

const AGY_OAUTH_STATE_FILE = '.ragent-oauth-state.json';
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 60_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function agyTokenFingerprint(tokenFile) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({ tokenFile: String(tokenFile || '') })))
    .digest('hex')
    .slice(0, 16);
}

function providerHomeKey(providerId) {
  return createHash('sha256').update(`agy:${providerId}`).digest('hex').slice(0, 32);
}

function runHomeKey(runId) {
  return createHash('sha256').update(String(runId || '')).digest('hex').slice(0, 32);
}

export function resolveAgyRunHome(providerHomesRoot, providerId, runId) {
  return join(
    providerHomesRoot,
    'by-provider',
    providerHomeKey(providerId),
    'by-run',
    runHomeKey(runId),
    'agy',
  );
}

async function readJson(path, readFileImpl) {
  try {
    return JSON.parse(await readFileImpl(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquireLock(lockPath, {
  mkdirImpl = mkdir,
  openImpl = open,
  statImpl = stat,
  rmImpl = rm,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = () => Date.now(),
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
  staleMs = DEFAULT_STALE_LOCK_MS,
} = {}) {
  await mkdirImpl(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = nowImpl() + timeoutMs;
  while (nowImpl() <= deadline) {
    try {
      const handle = await openImpl(lockPath, 'wx', 0o600);
      return {
        ok: true,
        release: async () => {
          await handle.close().catch(() => {});
          await rmImpl(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: 'lock-create-failed' };
      try {
        const lockStat = await statImpl(lockPath);
        if (nowImpl() - lockStat.mtimeMs > staleMs) {
          await rmImpl(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') return { ok: false, reason: 'lock-inspect-failed' };
      }
      await sleepImpl(pollMs);
    }
  }
  return { ok: false, reason: 'agy-refresh-lock-timeout' };
}

function requestedAgyProviderId(run, manifest) {
  return trimString(
    run?.agyProviderProfileId
      || run?.providerProfile
      || manifest?.options?.providerProfile,
  );
}

function isAgyRun(run, manifest) {
  const tool = trimString(run?.tool || manifest?.tool).toLowerCase();
  const family = trimString(run?.runtimeFamily || manifest?.options?.runtimeFamily || manifest?.runtimeFamily).toLowerCase();
  return tool === 'agy' || family === 'agy-json' || family === 'agy-stream-json';
}

function credentialIdentity(provider, authProfile) {
  const metadata = authProfile?.accountMetadata && typeof authProfile.accountMetadata === 'object'
    ? authProfile.accountMetadata
    : {};
  const accountId = trimString(metadata.accountId);
  const accountKey = trimString(metadata.accountKey)
    || (accountId ? `account:agy:${accountId}` : '')
    || `provider:agy:${trimString(provider?.syncId || provider?.id)}`;
  const credentialInstanceId = trimString(metadata.credentialInstanceId)
    || `instance-${createHash('sha256')
      .update(`${accountKey}:${trimString(authProfile?.storageRef)}`)
      .digest('hex')
      .slice(0, 32)}`;
  return { accountKey, credentialInstanceId };
}

async function restoreOAuthSecret(secretStore, storageRef, previous) {
  if (previous?.ok && previous.authType === 'oauth') {
    await secretStore.writeSecret(storageRef, {
      authType: 'oauth',
      tokens: previous.tokens,
    });
    return;
  }
  await secretStore.deleteSecret(storageRef);
}

function authProfileWithCredentialMetadata(authProfile, identity, record) {
  const metadata = authProfile?.accountMetadata && typeof authProfile.accountMetadata === 'object'
    ? authProfile.accountMetadata
    : {};
  return {
    ...authProfile,
    accountMetadata: {
      ...metadata,
      accountKey: identity.accountKey,
      credentialInstanceId: record.credentialInstanceId,
      credentialVersion: record.credentialVersion,
    },
  };
}

function result(status, extra = {}) {
  return { ok: status === 'synced' || status === 'unchanged', status, ...extra };
}

// Reconcile one terminal AgY Run.  This function intentionally returns only
// fingerprints and reason codes; neither token contents nor SecretStore paths
// are suitable for run status, diagnostics, or UI payloads.
export async function reconcileAgyRunCredential({
  run,
  manifest = null,
  configDir,
  providerHomesRoot,
  runHomeDir = '',
  registry,
  secretStore,
  credentialLedger = null,
  sourceInstanceId = '',
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  openImpl = open,
  statImpl = stat,
  rmImpl = rm,
  sleepImpl,
  nowImpl,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockPollMs = DEFAULT_LOCK_POLL_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
} = {}) {
  if (!isAgyRun(run, manifest)) return result('not-applicable');
  const providerId = requestedAgyProviderId(run, manifest);
  if (!providerId) return result('not-applicable', { reason: 'provider-not-selected' });
  if (!configDir || !providerHomesRoot || !registry || !secretStore || !credentialLedger) {
    return result('failed', { reason: 'reconcile-dependencies-missing' });
  }

  const provider = await registry.getProviderProfile(providerId).catch(() => null);
  if (!provider || provider.agentType !== 'agy') return result('not-applicable', { reason: 'provider-not-found' });
  const authProfile = await registry.getAuthProfile(provider.authProfileId).catch(() => null);
  if (!authProfile || authProfile.agentType !== 'agy' || authProfile.authType !== 'oauth') {
    return result('not-applicable', { reason: 'oauth-profile-not-found' });
  }
  const identity = credentialIdentity(provider, authProfile);
  const currentCredential = await credentialLedger.getRecord(identity.accountKey).catch(() => null);
  if (currentCredential?.deletedAt) {
    return result('conflict', { reason: 'agy-refresh-tombstoned' });
  }
  const expectedVersion = currentCredential?.credentialVersion || 0;
  const credentialInstanceId = currentCredential?.credentialInstanceId || identity.credentialInstanceId;
  const resolvedHome = trimString(runHomeDir) || resolveAgyRunHome(providerHomesRoot, providerId, run?.id);
  const authFile = join(resolvedHome, AGY_AUTH_RELATIVE_PATH);
  const state = await readJson(join(resolvedHome, AGY_OAUTH_STATE_FILE), readFileImpl);
  const sourceFingerprint = trimString(state?.sourceFingerprint);
  if (!sourceFingerprint) return result('failed', { reason: 'agy-refresh-source-generation-missing' });
  let tokenFile;
  try {
    tokenFile = await readFileImpl(authFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return result('unchanged', { reason: 'agy-auth-file-missing' });
    return result('failed', { reason: 'agy-auth-file-read-failed' });
  }
  if (!trimString(tokenFile)) return result('unchanged', { reason: 'agy-auth-file-empty' });
  const runtimeFingerprint = agyTokenFingerprint(tokenFile);
  if (runtimeFingerprint === sourceFingerprint) {
    return result('unchanged', { fingerprint: runtimeFingerprint });
  }

  const currentBeforeLock = await secretStore.resolveSecret(authProfile.storageRef);
  if (!currentBeforeLock?.ok || currentBeforeLock.authType !== 'oauth') {
    return result('failed', { reason: 'agy-secret-read-failed' });
  }
  const currentFingerprint = agyTokenFingerprint(currentBeforeLock.tokens?.tokenFile);
  if (currentFingerprint === runtimeFingerprint) {
    return result('unchanged', { fingerprint: runtimeFingerprint });
  }

  const lockPath = join(configDir, 'native-provider-runtime', 'locks', `${authProfile.storageRef}.agy-refresh.lock`);
  const lock = await acquireLock(lockPath, {
    mkdirImpl,
    openImpl,
    statImpl,
    rmImpl,
    ...(sleepImpl ? { sleepImpl } : {}),
    ...(nowImpl ? { nowImpl } : {}),
    timeoutMs: lockTimeoutMs,
    pollMs: lockPollMs,
    staleMs: staleLockMs,
  });
  if (!lock.ok) return result('failed', { reason: lock.reason });
  try {
    const current = await secretStore.resolveSecret(authProfile.storageRef);
    if (!current?.ok || current.authType !== 'oauth') {
      return result('failed', { reason: 'agy-secret-read-failed' });
    }
    const currentGeneration = agyTokenFingerprint(current.tokens?.tokenFile);
    if (currentGeneration === runtimeFingerprint) {
      return result('unchanged', { fingerprint: runtimeFingerprint });
    }
    if (currentGeneration !== sourceFingerprint) {
      return result('conflict', {
        reason: 'agy-refresh-conflict',
        sourceFingerprint,
        currentFingerprint: currentGeneration,
        runtimeFingerprint,
      });
    }
    const previousSecret = await secretStore.resolveSecret(authProfile.storageRef).catch(() => null);
    const previousAuthProfile = {
      ...authProfile,
      ...(authProfile.accountMetadata && typeof authProfile.accountMetadata === 'object'
        ? { accountMetadata: { ...authProfile.accountMetadata } }
        : {}),
    };
    const mutation = await credentialLedger.submit({
      accountKey: identity.accountKey,
      credentialInstanceId,
      expectedVersion,
      secretPayload: {
        authType: 'oauth',
        tokens: { tokenFile },
      },
      secretRef: authProfile.storageRef,
      sourceDeviceId: sourceInstanceId,
    }, {
      apply: async ({ record }) => {
        const written = await secretStore.writeSecret(authProfile.storageRef, {
          authType: 'oauth',
          tokens: { tokenFile },
        });
        if (!written?.ok) throw new Error('agy-secret-write-failed');
        const readback = await secretStore.resolveSecret(authProfile.storageRef);
        if (!readback?.ok || readback.authType !== 'oauth') {
          throw new Error('agy-secret-readback-failed');
        }
        const readbackFingerprint = agyTokenFingerprint(readback.tokens?.tokenFile);
        if (readbackFingerprint !== runtimeFingerprint) {
          throw new Error('agy-secret-readback-mismatch');
        }
        const authResult = await registry.upsertAuthProfile(
          authProfileWithCredentialMetadata(authProfile, identity, record),
        );
        if (!authResult?.ok) throw new Error('agy-auth-metadata-write-failed');
      },
      rollback: async () => {
        await restoreOAuthSecret(secretStore, authProfile.storageRef, previousSecret);
        await registry.upsertAuthProfile(previousAuthProfile).catch(() => {});
      },
    });
    if (mutation.status === 'conflict' || mutation.status === 'account-mismatch') {
      return result('conflict', { reason: 'agy-refresh-conflict' });
    }
    if (mutation.status === 'tombstoned') {
      return result('conflict', { reason: 'agy-refresh-tombstoned' });
    }
    if (mutation.status !== 'accepted') {
      return result('failed', { reason: 'agy-refresh-cas-failed' });
    }
    return result('synced', {
      fingerprint: runtimeFingerprint,
      credentialVersion: mutation.record.credentialVersion,
    });
  } finally {
    await lock.release();
  }
}
