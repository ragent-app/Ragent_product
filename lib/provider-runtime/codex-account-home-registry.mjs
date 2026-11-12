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

function pathIdentity(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
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
  initialize = false, assertMigrationSafe, includeSources = false,
}) {
  if (![configDir, providerHomesRoot, candidateHomeRoot].every((v) => typeof v === 'string' && isAbsolute(v))) {
    throw Object.assign(new Error('Absolute managed Codex paths are required'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  }
  const key = codexAccountHomeKey(accountId);
  const candidate = managedRelativePath(providerHomesRoot, candidateHomeRoot);
  const resolvedRoot = resolve(providerHomesRoot);
  const normalizedRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const rootKey = createHash('sha256').update(normalizedRoot).digest('hex');
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
    const identity = pathIdentity(relativeHome);
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
    if (value?.version !== 1 || value.root !== rootKey || typeof value.home !== 'string' || !value.home || isAbsolute(value.home)) {
      throw Object.assign(new Error('Invalid Codex account home record'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    const home = resolve(providerHomesRoot, value.home);
    if (managedRelativePath(providerHomesRoot, home) !== value.home) {
      throw Object.assign(new Error('Invalid Codex account home record'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    if (await readClaim(home) !== key) {
      throw Object.assign(new Error('Codex account home ownership does not match'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    if (value.sources !== undefined && !Array.isArray(value.sources)) {
      throw Object.assign(new Error('Invalid Codex account rollout sources'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
    }
    const sources = [];
    for (const source of value.sources || []) {
      if (typeof source !== 'string' || !source || isAbsolute(source)) {
        throw Object.assign(new Error('Invalid Codex account rollout source'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
      }
      const sourceHome = resolve(providerHomesRoot, source);
      if (managedRelativePath(providerHomesRoot, sourceHome) !== source || await readClaim(sourceHome) !== key) {
        throw Object.assign(new Error('Codex rollout source ownership does not match'), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
      }
      sources.push(sourceHome);
    }
    return { home, sources, relativeHome: value.home, relativeSources: value.sources || [] };
  };
  if (!initialize) {
    const record = await readMarker();
    return includeSources && record ? { home: record.home, sources: record.sources } : record?.home || null;
  }
  await mkdir(registry, { recursive: true, mode: 0o770 });
  // A global registry lock also serializes different accounts trying to claim
  // the same legacy home. Per-account locks would allow both claims to win.
  const lock = await acquireNativeOAuthLock(join(registry, 'registry.lock'));
  try {
    let record = await readMarker();
    if (!record) {
      const owner = await readClaim(candidateHomeRoot);
      if (owner && owner !== key) {
        throw Object.assign(new Error('Codex home is already bound to another account'), { code: 'CODEX_ACCOUNT_HOME_OWNED' });
      }
      if (!owner) await writeRecord(claimPath(candidateHomeRoot), { version: 1, account: key });
      await writeRecord(marker, { version: 1, root: rootKey, home: candidate });
      record = { home: resolve(candidateHomeRoot), sources: [], relativeHome: candidate, relativeSources: [] };
    }
    if (pathIdentity(record.home) !== pathIdentity(resolve(candidateHomeRoot))) {
      if (typeof assertMigrationSafe !== 'function') {
        throw Object.assign(new Error('Codex account home migration requires an ownership guard'), { code: 'CODEX_ACCOUNT_HOME_MIGRATION_REQUIRED' });
      }
      const owner = await readClaim(candidateHomeRoot);
      if (owner && owner !== key) {
        throw Object.assign(new Error('Codex home is already bound to another account'), { code: 'CODEX_ACCOUNT_HOME_OWNED' });
      }
      await assertMigrationSafe({ canonicalHomeRoot: record.home, legacyHomeRoot: resolve(candidateHomeRoot) });
      if (!owner) await writeRecord(claimPath(candidateHomeRoot), { version: 1, account: key });
      if (!record.relativeSources.some((source) => pathIdentity(source) === pathIdentity(candidate))) {
        record.relativeSources.push(candidate);
        record.sources.push(resolve(candidateHomeRoot));
        await writeRecord(marker, { version: 1, root: rootKey, home: record.relativeHome, sources: record.relativeSources });
      }
    }
    return includeSources ? { home: record.home, sources: record.sources } : record.home;
  } finally {
    await lock.release();
  }
}
