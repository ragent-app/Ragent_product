#!/usr/bin/env node
// Factory database backup. No Run logs, project files, credentials or
// artifacts are copied. Three SQLite write locks fence database writers only;
// they do not prove the service stopped or freeze external side effects.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = ['collaborations', 'workflow', 'coordination'];
const LIMIT = 5000;
function fail(message, code = 'FACTORY_BACKUP_UNAVAILABLE') { throw Object.assign(new Error(message), { code }); }
function contained(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function regularFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('Each source database must be an absolute path');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Source databases must be existing regular files');
  return { path: await realpath(path), size: stat.size };
}
function openRead(path) { return new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
function hasTable(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function count(db, table, condition = '1', values = [], optional = false) {
  return hasTable(db, table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`).get(...values).n) : (optional ? 0 : null);
}
function rows(db, table, sql, condition = '1') {
  if (!hasTable(db, table)) return { total: null, items: [], truncated: false };
  const total = count(db, table, condition), items = db.prepare(`${sql} LIMIT ${LIMIT}`).all();
  return { total, items, truncated: total > items.length };
}
function inspect(databases) {
  const c = databases.collaborations, w = databases.workflow, r = databases.coordination;
  const active = {
    executionBindings: count(c, 'factory_execution_bindings', "status IN ('intent','running','unknown')", [], true),
    runningAttempts: count(c, 'collaboration_attempts', "state='running' OR failure_kind='unknown_outcome'"),
    dispatchCommands: count(c, 'collaboration_dispatch_commands', "state IN ('pending','claimed')"),
    schedulerLeases: count(c, 'factory_scheduler_leases', 'expires_at > ?', [new Date().toISOString()], true),
    integrationOperations: count(c, 'factory_integration_operations', "state IN ('intent','applying','applied_unverified','workspace_applied_verified','committing','commit_verified')", [], true),
    organizationOperations: count(c, 'organization_operations', "state NOT IN ('completed','failed_terminal')", [], true),
    lifecycleOperations: count(c, 'organization_lifecycle_operations', "state='pending'", [], true),
    nodeRebindOperations: count(c, 'organization_node_rebind_operations', "state='pending'", [], true),
    orchestrationCommands: count(c, 'orchestration_commands', "state IN ('pending','deferred','claimed','acknowledged')", [], true),
    releaseOperations: count(c, 'factory_release_operations', "state NOT IN ('completed','failed_terminal','cancelled','unsupported')", [], true),
    workspaceLeases: count(r, 'workspace_leases', "state IN ('preparing','active','quarantined')"),
  };
  const schema = Object.fromEntries(NAMES.map((name) => [name, {
    userVersion: Number(databases[name].prepare('PRAGMA user_version').get().user_version),
    tables: databases[name].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
  }]));
  const watermarks = {
    collaborationEvents: hasTable(c, 'collaboration_events') ? Number(c.prepare('SELECT COALESCE(MAX(id),0) AS n FROM collaboration_events').get().n) : null,
    factoryEvents: hasTable(c, 'factory_events') ? Number(c.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM factory_events').get().n) : null,
    workspaceEvents: hasTable(r, 'workspace_lease_events') ? Number(r.prepare('SELECT COALESCE(MAX(id),0) AS n FROM workspace_lease_events').get().n) : null,
  };
  const references = {
    runs: rows(c, 'collaboration_attempts', "SELECT id,task_id,run_id,result_packet_id,state FROM collaboration_attempts WHERE run_id IS NOT NULL ORDER BY id", 'run_id IS NOT NULL'),
    candidates: rows(c, 'factory_candidates', 'SELECT id,work_item_id,contract_revision,execution_epoch,binding_generation,digest FROM factory_candidates ORDER BY id'),
    packets: rows(w, 'result_packets', 'SELECT packet_id,run_id,digest FROM result_packets ORDER BY packet_id'),
  };
  return { schema, watermarks, active, references,
    optionalOperationTables: Object.fromEntries(['organization_lifecycle_operations', 'organization_node_rebind_operations']
      .map((name) => [name, hasTable(c, name) ? 'available' : 'absent_legacy_or_not_initialized'])) };
}
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function sourceFiles(sources) {
  const list = {};
  for (const name of NAMES) list[name] = await regularFile(sources?.[name]);
  if (new Set(NAMES.map((name) => list[name].path)).size !== NAMES.length) fail('Source databases must be distinct');
  return list;
}
function assertKnownQuiescence(report) {
  for (const [name, value] of Object.entries(report.active)) {
    if (value === null) fail(`Cannot verify ${name}: required table is missing`);
    if (value !== 0) fail(`Cannot back up while ${name} is active or unknown`);
  }
  if (report.references.packets.total === null) fail('Workflow ResultPacket store is unavailable');
}
export async function inventoryFactoryBackup({ sources } = {}) {
  const files = await sourceFiles(sources), databases = {};
  try {
    for (const name of NAMES) databases[name] = openRead(files[name].path);
    return { mode: 'inventory', copiesCreated: false, guarantee: 'observational_only',
      limitations: ['SQLite may create or update source WAL shared-memory sidecars even for read-only connections.'],
      sourceSizes: Object.fromEntries(NAMES.map((name) => [name, files[name].size])), ...inspect(databases) };
  } finally { for (const db of Object.values(databases)) db.close(); }
}

export async function createFactoryBackup({ sources, destination, allowedRoot } = {}) {
  const files = await sourceFiles(sources);
  if (!isAbsolute(destination || '') || !isAbsolute(allowedRoot || '')) fail('Absolute destination and allowed root are required');
  const root = await realpath(allowedRoot), parent = await realpath(dirname(destination)), target = resolve(destination);
  if (!contained(root, parent) || !contained(root, target) || target === root) fail('Backup destination must be a new directory inside the allowed root');
  if (process.platform === 'win32' && !contained('G:\\AgentoC', root)) fail('Windows AgentoC backups must be under G:\\AgentoC');
  if (await lstat(target).then(() => true, () => false)) fail('Backup destination already exists');
  let sourceBytes = 0;
  for (const name of NAMES) {
    sourceBytes += files[name].size;
    const wal = await lstat(`${files[name].path}-wal`).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (wal) sourceBytes += wal.size;
  }
  const volume = await statfs(parent);
  if (Number(volume.bavail) * Number(volume.bsize) < sourceBytes * 2 + 64 * 1024 * 1024) fail('Insufficient free space for database backup and journal headroom');
  await mkdir(target, { mode: 0o700 });
  const locks = {}, readers = {}, created = [];
  try {
    // Fixed ordering prevents two copies of this tool deadlocking each other.
    for (const name of NAMES) {
      locks[name] = new DatabaseSync(files[name].path, { timeout: 1000 });
      locks[name].exec('BEGIN IMMEDIATE');
    }
    const report = inspect(locks);
    assertKnownQuiescence(report);
    for (const name of NAMES) {
      readers[name] = openRead(files[name].path);
      const output = join(target, `${name}.sqlite`);
      created.push(output);
      await backup(readers[name], output);
    }
    const outputs = {};
    for (const name of NAMES) {
      const path = join(target, `${name}.sqlite`), db = openRead(path);
      try {
        const check = db.prepare('PRAGMA quick_check').get();
        if (Object.values(check)[0] !== 'ok') fail(`SQLite backup verification failed for ${name}`);
      } finally { db.close(); }
      outputs[name] = { file: `${name}.sqlite`, size: (await lstat(path)).size, sha256: await digestFile(path) };
    }
    const manifest = { version: 1, mode: 'database_write_fenced', createdAt: new Date().toISOString(), outputs, ...report,
      limitations: ['Database write locks do not prove the instance or broker is stopped.',
        'Run files, artifacts, external services and filesystem effects are references only and are not included in the atomicity guarantee.',
        'No independently verified full-instance or cross-filesystem checkpoint is claimed.'] };
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) {
    for (const path of created) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${path}${suffix}`, { force: true }).catch(() => {});
    }
    await rm(join(target, 'manifest.json'), { force: true }).catch(() => {});
    await writeFile(join(target, 'failure.json'), JSON.stringify({ version: 1, state: 'failed', code: error?.code || 'ERROR',
      message: String(error?.message || error).slice(0, 500), createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    for (const db of Object.values(readers)) db.close();
    for (const name of [...NAMES].reverse()) {
      if (!locks[name]) continue;
      try { locks[name].exec('ROLLBACK'); } catch {}
      locks[name].close();
    }
  }
}

async function main(argv) {
  const mode = argv[0];
  if (!['inventory', 'backup'].includes(mode)) fail('Use inventory or backup with explicit source paths');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) fail('Arguments must be --name value pairs');
    const key = argv[i].slice(2);
    if (!['collaborations', 'workflow', 'coordination', 'destination', 'allowed-root'].includes(key) || options[key]) fail('Unknown or duplicate option');
    options[key] = argv[i + 1];
  }
  const sources = Object.fromEntries(NAMES.map((name) => [name, options[name]]));
  const result = mode === 'inventory' ? await inventoryFactoryBackup({ sources })
    : await createFactoryBackup({ sources, destination: options.destination, allowedRoot: options['allowed-root'] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`${error?.code || 'ERROR'}: ${error?.message || String(error)}`); process.exitCode = 1; });
}
