import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { factoryRead, factoryTransaction, decode, now } from './work-graph-store.mjs';
import { authorize, selectItem } from './work-graph.mjs';
import { createStagingWorkspace, discardStaging } from './managed-writer.mjs';
import { preflightFactoryWorkspace, verifyFactoryCandidate } from './factory-candidates.mjs';
import { checkFactoryBaseline, checkedFactoryTarget, factoryTargetBranch, factoryTargetHead } from './factory-integration.mjs';
import { getRun, getRunManifest } from './runs.mjs';
import { getSession } from './session-manager.mjs';
import { getOrganization } from './organization-store.mjs';

function fail(message) { throw Object.assign(new Error(message), { code: 'FACTORY_VALIDATION_UNAVAILABLE', statusCode: 409 }); }
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_validation_workspaces (
    id TEXT PRIMARY KEY, validation_work_item_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
    cwd TEXT NOT NULL, candidate_digest TEXT NOT NULL, state TEXT NOT NULL, provenance TEXT NOT NULL,
    input_manifest_json TEXT NOT NULL, output_paths_json TEXT NOT NULL
  )`);
}
function validRelative(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && !/^[A-Za-z]:/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

// Materialize exactly one pinned predecessor from its immutable candidate and
// verified baseline. No data supplied by a caller can substitute for graph or
// payload facts. The copy is content-checked, not claimed OS read-only.
export async function prepareFactoryValidationWorkspace({ organizationId, workItemId, binding, actor }) {
  const data = await factoryRead((db) => {
    schema(db); authorize(db, organizationId, actor, 'factory.execution');
    const validation = selectItem(db, organizationId, workItemId);
    if (validation.state !== 'claimed' || validation.execution_epoch !== binding.executionEpoch
        || validation.contract_revision !== binding.contractRevision || validation.binding_generation !== binding.bindingGeneration) fail('Validation binding changed');
    const deps = db.prepare("SELECT * FROM factory_dependencies WHERE successor_id=? AND milestone='candidate_ready'").all(workItemId);
    if (deps.length !== 1 || !deps[0].candidate_digest) fail('Validation requires exactly one pinned candidate input');
    const source = selectItem(db, organizationId, deps[0].predecessor_id);
    if (source.candidate_digest !== deps[0].candidate_digest) fail('Candidate dependency changed');
    const raw = db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND execution_epoch=? AND binding_generation=? AND status IN ('candidate','remote_candidate')").get(source.id, source.execution_epoch, source.binding_generation);
    const detail = decode(db.prepare('SELECT details_json FROM factory_candidates WHERE work_item_id=? AND digest=? AND contract_revision=? AND execution_epoch=?').get(source.id, source.candidate_digest, source.contract_revision, source.execution_epoch)?.details_json, {});
    const projected = raw && { status: raw.status, dispatchKey: raw.dispatch_key, contractRevision: raw.contract_revision,
      executionEpoch: raw.execution_epoch, bindingGeneration: raw.binding_generation, runId: raw.run_id, attemptId: raw.attempt_id, collaborationId: raw.collaboration_id };
    if (!projected || !verifyFactoryCandidate({ db, binding: projected, item: { id: source.id }, payload: { candidateId: detail.candidateId, digest: source.candidate_digest } })) fail('Candidate input is not verified');
    const remote=raw.status==='remote_candidate' ? decode(db.prepare('SELECT envelope_json FROM factory_remote_evidence WHERE id=? AND work_item_id=?').get(detail.candidateId,source.id)?.envelope_json,null) : null;
    const base = remote ? {source:{head:remote.baseline?.head,branch:remote.baseline?.branch},files:remote.baseline?.files,workspace:{writablePaths:decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(source.id,source.contract_revision)?.contract_json,{}).allowedPaths}} : decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${raw.dispatch_key}`)?.files_json, null);
    const changes = remote ? remote.changes : decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(detail.candidateId)?.files_json, null);
    const contract = decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(validation.id, validation.contract_revision)?.contract_json, {});
    const outputPaths = Array.isArray(contract.outputPaths) ? contract.outputPaths : [];
    if (!base?.workspace || !Array.isArray(changes) || outputPaths.some((path) => !validRelative(path))) fail('Validation workspace contract is invalid');
    const prior = db.prepare('SELECT * FROM factory_validation_workspaces WHERE id=?').get(`validation:${binding.id}`);
    if (prior) return { prior, base, changes, remote:!!remote };
    return { base, changes, outputPaths, candidateDigest: source.candidate_digest,
      sourceId: source.id, candidateId: detail.candidateId, sourceBindingId: raw.id, remote:!!remote };
  });
  if(data.remote) {
    const org=await getOrganization(organizationId), root=org?.rootSessionId && await getSession(org.rootSessionId);
    if(!root?.folder) fail('Source project root is unavailable');
    data.base.workspace.canonicalCwd=root.folder;
  }
  if (data.prior) {
    if (data.prior.state !== 'prepared' || data.prior.run_id || data.prior.session_id) fail('Validation workspace has an existing execution');
    const final = new Map(data.base.files.map((file) => [file.path, file]));
    for (const change of data.changes) {
      if (change.type === 'delete') final.delete(change.path);
      else final.set(change.path, change);
    }
    await checkFactoryBaseline(await realpath(data.prior.cwd), { ...data.base, files: [...final.values()] });
    return { id: data.prior.id, cwd: data.prior.cwd, candidateDigest: data.prior.candidate_digest };
  }
  const root = await realpath(data.base.workspace.canonicalCwd);
  await preflightFactoryWorkspace({ canonicalCwd: root, writablePaths: data.base.workspace.writablePaths });
  if (await factoryTargetHead(root) !== data.base.source.head || await factoryTargetBranch(root) !== data.base.source.branch) fail('Candidate base branch changed');
  await checkFactoryBaseline(root, data.base);
  const staging = await createStagingWorkspace({ canonicalCwd: root, writablePaths: data.base.workspace.writablePaths });
  try {
    await checkFactoryBaseline(staging.stagingDir, data.base);
    const final = new Map(data.base.files.map((file) => [file.path, file]));
    for (const change of data.changes) {
      const target = await checkedFactoryTarget(staging.stagingDir, change.path);
      if (change.type === 'delete') { await rm(target); final.delete(change.path); }
      else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(change.bytes, 'base64')); final.set(change.path, change); }
    }
    for (const output of data.outputPaths) {
      if ([...final.keys()].some((path) => path === output || path.startsWith(`${output}/`) || output.startsWith(`${path}/`))) fail('Validation outputs overlap candidate inputs');
    }
    await checkFactoryBaseline(staging.stagingDir, { ...data.base, files: [...final.values()] });
    const manifest = [...final.values()].map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path.localeCompare(b.path));
    await factoryTransaction((db) => {
      schema(db); authorize(db, organizationId, actor, 'factory.execution');
      const current = selectItem(db, organizationId, workItemId);
      if (current.state !== 'claimed' || current.contract_revision !== binding.contractRevision
          || current.execution_epoch !== binding.executionEpoch || current.binding_generation !== binding.bindingGeneration) fail('Validation binding changed during materialization');
      const source = selectItem(db, organizationId, data.sourceId);
      const raw = db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(data.sourceBindingId, source.id);
      const live = raw && { status: raw.status, dispatchKey: raw.dispatch_key, contractRevision: raw.contract_revision,
        executionEpoch: raw.execution_epoch, bindingGeneration: raw.binding_generation, runId: raw.run_id,
        attemptId: raw.attempt_id, collaborationId: raw.collaboration_id };
      const dependency = db.prepare("SELECT * FROM factory_dependencies WHERE predecessor_id=? AND successor_id=? AND milestone='candidate_ready' AND candidate_digest=?")
        .get(source.id, workItemId, data.candidateDigest);
      if (!dependency || source.candidate_digest !== data.candidateDigest || !live
          || !verifyFactoryCandidate({ db, binding: live, item: { id: source.id }, payload: { candidateId: data.candidateId, digest: data.candidateDigest } })) {
        fail('Candidate input changed during materialization');
      }
      db.prepare('INSERT INTO factory_validation_workspaces VALUES(?,?,?,?,?,?,?,?,?,?)').run(`validation:${binding.id}`,
        workItemId, '', '', staging.stagingDir, data.candidateDigest, 'prepared', 'candidate_materialized', JSON.stringify(manifest), JSON.stringify(data.outputPaths));
    });
    return { id: `validation:${binding.id}`, cwd: staging.stagingDir, candidateDigest: data.candidateDigest };
  } catch (error) { await discardStaging(staging.stagingDir).catch(() => {}); throw error; }
}

