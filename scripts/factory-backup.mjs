#!/usr/bin/env node
// Factory database backup. No Run logs, project files, credentials or
// artifacts are copied. Three SQLite write locks fence database writers only;
// they do not prove the service stopped or freeze external side effects.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRunPublication } from '../chat/run-publication-contract.mjs';

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
function hasTable(db, table) { return Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function count(db, table, condition = '1', values = [], optional = false) {
  if (!db) return null;
  return hasTable(db, table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`).get(...values).n) : (optional ? 0 : null);
}
function rows(db, table, sql, condition = '1') {
  if (!db) return { total: null, items: [], truncated: false, status: 'source_unavailable' };
  if (!hasTable(db, table)) return { total: null, items: [], truncated: false, status: 'absent_legacy_or_not_initialized' };
  const total = count(db, table, condition), items = db.prepare(`${sql} LIMIT ${LIMIT}`).all();
  return { total, items, truncated: total > items.length, status: 'available' };
}
// Hash evidence bytes for indexing, never emit the evidence body itself.
function evidenceRows(db,table,sql) {
  const result=rows(db,table,sql);
  result.items=result.items.map(({_evidence,...item})=>({...item,evidenceDigest:_evidence===null?null:createHash('sha256').update(_evidence).digest('hex')}));
  return result;
}
function packetLinks(attempts,packets) {
  if(attempts.total===null||packets.total===null||attempts.truncated||packets.truncated)
    return {status:'unknown_incomplete_index',checked:null,missing:null,mismatched:null};
  const byId=new Map(packets.items.map(packet=>[packet.packet_id,packet]));let checked=0,missing=0,mismatched=0;
  for(const attempt of attempts.items) {if(!attempt.result_packet_id)continue;checked++;const packet=byId.get(attempt.result_packet_id);if(!packet)missing++;else if(packet.run_id!==attempt.run_id)mismatched++;}
  return {status:'checked_database_references',checked,missing,mismatched};
}
function recoveryRows(db, table, sql, evidence = false) {
  const result=rows(db,table,sql);
  result.items=result.items.map(({actor_id,idempotency_key,_evidence,...item})=>({ ...item,
    recoveryIdentityDigest:createHash('sha256').update(JSON.stringify([item.organization_id,actor_id,idempotency_key])).digest('hex'),
    ...(evidence?{evidenceDigest:_evidence===null?null:createHash('sha256').update(_evidence).digest('hex')}:{}) }));
  return result;
}
function releaseLinks(operations, completions, recoveries, recoveryCompletions) {
  if ([operations, completions, recoveries, recoveryCompletions].some(index => index.total === null || index.truncated))
    return { status: 'unknown_incomplete_index', items: [] };
  const completionByOperation = new Map(completions.items.map(row => [row.operation_id, row]));
  const recoveryCompletionByIdentity = new Map(recoveryCompletions.items.map(row => [row.recoveryIdentityDigest,row]));
  const recoveryByOperation = new Map();
  for (const row of recoveries.items) {
    const key=JSON.stringify([row.organization_id,row.operation_id]);
    const states=recoveryByOperation.get(key) || [];
    states.push(row); recoveryByOperation.set(key,states);
  }
  return { status: 'checked_database_references', items: operations.items.map(operation => {
    const completion = completionByOperation.get(operation.id);
    const completionStatus = !completion ? 'missing' : completion.organization_id !== operation.organization_id || completion.input_digest !== operation.input_digest ? 'identity_mismatch' : 'matched';
    return { operationId: operation.id, state: operation.state, resultDigest: operation.evidenceDigest,
      producerCompletion: completionStatus, producer: completionStatus === 'matched' ? completion.producer : null,
      recoveries: (recoveryByOperation.get(JSON.stringify([operation.organization_id,operation.id])) || []).map(command=>{
        const fact=recoveryCompletionByIdentity.get(command.recoveryIdentityDigest);
        return { identityDigest:command.recoveryIdentityDigest,state:command.state,
          directCompletion:!fact?'missing':fact.organization_id===operation.organization_id && fact.operation_id===operation.id && fact.input_digest===operation.input_digest?'matched':'identity_mismatch',
          completionEvidenceDigest:fact?.evidenceDigest || null };
      }) };
  }), limitation: 'Database references only: command return does not prove external effect or producer-tree quiescence.' };
}
function inspect(databases) {
  const c = databases.collaborations, w = databases.workflow, r = databases.coordination;
  const active = {
    executionBindings: count(c, 'factory_execution_bindings', "status IN ('intent','running','unknown')", [], true),
    runningAttempts: count(c, 'collaboration_attempts', "state='running' OR failure_kind='unknown_outcome'"),
    dispatchCommands: count(c, 'collaboration_dispatch_commands', "state IN ('pending','claimed')"),
    schedulerLeases: count(c, 'factory_scheduler_leases', 'expires_at > ?', [new Date().toISOString()], true),
    integrationOperations: count(c, 'factory_integration_operations', "state IN ('intent','applying','applied_unverified','workspace_applied_verified','committing','commit_verified')", [], true),
    combinationCommits: count(c, 'factory_combination_commits', "state <> 'integrated'", [], true),
    retirementOperations: count(c, 'factory_retirement_operations', "state <> 'retired'", [], true),
    organizationOperations: count(c, 'organization_operations', "state NOT IN ('completed','failed_terminal')", [], true),
    lifecycleOperations: count(c, 'organization_lifecycle_operations', "state='pending'", [], true),
    nodeRebindOperations: count(c, 'organization_node_rebind_operations', "state='pending'", [], true),
    ownerInitialOrganizationOperations: count(c, 'owner_initial_organization_operations', "state NOT IN ('completed','failed_terminal','cancelled')", [], true),
    orchestrationCommands: count(c, 'orchestration_commands', "state IN ('pending','deferred','claimed','acknowledged')", [], true),
    // A published remote fact alone is not proof the local producer returned.
    releaseOperations: count(c, 'factory_release_operations', hasTable(c,'factory_release_producer_completions') && hasTable(c,'factory_release_recovery_commands')
      ? "state NOT IN ('completed','failed_terminal','cancelled','unsupported') AND NOT (state='published' AND EXISTS (SELECT 1 FROM factory_release_producer_completions p WHERE p.operation_id=factory_release_operations.id AND p.organization_id=factory_release_operations.organization_id AND p.input_digest=factory_release_operations.input_digest AND p.producer='initial') AND NOT EXISTS (SELECT 1 FROM factory_release_recovery_commands r WHERE r.operation_id=factory_release_operations.id))"
      : "state NOT IN ('completed','failed_terminal','cancelled','unsupported')", [], true),
    workspaceLeases: count(r, 'workspace_leases', "state IN ('preparing','active','quarantined')"),
  };
  const schema = Object.fromEntries(NAMES.map((name) => [name, databases[name] ? {
    userVersion: Number(databases[name].prepare('PRAGMA user_version').get().user_version),
    tables: databases[name].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
  } : { status:'source_unavailable', userVersion:null, tables:null }]));
  const watermarks = {
    collaborationEvents: hasTable(c, 'collaboration_events') ? Number(c.prepare('SELECT COALESCE(MAX(id),0) AS n FROM collaboration_events').get().n) : null,
    factoryEvents: hasTable(c, 'factory_events') ? Number(c.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM factory_events').get().n) : null,
    workspaceEvents: hasTable(r, 'workspace_lease_events') ? Number(r.prepare('SELECT COALESCE(MAX(id),0) AS n FROM workspace_lease_events').get().n) : null,
  };
  const references = {
    runs: rows(c, 'collaboration_attempts', "SELECT id,task_id,session_id,run_id,result_packet_id,state FROM collaboration_attempts ORDER BY id"),
    candidates: rows(c, 'factory_candidates', 'SELECT id,work_item_id,contract_revision,execution_epoch,binding_generation,digest FROM factory_candidates ORDER BY id'),
    packets: rows(w, 'result_packets', 'SELECT packet_id,run_id,digest FROM result_packets ORDER BY packet_id'),
    candidatePayloads: rows(c, 'factory_candidate_payloads', 'SELECT candidate_id,work_item_id,contract_revision,execution_epoch,binding_generation,run_id,baseline_digest,digest FROM factory_candidate_payloads ORDER BY candidate_id'),
    decisions: evidenceRows(c, 'factory_acceptance_decisions', 'SELECT id,work_item_id,contract_revision,candidate_digest,gate_generation,criterion_id,decision,evidence_json AS _evidence FROM factory_acceptance_decisions ORDER BY id'),
    checks: evidenceRows(c, 'factory_check_operations', 'SELECT id,organization_id,work_item_id,validation_work_item_id,candidate_digest,criterion_id,action_id,action_digest,validation_run_id,workspace_id,state,evidence_json AS _evidence FROM factory_check_operations ORDER BY id'),
    combinationChecks: evidenceRows(c, 'factory_combination_checks', 'SELECT id,organization_id,queue_id,combination_digest,input_digest,base_head,action_id,action_digest,validation_work_item_id,run_id,workspace_id,state,evidence_json AS _evidence FROM factory_combination_checks ORDER BY id'),
    milestones: evidenceRows(c, 'factory_delivery_milestones', 'SELECT id,organization_id,work_item_id,contract_revision,execution_epoch,binding_generation,candidate_digest,milestone,operation_id,source_digest,result_digest,evidence_json AS _evidence FROM factory_delivery_milestones ORDER BY id'),
    combinationReceipts: rows(c, 'factory_combination_receipts', 'SELECT operation_id,organization_id,queue_id,input_digest,combination_digest,base_head,commit_id,tree_id,result_digest FROM factory_combination_receipts ORDER BY operation_id'),
    releasePackages: rows(c, 'factory_release_packages', 'SELECT id,organization_id,work_item_id,candidate_digest,integration_operation_id,source_commit,artifact_digest,artifact_bytes FROM factory_release_packages ORDER BY id'),
    releases: evidenceRows(c, 'factory_release_operations', 'SELECT id,organization_id,authorization_id,input_digest,state,result_json AS _evidence FROM factory_release_operations ORDER BY id'),
    releaseProducerCompletions: rows(c, 'factory_release_producer_completions', 'SELECT operation_id,organization_id,input_digest,producer,completed_at FROM factory_release_producer_completions ORDER BY operation_id'),
    releaseRecoveryCommands: recoveryRows(c, 'factory_release_recovery_commands', 'SELECT organization_id,actor_id,idempotency_key,operation_id,state,created_at,updated_at FROM factory_release_recovery_commands ORDER BY organization_id,operation_id,created_at,actor_id,idempotency_key'),
    releaseRecoveryCompletions: recoveryRows(c, 'factory_release_recovery_completions', 'SELECT organization_id,actor_id,idempotency_key,operation_id,input_digest,evidence_json AS _evidence,completed_at FROM factory_release_recovery_completions ORDER BY organization_id,operation_id,completed_at,actor_id,idempotency_key',true),
    retirements: rows(c, 'factory_retirement_operations', 'SELECT id,organization_id,kind,target_id,preview_digest,state FROM factory_retirement_operations ORDER BY id'),
    validationWorkspaces: rows(c, 'factory_validation_workspaces', 'SELECT id,validation_work_item_id,run_id,session_id,candidate_digest,state,provenance FROM factory_validation_workspaces ORDER BY id'),
  };
  return { schema, watermarks, active, references, referenceChecks:{attemptPacketLinks:packetLinks(references.runs,references.packets),releaseLinks:releaseLinks(references.releases,references.releaseProducerCompletions,references.releaseRecoveryCommands,references.releaseRecoveryCompletions),scope:'database_rows_only',runFiles:'not_checked',artifacts:'not_checked',externalEffects:'not_checked'},
    optionalOperationTables: Object.fromEntries(['organization_lifecycle_operations', 'organization_node_rebind_operations', 'owner_initial_organization_operations', 'factory_combination_commits', 'factory_retirement_operations', 'factory_release_producer_completions', 'factory_release_recovery_commands', 'factory_release_recovery_completions']
      .map((name) => [name, !c ? 'source_unavailable' : hasTable(c, name) ? 'available' : 'absent_legacy_or_not_initialized'])) };
}
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// An observational index, not a copy or an atomic filesystem checkpoint.
// Only canonical Run facts are inspected; capability files and output bodies
// are never emitted. A changing file is not treated as a stable observation.
async function observeRunFiles(index, runsRoot) {
  if (!runsRoot) return { status: 'not_checked', reason: 'runs_root_not_provided' };
  if (!isAbsolute(runsRoot)) fail('Run root must be an absolute path');
  const rootStat = await lstat(runsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Run root must be an existing non-symlink directory');
  const root = await realpath(runsRoot);
  const items = [], candidates = index.items.filter(attempt => attempt.run_id);
  // Keep the optional scan bounded independently of the database row limit.
  for (const attempt of candidates.slice(0, 100)) {
    const id = attempt.run_id;
    if (!id) continue;
    const entry = { attemptId: attempt.id, runId: id, status: 'unknown', files: {} };
    items.push(entry);
    if (!/^run_[a-f0-9]{24}$/.test(id)) { entry.status = 'unsupported_run_id'; continue; }
    try {
      const dir = join(root, id), directory = await lstat(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !contained(root, await realpath(dir))) { entry.status = 'invalid_run_directory'; continue; }
      const values = {};
      for (const name of ['status', 'manifest', 'result']) {
        const path = join(dir, `${name}.json`);
        try {
          const before = await lstat(path);
          if (!before.isFile() || before.isSymbolicLink()) { entry.files[name] = { status: 'invalid' }; continue; }
          if (before.size > 2 * 1024 * 1024) { entry.files[name] = { status: 'size_limit', bytes: before.size }; continue; }
          // Read no more than the declared cap even if the file grows after lstat.
          const handle = await open(path, 'r');
          let bytes;
          try {
            const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
            let length = 0;
            while (length < buffer.length) {
              const part = await handle.read(buffer, length, buffer.length - length, length);
              if (!part.bytesRead) break;
              length += part.bytesRead;
            }
            if (length > 2 * 1024 * 1024) { entry.files[name] = { status: 'size_limit' }; continue; }
            bytes = buffer.subarray(0, length);
          } finally { await handle.close(); }
          const after = await lstat(path);
          if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { entry.files[name] = { status: 'changed' }; continue; }
          try { values[name] = JSON.parse(bytes.toString('utf8')); } catch { entry.files[name] = { status: 'invalid_json' }; continue; }
          entry.files[name] = { status: 'observed', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        } catch (error) { entry.files[name] = { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
      }
      if (Object.values(entry.files).some(file => file.status !== 'observed')) { entry.status = 'incomplete'; continue; }
      const run = values.status, manifest = values.manifest;
      try {
        entry.status = run?.id === id && run?.sessionId === attempt.session_id && assertRunPublication(run, manifest) ? 'publication_matched' : 'identity_unverified';
      } catch { entry.status = 'identity_inconsistent'; }
    } catch (error) { entry.status = error?.code === 'ENOENT' ? 'missing_run_directory' : 'unreadable'; }
  }
  return { status: index.total === null ? 'source_unavailable' : index.truncated || candidates.length > items.length ? 'observed_truncated' : 'observed', asOf: new Date().toISOString(), crossStoreAtomic: false, limitation: 'Files can change after observation; database locks do not fence Run files.', items };
}
// Only inspect immutable, previously registered package paths. The explicit
// root further restricts the observation; it does not reauthorize release.
async function observeRegisteredArtifacts(db, artifactRoot) {
  if (!artifactRoot) return { status: 'not_checked', reason: 'artifact_root_not_provided' };
  if (!isAbsolute(artifactRoot)) fail('Artifact root must be an absolute path');
  const rootStat=await lstat(artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Artifact root must be an existing non-symlink directory');
  const root=await realpath(artifactRoot);
  if (!hasTable(db,'factory_release_packages')) return {status:'source_unavailable',items:[]};
  const packages=db.prepare('SELECT id,artifact_path,artifact_digest,artifact_bytes FROM factory_release_packages ORDER BY id LIMIT 51').all();
  const items=[]; let remaining=32*1024*1024;
  for (const pkg of packages.slice(0,50)) {
    const item={packageId:pkg.id,expectedDigest:pkg.artifact_digest,expectedBytes:pkg.artifact_bytes,status:'unknown'};
    items.push(item);
    try {
      if (!isAbsolute(pkg.artifact_path) || !contained(root,resolve(pkg.artifact_path))) {item.status='outside_observation_root';continue;}
      const path=pkg.artifact_path, initial=await lstat(path);
      if (!initial.isFile() || initial.isSymbolicLink() || !contained(root,await realpath(path))) {item.status='invalid';continue;}
      if (initial.size>remaining) {item.status='byte_limit';continue;}
      const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      try {
        const before=await handle.stat();
        if (!before.isFile() || before.dev!==initial.dev || before.ino!==initial.ino || before.size!==initial.size) {item.status='changed';continue;}
        const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let offset=0;
        while (offset<before.size) {
          const part=await handle.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);
          if (!part.bytesRead) break;
          hash.update(buffer.subarray(0,part.bytesRead));offset+=part.bytesRead;remaining-=part.bytesRead;
        }
        const after=await handle.stat(), final=await lstat(path);
        if (offset!==before.size || !final.isFile() || final.isSymbolicLink() || before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || after.dev!==final.dev || after.ino!==final.ino || after.size!==final.size || after.mtimeMs!==final.mtimeMs || after.ctimeMs!==final.ctimeMs) {item.status='changed';continue;}
        item.observedDigest=hash.digest('hex');item.observedBytes=offset;
        item.status=item.observedDigest===pkg.artifact_digest && offset===pkg.artifact_bytes ? 'digest_matched' : 'digest_mismatch';
      } finally {await handle.close();}
    } catch(error) {item.status=error?.code==='ENOENT'?'missing':'unreadable';}
  }
  return {status:packages.length>items.length?'observed_truncated':'observed',asOf:new Date().toISOString(),crossStoreAtomic:false,scope:'registered_packages_within_explicit_root_only',limitation:'Registration authorized the original path; this observation does not reauthorize release or fence later file changes.',items};
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
export async function inventoryFactoryBackup({ sources, runsRoot, artifactRoot } = {}) {
  const files = {}, databases = {};
  try {
    for (const name of NAMES) {
      const input=sources?.[name];
      if (typeof input!=='string' || !isAbsolute(input)) fail('Each source database must be an absolute path');
      try { files[name]=await regularFile(input); }
      catch(error) { if(error?.code!=='ENOENT') throw error; files[name]=null; }
    }
    const existing=NAMES.map(name=>files[name]?.path).filter(Boolean);
    if(new Set(existing).size!==existing.length) fail('Source databases must be distinct');
    for (const name of NAMES) databases[name] = files[name] ? openRead(files[name].path) : null;
    const report = inspect(databases);
    report.referenceChecks.runFiles = await observeRunFiles(report.references.runs, runsRoot);
    report.referenceChecks.artifacts = await observeRegisteredArtifacts(databases.collaborations, artifactRoot);
    return { mode: 'inventory', copiesCreated: false, guarantee: 'observational_only',
      limitations: ['SQLite may create or update source WAL shared-memory sidecars even for read-only connections.'],
      sourceSizes: Object.fromEntries(NAMES.map((name) => [name, files[name]?.size ?? null])),
      sourceStatus: Object.fromEntries(NAMES.map(name=>[name,files[name]?'available':'source_unavailable'])), ...report };
  } finally { for (const db of Object.values(databases)) db?.close(); }
}

export async function createFactoryBackup({ sources, destination, allowedRoot, runsRoot, artifactRoot } = {}) {
  const files = await sourceFiles(sources);
  if (!isAbsolute(destination || '') || !isAbsolute(allowedRoot || '')) fail('Absolute destination and allowed root are required');
  const root = await realpath(allowedRoot), parent = await realpath(dirname(destination)), target = resolve(destination);
  if (!contained(root, parent) || !contained(root, target) || target === root) fail('Backup destination must be a new directory inside the allowed root');
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
    report.referenceChecks.runFiles = await observeRunFiles(report.references.runs, runsRoot);
    report.referenceChecks.artifacts = await observeRegisteredArtifacts(locks.collaborations, artifactRoot);
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
    if (!['collaborations', 'workflow', 'coordination', 'destination', 'allowed-root', 'runs-root', 'artifact-root'].includes(key) || options[key]) fail('Unknown or duplicate option');
    options[key] = argv[i + 1];
  }
  const sources = Object.fromEntries(NAMES.map((name) => [name, options[name]]));
  const result = mode === 'inventory' ? await inventoryFactoryBackup({ sources, runsRoot: options['runs-root'], artifactRoot: options['artifact-root'] })
    : await createFactoryBackup({ sources, destination: options.destination, allowedRoot: options['allowed-root'], runsRoot: options['runs-root'], artifactRoot: options['artifact-root'] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`${error?.code || 'ERROR'}: ${error?.message || String(error)}`); process.exitCode = 1; });
}
