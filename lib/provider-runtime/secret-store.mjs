// Credential vault for the native provider runtime.
//
// Secrets live ONLY here — never in ProviderProfile rows, never in run
// manifests, never in logs.  Each secret is one 0600 JSON file under
// native-provider-runtime/secrets/<ref>.json, referenced by AuthProfile
// .storageRef.  resolve() hands the secret to the caller at spawn time; the
// caller injects it into the child process env / runtime home and drops it.
//
// On Linux with OS keyring/secret-service available this could be backed by
// the platform store; the file vault is the portable baseline the deb ships
// with and matches the permission model of the existing managed provider
// homes (0600 control-plane, 0640 runner-readable via explicit chmod).
//
// Side-effect free on import: root-owned brokers may import this module.

import { createHash } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export function normalizeSecretRef(ref) {
  const normalized = String(ref || '').trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(normalized) ? normalized : '';
}

// A short, loggable fingerprint: never the secret, never a reversible prefix.
export function fingerprintSecretValue(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
}

export function createSecretStore({
  configDir,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
  rmImpl = rm,
  chmodImpl = chmod,
} = {}) {
  const secretsDir = join(configDir, 'native-provider-runtime', 'secrets');

  async function ensureSecretsDir() {
    await mkdirImpl(secretsDir, { recursive: true, mode: 0o700 });
  }

  function secretPath(ref) {
    return join(secretsDir, `${ref}.json`);
  }

  // payload shapes:
  //   api-key:  { authType: 'api-key', apiKey: string }
  //   oauth:    { authType: 'oauth', tokens: { access_token, refresh_token?, ... } }
  //   oauth-token: { authType: 'oauth-token', token: string }
  //   AgY OAuth: { authType: 'oauth', tokens: { tokenFile: '<opaque CLI payload>' } }
  async function writeSecret(ref, payload) {
    const normalizedRef = normalizeSecretRef(ref);
    if (!normalizedRef) return { ok: false, reason: 'invalid-ref' };
    const authType = String(payload?.authType || '').trim();
    if (!['api-key', 'oauth', 'oauth-token'].includes(authType)) return { ok: false, reason: 'invalid-auth-type' };
    if (authType === 'api-key' && typeof payload.apiKey !== 'string') {
      return { ok: false, reason: 'missing-api-key' };
    }
    if (authType === 'oauth' && (!payload.tokens || typeof payload.tokens !== 'object')) {
      return { ok: false, reason: 'missing-tokens' };
    }
    if (authType === 'oauth-token' && typeof payload.token !== 'string') {
      return { ok: false, reason: 'missing-oauth-token' };
    }
    await ensureSecretsDir();
    const target = secretPath(normalizedRef);
    const temp = `${target}.${process.pid}.tmp`;
    const body = authType === 'api-key'
      ? { authType, apiKey: payload.apiKey }
      : authType === 'oauth-token'
        ? { authType, token: payload.token }
        : { authType, tokens: payload.tokens };
    await writeFileImpl(temp, JSON.stringify(body) + '\n', { mode: 0o600, flush: true });
    await chmodImpl(temp, 0o600).catch(() => {});
    await renameImpl(temp, target);
    return { ok: true, ref: normalizedRef };
  }

  // Spawn-time resolution.  Returns the raw credential payload for the caller
  // to inject; the caller must not persist it.
  async function resolveSecret(ref) {
    const normalizedRef = normalizeSecretRef(ref);
    if (!normalizedRef) return { ok: false, reason: 'invalid-ref' };
    try {
      const text = await readFileImpl(secretPath(normalizedRef), 'utf8');
      const parsed = JSON.parse(text);
      if (parsed?.authType === 'api-key' && typeof parsed.apiKey === 'string') {
        return { ok: true, authType: 'api-key', apiKey: parsed.apiKey };
      }
      if (parsed?.authType === 'oauth' && parsed.tokens && typeof parsed.tokens === 'object') {
        return { ok: true, authType: 'oauth', tokens: parsed.tokens };
      }
      if (parsed?.authType === 'oauth-token' && typeof parsed.token === 'string') {
        return { ok: true, authType: 'oauth-token', token: parsed.token };
      }
      return { ok: false, reason: 'malformed-secret' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, reason: 'not-found' };
      return { ok: false, reason: 'read-failed', error: error?.message };
    }
  }

  async function deleteSecret(ref) {
    const normalizedRef = normalizeSecretRef(ref);
    if (!normalizedRef) return { ok: false, reason: 'invalid-ref' };
    try {
      await rmImpl(secretPath(normalizedRef), { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'delete-failed', error: error?.message };
    }
  }

  // Metadata for status/UI: exists + fingerprint only, never the value.
  async function describeSecret(ref) {
    const resolved = await resolveSecret(ref);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (resolved.authType === 'api-key') {
      return { ok: true, authType: 'api-key', fingerprint: fingerprintSecretValue(resolved.apiKey) };
    }
    if (resolved.authType === 'oauth-token') {
      return {
        ok: true,
        authType: 'oauth-token',
        fingerprint: fingerprintSecretValue(resolved.token),
        hasRefreshToken: false,
        hasLongLivedToken: true,
      };
    }
    return {
      ok: true,
      authType: 'oauth',
      fingerprint: fingerprintSecretValue(
        resolved.tokens?.access_token
          || resolved.tokens?.accessToken
          || resolved.tokens?.tokenFile
          || '',
      ),
      hasRefreshToken: Boolean(resolved.tokens?.refresh_token || resolved.tokens?.refreshToken),
      hasLongLivedToken: false,
    };
  }

  return {
    writeSecret,
    resolveSecret,
    deleteSecret,
    describeSecret,
  };
}
