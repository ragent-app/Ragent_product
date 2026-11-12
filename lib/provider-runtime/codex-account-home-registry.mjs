import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';

// Account identifiers can be sensitive. Only a domain-separated digest is
// persisted; this is an identity key, not a credential or an access token.
export function codexAccountHomeKey(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (!id) throw Object.assign(new Error('A verified Codex account identity is required'), { code: 'CODEX_ACCOUNT_UNVERIFIED' });
  return createHash('sha256').update('ragent-codex-account-home-v1\0').update(id).digest('hex');
}

function managedRelativePath(managedRoot, home) {
  const root = resolve(managedRoot);
  const target = resolve(home);
  const part = relative(root, target);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw Object.assign(new Error('Codex account home is outside the managed provider root'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  }
  return part;
}

/**
 * Resolve one managed home per verified account, across provider profiles.
 * The caller must hold its legacy-home startup lock while invoking this and
 * supply a migration guard when an existing account points at another home.
 * The guard must reject if the legacy home cannot safely relinquish ownership.
 * This function never moves credentials, stops brokers, or edits old sessions.
 */
export async function resolveCanonicalCodexAccountHome({
  configDir, providerHomesRoot, candidateHomeRoot, accountId,
  initialize = false, assertMigrationSafe,
}) {
  if (![configDir, providerHomesRoot, candidateHomeRoot].every((v) => typeof v === 'string' && isAbsolute(v))) {
    throw Object.assign(new Error('Absolute managed Codex paths are required'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  }
  const key = codexAccountHomeKey(accountId);
  const candidate = managedRelativePath(providerHomesRoot, candidateHomeRoot);
  const registry = join(configDir, 'native-provider-runtime', 'codex-canonical-accounts');
  const marker = join(registry, `${key}.json`);
  const writeRecord = async (path, value) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  };
  const claimPath = (home) => {
    const relativeHome = managedRelativePath(providerHomesRoot, home);
    const identity = process.platform === 'win32' ? relativeHome.toLowerCase() : relativeHome;
    return join(registry, `home-${createHash('sha256').update(identity).digest('hex')}.json`);
  };
  const readClaim = async (home) => {
    try {
      const value = JSON.parse(await readFile(claimPath(home), 'utf8'));
      if (value?.version !== 1 || !/^[0-9a-f]{64}$/.test(value.account || '')) throw new Error('Invalid claim');
      return value.account;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw Object.assign(new Error('Invalid Codex account home ownership record'), { code: 'CODEX_ACCOUNT_HOME_INVALID', cause: error });
    }
  };
  const readMarker = async () => {
    let value;
    try { value = JSON.parse(await readFile(marker, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (value?.version !== 1 || typeof value.home !== 'string' || !value.home || isAbsolute(value.home)) {
      throw Object.assign(new Error('Invalid Codex account home record'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    const home = resolve(providerHomesRoot, value.home);
    if (managedRelativePath(providerHomesRoot, home) !== value.home) {
      throw Object.assign(new Error('Invalid Codex account home record'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    if (await readClaim(home) !== key) {
      throw Object.assign(new Error('Codex account home ownership does not match'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    return home;
  };
  if (!initialize) return readMarker();
  await mkdir(registry, { recursive: true, mode: 0o770 });
  // A global registry lock also serializes different accounts trying to claim
  // the same legacy home. Per-account locks would allow both claims to win.
  const lock = await acquireNativeOAuthLock(join(registry, 'registry.lock'));
  try {
    let canonical = await readMarker();
    if (!canonical) {
      const owner = await readClaim(candidateHomeRoot);
      if (owner && owner !== key) {
        throw Object.assign(new Error('Codex home is already bound to another account'), { code: 'CODEX_ACCOUNT_HOME_OWNED' });
      }
      if (!owner) await writeRecord(claimPath(candidateHomeRoot), { version: 1, account: key });
      await writeRecord(marker, { version: 1, home: candidate });
      canonical = resolve(candidateHomeRoot);
    }
    if (canonical !== resolve(candidateHomeRoot)) {
      if (typeof assertMigrationSafe !== 'function') {
        throw Object.assign(new Error('Codex account home migration requires an ownership guard'), { code: 'CODEX_ACCOUNT_HOME_MIGRATION_REQUIRED' });
      }
      await assertMigrationSafe({ canonicalHomeRoot: canonical, legacyHomeRoot: resolve(candidateHomeRoot) });
    }
    return canonical;
  } finally {
    await lock.release();
  }
}
