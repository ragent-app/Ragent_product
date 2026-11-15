// Explicit operator repair for all-zero legacy ledger files. Never called by
// normal reads. Rebuild only present local profiles, fence peer history, and
// preserve the damaged originals. Stop the control plane before --apply.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const damagedNames = ['credential-ledger.json', 'provider-sync-ledger.json'];

export async function repairProviderLedgers({ configDir, runtimeRoot, backupDir, expectedFiles, writerId = 'local-ledger-recovery', apply = false }) {
  if (![configDir, runtimeRoot, backupDir].every(isAbsolute)) throw new Error('Repair requires absolute paths');
  if (!Array.isArray(expectedFiles) || expectedFiles.length < 4) throw new Error('Expected file digest manifest is required');
  const directory = join(configDir, 'native-provider-runtime');
  const snapshot = new Map();
  for (const file of expectedFiles) {
    if (!/^(?:providers|auth-profiles|credential-ledger|provider-sync-ledger)\.json$|^secrets\/[A-Za-z0-9._-]+\.json$/.test(file.path)) throw new Error('Unexpected repair input path');
    const bytes = await readFile(join(directory, file.path));
    if (hash(bytes) !== file.sha256) throw new Error('Provider data changed since repair preflight');
    snapshot.set(file.path, bytes);
  }
  for (const name of damagedNames) {
    const bytes = snapshot.get(name);
    if (!bytes?.length || !bytes.every(byte => byte === 0)) throw new Error('This repair is restricted to verified all-zero ledgers');
  }
  const json = name => {
    try { return JSON.parse(snapshot.get(name).toString('utf8')); }
    catch { throw new Error(`Repair input ${name} is not valid JSON`); }
  };
  const providers = json('providers.json').profiles;
  const authProfiles = json('auth-profiles.json').profiles;
  if (!Array.isArray(providers) || !Array.isArray(authProfiles)) throw new Error('Provider registry schema is invalid');
  const { credentialSecretFingerprint } = await import(pathToFileURL(join(runtimeRoot, 'lib/provider-runtime/credential-mutation.mjs')).href);
  const credentials = [];
  const records = [];
  for (const provider of providers) {
    const auth = authProfiles.find(value => value.id === provider.authProfileId);
    const metadata = auth?.accountMetadata;
    if (!auth || !metadata?.accountKey || !metadata?.credentialInstanceId || !Number.isSafeInteger(metadata.credentialVersion) || metadata.credentialVersion < 0) {
      throw new Error('Current Provider lacks verified credential identity/version metadata; manual reconciliation is required');
    }
    const secret = json(`secrets/${auth.storageRef}.json`);
    if (secret.authType !== auth.authType) throw new Error('Current credential type does not match its profile');
    const updatedAt = auth.updatedAt || provider.updatedAt;
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Current Provider has no valid update timestamp');
    if (credentials.some(record => record.key === metadata.accountKey)) throw new Error('Duplicate local account identity requires manual reconciliation');
    credentials.push({
      scope: 'provider-credential', key: metadata.accountKey,
      credentialInstanceId: metadata.credentialInstanceId,
      credentialVersion: metadata.credentialVersion,
      secretRef: auth.storageRef, credentialFingerprint: credentialSecretFingerprint(secret),
      updatedAt, updatedByDeviceId: writerId,
      version: { updatedAt, counter: metadata.credentialVersion, writerId },
    });
    records.push({ key: provider.syncId || provider.id, version: { updatedAt: provider.updatedAt || updatedAt, counter: 0, writerId } });
  }
  const proposed = {
    'credential-ledger.json': { version: 1, recoveryRequired: true, credentials },
    'provider-sync-ledger.json': { version: 1, recoveryRequired: true, counter: Math.max(0, ...credentials.map(record => record.credentialVersion)), records },
  };
  const report = {
    mode: apply ? 'apply' : 'dry-run', localProviderCount: providers.length,
    credentialRecordCount: credentials.length, recoveryRequired: true,
    peerSyncPaused: true, credentialsChanged: false,
    before: damagedNames.map(path => ({ path, sha256: hash(snapshot.get(path)) })),
    after: damagedNames.map(path => ({ path, sha256: hash(Buffer.from(JSON.stringify(proposed[path], null, 2) + '\n')) })),
  };
  if (!apply) return report;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const name of damagedNames) {
    await copyFile(join(directory, name), join(backupDir, name), constants.COPYFILE_EXCL);
    if (hash(await readFile(join(backupDir, name))) !== hash(snapshot.get(name))) throw new Error('Damaged ledger evidence copy did not match');
  }
  // Recheck every authority input immediately before writing any repaired data.
  for (const file of expectedFiles) if (hash(await readFile(join(directory, file.path))) !== file.sha256) throw new Error('Provider data changed during repair');
  for (const name of [...damagedNames].reverse()) {
    const target = join(directory, name); const temporary = `${target}.recovery.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(proposed[name], null, 2) + '\n', { mode: 0o600, flush: true });
    await rename(temporary, target);
  }
  await writeFile(join(backupDir, 'repair-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flush: true });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];
  const configDir = resolve(value('--config-dir'));
  process.env.RAGENT_CONFIG_DIR = configDir;
  process.env.RAGENT_INSTANCE_ROOT = dirname(configDir);
  const expectedFiles = JSON.parse(await readFile(value('--expected-manifest'), 'utf8'));
  const report = await repairProviderLedgers({ configDir, runtimeRoot: resolve(value('--runtime-root')), backupDir: resolve(value('--backup-dir')), expectedFiles, apply: args.includes('--apply') });
  console.log(JSON.stringify(report, null, 2));
}
