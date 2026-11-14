#!/usr/bin/env node
// Restore only the three databases produced by factory-backup into a new,
// explicitly selected directory. This is not an in-place instance restore.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = ['collaborations', 'workflow', 'coordination'];
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const ACTIVE_KEYS = ['executionBindings','runningAttempts','dispatchCommands','schedulerLeases','integrationOperations','combinationCommits','retirementOperations','organizationOperations','lifecycleOperations','nodeRebindOperations','orchestrationCommands','releaseOperations','workspaceLeases'];
const fail = message => { throw Object.assign(new Error(message), { code: 'FACTORY_RESTORE_UNAVAILABLE' }); };
function inside(root, target) {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function regular(path, root) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !inside(root, await realpath(path))) fail('Backup file is not a regular file inside the backup directory');
  return info;
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function assertNoJournal(path) {
  for (const suffix of ['-wal', '-journal']) {
    try { await lstat(`${path}${suffix}`); fail('Backup database has an unresolved SQLite journal'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
function quickCheck(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('SQLite integrity check failed');
  } finally { db.close(); }
}
async function loadBackup(source) {
  if (!isAbsolute(source || '')) fail('An absolute backup directory is required');
  const directory = await lstat(source);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Backup directory must be an existing non-symlink directory');
  const root = await realpath(source), manifestPath = join(root, 'manifest.json');
  const info = await regular(manifestPath, root);
  if (info.size > MAX_MANIFEST_BYTES) fail('Backup manifest exceeds the size limit');
  const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let manifestBytes;
  try {
    const opened=await handle.stat();
    if (opened.dev!==info.dev || opened.ino!==info.ino || opened.size!==info.size) fail('Backup manifest changed');
    const buffer=Buffer.alloc(MAX_MANIFEST_BYTES+1);let length=0;
    while(length<buffer.length) { const part=await handle.read(buffer,length,buffer.length-length,length); if(!part.bytesRead) break; length+=part.bytesRead; }
    const after=await handle.stat();
    if(length>MAX_MANIFEST_BYTES || length!==opened.size || after.size!==opened.size || after.mtimeMs!==opened.mtimeMs || after.ctimeMs!==opened.ctimeMs) fail('Backup manifest changed or exceeds the size limit');
    manifestBytes=buffer.subarray(0,length);
  } finally { await handle.close(); }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.version !== 1 || manifest.mode !== 'database_write_fenced' || !manifest.outputs || typeof manifest.outputs !== 'object') fail('Unsupported backup manifest');
  if (!manifest.schema || !manifest.watermarks || !manifest.active || !manifest.references ||
      NAMES.some(name => !manifest.schema[name] || !Number.isInteger(manifest.schema[name].userVersion) || !Array.isArray(manifest.schema[name].tables)) ||
      ACTIVE_KEYS.some(key => manifest.active[key] !== 0) ||
      ['collaborationEvents','factoryEvents','workspaceEvents'].some(key => !Object.hasOwn(manifest.watermarks,key)) ||
      ['runs','packets','releasePackages','releases'].some(key => !manifest.references[key] || !Array.isArray(manifest.references[key].items) || typeof manifest.references[key].truncated !== 'boolean')) fail('Backup snapshot declaration is incomplete or active');
  if ((manifest.schema.collaborations.tables.includes('owner_initial_organization_operations') || Object.hasOwn(manifest.active,'ownerInitialOrganizationOperations')) && manifest.active.ownerInitialOrganizationOperations !== 0) fail('Owner organization operation state is unknown or active');
  for (const [table,key] of [['remote_factory_source_operations','remoteSourceOperations'],['remote_factory_operations','remoteTargetUnknown']]) {
    if ((manifest.schema.collaborations.tables.includes(table) || Object.hasOwn(manifest.active,key)) && manifest.active[key] !== 0) fail('Remote operation state is unknown or active');
  }
  const sources = {};
  for (const name of NAMES) {
    const record = manifest.outputs[name];
    if (record?.file !== `${name}.sqlite` || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) fail('Backup database identity is missing or invalid');
    const path = join(root, record.file), before = await regular(path, root);
    await assertNoJournal(path);
    if (before.size !== record.size || await sha256(path) !== record.sha256) fail(`Backup ${name} digest or size differs from the manifest`);
    quickCheck(path);
    const after = await regular(path, root);
    await assertNoJournal(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`Backup ${name} changed during verification`);
    sources[name] = { path, size: record.size, sha256: record.sha256 };
  }
  return { root, sources, manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'), createdAt: manifest.createdAt || null };
}
export async function verifyFactoryBackup({ source } = {}) {
  const verified = await loadBackup(source);
  return { state: 'verified', sourceManifestDigest: verified.manifestDigest, backupCreatedAt: verified.createdAt,
    databases: Object.fromEntries(NAMES.map(name => [name, { size: verified.sources[name].size, sha256: verified.sources[name].sha256 }])),
    limitations: ['Matching a manifest proves file integrity, not backup authenticity.', 'SQLite read-only access may update WAL shared-memory sidecars.', 'Database files only; Run files, artifacts and external effects are not restored or proven consistent.', 'Verification does not stop a running instance or establish an atomic cross-filesystem checkpoint.'] };
}
export async function restoreFactoryBackup({ source, destination, allowedRoot } = {}) {
  const verified = await loadBackup(source);
  if (!isAbsolute(destination || '') || !isAbsolute(allowedRoot || '')) fail('Absolute destination and allowed root are required');
  const root = await realpath(allowedRoot), parent = await realpath(dirname(destination)), target = resolve(destination);
  if (!inside(root, parent) && parent !== root || !inside(root, target) || inside(verified.root, target) || inside(target, verified.root)) fail('Restore destination must be a new directory inside the allowed root and outside the backup');
  try { await lstat(target); fail('Restore destination already exists'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const volume = await statfs(parent), size = NAMES.reduce((sum, name) => sum + verified.sources[name].size, 0);
  if (Number(volume.bavail) * Number(volume.bsize) < size + 64 * 1024 * 1024) fail('Insufficient free space for isolated restore');
  await mkdir(target, { mode: 0o700 });
  const targetInfo=await lstat(target), actualTarget=await realpath(target);
  if(!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || actualTarget!==resolve(parent,basename(target)) || !inside(root,actualTarget)) fail('Restore directory identity changed');
  try {
    const outputs = {};
    for (const name of NAMES) {
      const output = join(actualTarget, `${name}.sqlite`), record = verified.sources[name];
      await copyFile(record.path, output, constants.COPYFILE_EXCL);
      const info = await regular(output, actualTarget);
      if (info.size !== record.size || await sha256(output) !== record.sha256) fail(`Restored ${name} differs from the backup`);
      quickCheck(output);
      outputs[name] = { file: `${name}.sqlite`, size: record.size, sha256: record.sha256 };
    }
    const receipt = { version: 1, state: 'restored_to_new_directory', restoredAt: new Date().toISOString(), sourceManifestDigest: verified.manifestDigest,
      backupCreatedAt: verified.createdAt, outputs, limitations: ['The restored databases are not attached to a service.', 'Run files, artifacts and external effects are not restored or proven consistent.', 'A running instance, cross-filesystem changes and same-user directory replacement are not fenced.', 'SQLite read-only access may update WAL shared-memory sidecars.'] };
    await writeFile(join(actualTarget, 'restore-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return receipt;
  } catch (error) {
    // Leave partial output visible for explicit operator inspection; do not
    // delete a directory that may have been touched by another process.
    throw error;
  }
}
async function main(argv) {
  const mode = argv[0];
  if (!['verify', 'restore'].includes(mode)) fail('Use verify or restore with explicit paths');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) fail('Arguments must be --name value pairs');
    const key = argv[i].slice(2);
    if (!['source', 'destination', 'allowed-root'].includes(key) || options[key]) fail('Unknown or duplicate option');
    options[key] = argv[i + 1];
  }
  if (mode === 'verify' && (options.destination || options['allowed-root'])) fail('Verify does not accept restore destinations');
  const result = mode === 'verify' ? await verifyFactoryBackup({ source: options.source })
    : await restoreFactoryBackup({ source: options.source, destination: options.destination, allowedRoot: options['allowed-root'] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`${error?.code || 'ERROR'}: ${error?.message || String(error)}`); process.exitCode = 1; });
}