export async function bindFactoryValidationWorkspace({ organizationId, item, binding, attempt, actor }) {
  const run = await getRun(attempt.runId), manifest = await getRunManifest(attempt.runId);
  const session = run && await getSession(run.sessionId);
  if (!run || !session || run.sessionId !== attempt.sessionId || manifest?.sessionId !== attempt.sessionId) fail('Validation Run identity is unavailable');
  const recordedCwd = manifest?.executionScope?.cwd?.realPath || manifest?.folder;
  if (!recordedCwd || !session.folder || await realpath(recordedCwd) !== await realpath(session.folder)) fail('Validation Run cwd is not the bound Session workspace');
  const id = `validation:${binding.id}`;
  return factoryTransaction((db) => {
    schema(db); authorize(db, organizationId, actor, 'factory.execution');
    const row = db.prepare('SELECT * FROM factory_validation_workspaces WHERE id=? AND validation_work_item_id=?').get(id, item.id);
    const actual = db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(binding.id, item.id);
    if (!row || !actual || actual.status !== 'running' || actual.run_id !== run.id
        || session.sourceContext?.factoryValidation?.id !== id || session.sourceContext.factoryValidation.cwd !== row.cwd
        || session.folder !== row.cwd) fail('Validation workspace is not bound to the canonical Run');
    if (row.state === 'sealed') {
      if (row.run_id !== run.id || row.session_id !== session.id) fail('Validation workspace belongs to another Run');
      return row;
    }
    db.prepare("UPDATE factory_validation_workspaces SET run_id=?,session_id=?,state='sealed' WHERE id=? AND state='prepared'")
      .run(run.id, session.id, id);
    return db.prepare('SELECT * FROM factory_validation_workspaces WHERE id=?').get(id);
  });
}
