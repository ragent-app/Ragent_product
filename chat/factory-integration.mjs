import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { factoryTransaction, now, decode } from './work-graph-store.mjs';
import { authorize, selectItem, checkVersion } from './work-graph.mjs';
import { getSession } from './session-manager.mjs';
import { executeMutation } from './mutation-coordinator.mjs';
import { verifyFactoryCandidate } from './factory-candidates.mjs';
import { recordFactoryMilestone } from './factory-control.mjs';
import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';

const git = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw Object.assign(new Error(message), { code: 'FACTORY_INTEGRATION_BLOCKED', statusCode: 409 }); };
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_integration_operations (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL, candidate_digest TEXT NOT NULL, target_root TEXT NOT NULL,
    expected_head TEXT NOT NULL, state TEXT NOT NULL, result_digest TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(factory_integration_operations)').all().map((row) => row.name));
  if (!columns.has('commit_id')) db.exec('ALTER TABLE factory_integration_operations ADD COLUMN commit_id TEXT');
  if (!columns.has('tree_id')) db.exec('ALTER TABLE factory_integration_operations ADD COLUMN tree_id TEXT');
}
export async function factoryTargetHead(root) {
  try { return (await git('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true })).stdout.trim(); }
  catch { return fail('Target repository HEAD is unavailable'); }
}
export async function factoryTargetBranch(root) {
  try { return (await git('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true })).stdout.trim(); }
  catch { return fail('Target branch is unavailable'); }
}
export async function checkedFactoryTarget(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) fail('Candidate path is invalid');
  const target = join(root, ...path.split('/'));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('Candidate path escapes target');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat?.isSymbolicLink()) fail('Candidate target traverses a symbolic link');
  }
  return target;
}
async function version(path) {
  const stat = await lstat(path).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return '';
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Candidate target is not a regular file');
  return sha(await readFile(path));
}
export async function checkFactoryBaseline(root, base) {
  const expected = new Map(base.files.map((file) => [file.path, file]));
  const found = new Set(), queue = [...base.workspace.writablePaths];
  let count = 0, bytes = 0, visited = 0;
  while (queue.length) {
    if (++visited > 5000) fail('Target baseline exceeds the directory-entry limit');
    const path = queue.pop(), absolute = await checkedFactoryTarget(root, path);
    const stat = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat || found.has(path)) continue;
    found.add(path);
    if (stat.isDirectory()) {
      for (const entry of await readdir(absolute)) queue.push(`${path}/${entry}`);
    } else if (stat.isFile()) {
      count += 1; bytes += stat.size;
      if (count > 1000 || bytes > 32 * 1024 * 1024) fail('Target baseline exceeds the candidate limits');
      const prior = expected.get(path);
      if (!prior || prior.digest !== await version(absolute) || Boolean(prior.executable) !== Boolean(stat.mode & 0o111)) fail('Target inputs changed since the candidate baseline');
      expected.delete(path);
    } else fail('Target baseline contains an unsupported object');
  }
  if (expected.size) fail('Target baseline files were removed');
}

// One explicit operation applies only an accepted candidate's changed files.
// Unknown/interrupted effects stay `applying` and require reconciliation;
// they are never automatically replayed as a new patch.
export async function integrateFactoryCandidate(input, actor) {
  const { organizationId, workItemId, candidateId, candidateDigest, operationId, expectedHead, expectedVersion } = input || {};
  if (![organizationId, workItemId, candidateId, candidateDigest, operationId, expectedHead].every((value) => typeof value === 'string' && value.trim())) fail('Integration requires explicit candidate, operation and target HEAD identities');
  const prepared = await factoryTransaction((db) => {
    ensureSchema(db);
    const org = authorize(db, organizationId, actor, 'factory.IntegrateWork');
    const row = selectItem(db, organizationId, workItemId);
    const old = db.prepare('SELECT * FROM factory_integration_operations WHERE id=?').get(operationId);
    if (!old) checkVersion(row, expectedVersion);
    if (row.state !== 'completed' || row.control_state !== 'none' || row.candidate_digest !== candidateDigest) fail('Current candidate is not accepted');
    const contract = decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(row.id, row.contract_revision)?.contract_json, {});
    if (contract.integrationApprovalRequired === true) fail('This contract requires a separate integration approval');
    if (typeof contract.targetBranch !== 'string' || !contract.targetBranch.trim()) fail('Contract must pin the target branch');
    const binding = db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(row.id, row.contract_revision, row.execution_epoch, row.binding_generation);
    if (!binding) fail('Accepted execution binding is missing');
    const projected = { status: binding.status, dispatchKey: binding.dispatch_key, contractRevision: binding.contract_revision,
      executionEpoch: binding.execution_epoch, bindingGeneration: binding.binding_generation, runId: binding.run_id,
      attemptId: binding.attempt_id, collaborationId: binding.collaboration_id };
    const verified = verifyFactoryCandidate({ db, binding: projected, item: { id: row.id }, payload: { candidateId, digest: candidateDigest } });
    if (!verified) fail('Candidate content or execution evidence changed');
    const baseline = db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${binding.dispatch_key}`);
    const source = db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(candidateId);
    const base = decode(baseline?.files_json, null), changes = decode(source?.files_json, null);
    if (!base?.workspace?.canonicalCwd || !Array.isArray(base.files) || !Array.isArray(changes)) fail('Candidate baseline is unavailable');
    if (base.source?.head !== expectedHead || base.source?.branch !== contract.targetBranch.trim()) fail('Candidate baseline does not match the authorized target');
    if (old) {
      if (old.organization_id !== organizationId || old.work_item_id !== workItemId || old.candidate_digest !== candidateDigest || old.expected_head !== expectedHead) fail('Integration operation identity conflicts');
      if (old.state !== 'workspace_applied_verified' && old.state !== 'applied_unverified') fail('Prior integration outcome requires reconciliation');
      return { replay: true, operation: old, rootSessionId: org.root_session_id, rowVersion: row.row_version,
        binding: projected, base, changes, targetRoot: base.workspace.canonicalCwd, targetBranch: contract.targetBranch.trim() };
    }
    const ts = now();
    db.prepare(`INSERT INTO factory_integration_operations (id,organization_id,work_item_id,candidate_id,candidate_digest,
      target_root,expected_head,state,result_digest,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId, organizationId,
      workItemId, candidateId, candidateDigest, base.workspace.canonicalCwd, expectedHead, 'intent', null, null, ts, ts);
    return { rootSessionId: org.root_session_id, rowVersion: row.row_version, binding: projected, base, changes,
      targetRoot: base.workspace.canonicalCwd, targetBranch: contract.targetBranch.trim() };
  });
  const rootSession = await getSession(prepared.rootSessionId);
  const targetRoot = await realpath(prepared.targetRoot);
  if (!rootSession?.folder || await realpath(rootSession.folder) !== targetRoot) fail('Canonical project identity changed');
  const baseFiles = new Map(prepared.base.files.map((file) => [file.path, file.digest]));
  const targets = [];
  for (const change of prepared.changes) {
    const target = await checkedFactoryTarget(targetRoot, change.path);
    targets.push({ ...change, target, expected: baseFiles.get(change.path) || '' });
  }
  if (prepared.replay) {
    if (await factoryTargetHead(targetRoot) !== expectedHead || await factoryTargetBranch(targetRoot) !== prepared.targetBranch) fail('Target changed after the prior workspace operation');
    const final = new Map(prepared.base.files.map((file) => [file.path, file]));
    for (const change of targets) {
      if (change.type === 'delete') final.delete(change.path);
      else final.set(change.path, { path: change.path, digest: change.digest, executable: change.executable });
    }
    await checkFactoryBaseline(targetRoot, { ...prepared.base, files: [...final.values()] });
    await factoryTransaction((db) => db.prepare("UPDATE factory_integration_operations SET state='workspace_applied_verified',updated_at=? WHERE id=? AND state='applied_unverified'").run(now(), operationId));
    return { state: 'workspace_applied_verified', operationId, resultDigest: prepared.operation.result_digest, replay: true };
  }
  const resourceKeys = [`workspace:${targetRoot}`, `git-index:${targetRoot}`, ...targets.map((change) => `file:${change.target}`)];
  const expectedVersions = Object.fromEntries(targets.map((change) => [`file:${change.target}`, change.expected]));
  const readResourceVersion = async (key) => version(await checkedFactoryTarget(targetRoot, relative(targetRoot, key.slice(5)).split(sep).join('/')));
  const applied = await executeMutation({ resourceKeys, expectedVersions, nonReclaimable: true, deps: { readResourceVersion }, mutate: async () => {
    if (await factoryTargetHead(targetRoot) !== expectedHead || await factoryTargetBranch(targetRoot) !== prepared.targetBranch) fail('Target branch or HEAD changed since candidate capture');
    await checkFactoryBaseline(targetRoot, prepared.base);
    await factoryTransaction((db) => {
      const row = selectItem(db, organizationId, workItemId);
      if (row.row_version !== prepared.rowVersion || row.state !== 'completed' || row.control_state !== 'none'
          || row.candidate_digest !== candidateDigest || !verifyFactoryCandidate({ db, binding: prepared.binding,
            item: { id: row.id }, payload: { candidateId, digest: candidateDigest } })) fail('Acceptance or candidate changed before integration');
      const result = db.prepare("UPDATE factory_integration_operations SET state='applying',updated_at=? WHERE id=? AND state='intent'").run(now(), operationId);
      if (!result.changes) fail('Integration operation was already started');
    });
    const journal = [];
    try {
      for (const change of targets) {
        const target = await checkedFactoryTarget(targetRoot, change.path);
        if (await version(target) !== change.expected) fail('Target content changed during integration');
        const previous = change.expected ? await readFile(target) : null;
        journal.push({ target, previous, written: change.type === 'delete' ? '' : change.digest, path: change.path });
        if (change.type === 'delete') await rm(target);
        else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(change.bytes, 'base64')); }
      }
    } catch (error) {
      for (const entry of journal.reverse()) {
        try {
          const safeTarget = await checkedFactoryTarget(targetRoot, entry.path);
          if (await version(safeTarget) !== entry.written) continue;
          if (entry.previous === null) await rm(safeTarget, { force: true });
          else await writeFile(safeTarget, entry.previous);
        } catch { /* Preserve unknown state for explicit reconciliation. */ }
      }
      throw error;
    }
    const resultDigest = sha(JSON.stringify(targets.map(({ path, type, digest }) => ({ path, type, digest }))));
    await factoryTransaction((db) => db.prepare("UPDATE factory_integration_operations SET state='applied_unverified',result_digest=?,updated_at=? WHERE id=? AND state='applying'").run(resultDigest, now(), operationId));
    for (const change of targets) {
      if (await version(await checkedFactoryTarget(targetRoot, change.path)) !== (change.type === 'delete' ? '' : change.digest)) fail('Integrated target differs from candidate');
    }
    if (await factoryTargetHead(targetRoot) !== expectedHead) fail('Target HEAD changed during integration');
    await factoryTransaction((db) => db.prepare("UPDATE factory_integration_operations SET state='workspace_applied_verified',updated_at=? WHERE id=? AND state='applied_unverified'").run(now(), operationId));
    return { resultDigest, changedFiles: targets.map((entry) => entry.path) };
  } });
  return { state: 'workspace_applied_verified', operationId, ...applied.result };
}

// Optional second operation: the workspace application above is deliberately
// not called integrated until Git records and verifies a real commit.
export async function commitFactoryIntegration(input, actor) {
  const { organizationId, workItemId, operationId, expectedVersion } = input || {};
  if (![organizationId, workItemId, operationId].every((value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value))) fail('Invalid commit operation identity');
  const prepared = await factoryTransaction((db) => {
    ensureSchema(db);
    authorize(db, organizationId, actor, 'factory.IntegrateWork');
    const item = selectItem(db, organizationId, workItemId);
    const op = db.prepare('SELECT * FROM factory_integration_operations WHERE id=? AND organization_id=? AND work_item_id=?').get(operationId, organizationId, workItemId);
    if (!op || !['workspace_applied_verified', 'committing', 'commit_verified', 'milestone_recorded'].includes(op.state)) fail('Verified workspace operation is required');
    if (op.state !== 'milestone_recorded') checkVersion(item, expectedVersion);
    if (item.state !== 'completed' || item.control_state !== 'none' || item.candidate_digest !== op.candidate_digest) fail('Accepted candidate changed');
    const b = db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?')
      .get(item.id, item.contract_revision, item.execution_epoch, item.binding_generation);
    const binding = b && { status: b.status, dispatchKey: b.dispatch_key, contractRevision: b.contract_revision,
      executionEpoch: b.execution_epoch, bindingGeneration: b.binding_generation, runId: b.run_id, attemptId: b.attempt_id, collaborationId: b.collaboration_id };
    if (!binding || !verifyFactoryCandidate({ db, binding, item: { id: item.id }, payload: { candidateId: op.candidate_id, digest: op.candidate_digest } })) fail('Accepted candidate cannot be verified');
    const base = decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${b.dispatch_key}`)?.files_json, null);
    const changes = decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(op.candidate_id)?.files_json, null);
    const contract = decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id, item.contract_revision)?.contract_json, {});
    if (!base?.source || !Array.isArray(changes) || !changes.length || contract.targetBranch !== base.source.branch) fail('Candidate has no committable authorized changes');
    return { op, binding, base, changes, rowVersion: item.row_version };
  });
  const root = await realpath(prepared.op.target_root);
  const paths = prepared.changes.map((entry) => entry.path);
  const keys = [`workspace:${root}`, `git-index:${root}`];
  for (const path of paths) keys.push(`file:${await checkedFactoryTarget(root, path)}`);
  const result = await executeMutation({ resourceKeys: keys, nonReclaimable: true, mutate: async () => {
    if (await factoryTargetBranch(root) !== prepared.base.source.branch) fail('Target branch changed');
    let commitId = '';
    if (prepared.op.state === 'workspace_applied_verified') {
      if (await factoryTargetHead(root) !== prepared.op.expected_head) fail('Target HEAD changed before commit');
      const final = new Map(prepared.base.files.map((file) => [file.path, file]));
      for (const change of prepared.changes) {
        if (change.type === 'delete') final.delete(change.path);
        else final.set(change.path, { path: change.path, digest: change.digest, executable: change.executable });
      }
      await checkFactoryBaseline(root, { ...prepared.base, files: [...final.values()] });
      const before = new Map(prepared.base.files.map((file) => [file.path, file]));
      for (const change of prepared.changes) {
        let atHead = null;
        try { atHead = (await git('git', ['-C', root, 'show', `${prepared.op.expected_head}:${change.path}`], { windowsHide: true, encoding: 'buffer', maxBuffer: 34 * 1024 * 1024 })).stdout; }
        catch { /* Missing path in HEAD is allowed only for a new candidate file. */ }
        const baseline = before.get(change.path);
        if ((baseline && (!atHead || sha(atHead) !== baseline.digest)) || (!baseline && atHead)) fail('Touched path contains pre-existing uncommitted work');
      }
      const rawIndex = (await git('git', ['-C', root, 'rev-parse', '--git-path', 'index'], { windowsHide: true })).stdout.trim();
      const index = resolve(root, rawIndex), lockPath = `${index}.lock`;
      const indexLock = await open(lockPath, 'wx');
      const lockIdentity = await indexLock.stat();
      let refUpdated = false;
      let privateDir = '';
      try {
        try { await git('git', ['-C', root, 'diff', '--cached', '--quiet', '--exit-code'], { windowsHide: true }); }
        catch { fail('Git index contains staged changes; preserve them and integrate separately'); }
        privateDir = await mkdtemp(join(MANAGED_WORK_ROOT_DIR, 'factory-index-'));
        const privateIndex = join(privateDir, 'index');
        const options = { windowsHide: true, env: { ...process.env, GIT_INDEX_FILE: privateIndex } };
        await git('git', ['-C', root, 'read-tree', prepared.op.expected_head], options);
        await git('git', ['-C', root, 'add', '-A', '--', ...paths], options);
        const staged = (await git('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], options)).stdout.split('\0').filter(Boolean).sort();
        if (JSON.stringify(staged) !== JSON.stringify([...paths].sort())) fail('Private Git index does not match candidate paths');
        for (const change of prepared.changes) {
          let bytes = null;
          try { bytes = (await git('git', ['-C', root, 'show', `:${change.path}`], { ...options, encoding: 'buffer', maxBuffer: 34 * 1024 * 1024 })).stdout; } catch {}
          if (change.type === 'delete' ? bytes !== null : !bytes || sha(bytes) !== change.digest) fail('Private Git index differs from candidate bytes');
        }
        const tree = (await git('git', ['-C', root, 'write-tree'], options)).stdout.trim();
        const created = (await git('git', ['-C', root, 'commit-tree', tree, '-p', prepared.op.expected_head,
          '-m', 'Integrate accepted Factory candidate', '-m', `Factory-Operation: ${operationId}\nFactory-Candidate: ${prepared.op.candidate_digest}`], options)).stdout.trim();
        const ref = (await git('git', ['-C', root, 'symbolic-ref', '--quiet', 'HEAD'], { windowsHide: true })).stdout.trim();
        if (ref !== `refs/heads/${prepared.base.source.branch}`) fail('Target branch changed before commit');
        const indexBytes = await readFile(privateIndex);
        await indexLock.writeFile(indexBytes);
        await indexLock.sync();
        await indexLock.close();
        await factoryTransaction((db) => {
          const row = selectItem(db, organizationId, workItemId);
          if (row.row_version !== prepared.rowVersion || row.state !== 'completed' || row.candidate_digest !== prepared.op.candidate_digest) fail('Acceptance changed before Git commit');
          if (!db.prepare("UPDATE factory_integration_operations SET state='committing',commit_id=?,tree_id=?,updated_at=? WHERE id=? AND state='workspace_applied_verified'").run(created, tree, now(), operationId).changes) fail('Git operation was already started');
        });
        await git('git', ['-C', root, 'update-ref', ref, created, prepared.op.expected_head], { windowsHide: true });
        refUpdated = true;
        await rename(lockPath, index);
      } finally {
        await indexLock.close().catch(() => {});
        // If the branch moved but index replacement failed, retain the lock for
        // explicit recovery; silently deleting it would invite index corruption.
        if (!refUpdated) {
          const actual = await lstat(lockPath).catch(() => null);
          if (actual && actual.dev === lockIdentity.dev && actual.ino === lockIdentity.ino) await rm(lockPath, { force: true }).catch(() => {});
        }
        if (privateDir) {
          const relativeDir = relative(MANAGED_WORK_ROOT_DIR, privateDir);
          if (relativeDir && relativeDir !== '..' && !relativeDir.startsWith(`..${sep}`) && !isAbsolute(relativeDir)) {
            await rm(join(privateDir, 'index'), { force: true }).catch(() => {});
            await rm(join(privateDir, 'index.lock'), { force: true }).catch(() => {});
            await rmdir(privateDir).catch(() => {});
          }
        }
      }
    }
    // For an interrupted commit, query the current commit before taking any
    // further action; never repeat git add or commit on an unknown outcome.
    const indexPath = resolve(root, (await git('git', ['-C', root, 'rev-parse', '--git-path', 'index'], { windowsHide: true })).stdout.trim());
    if (await lstat(`${indexPath}.lock`).then(() => true, () => false)) fail('Git index lock remains; reconcile the interrupted operation before recording integration');
    try { await git('git', ['-C', root, 'diff', '--cached', '--quiet', '--exit-code'], { windowsHide: true }); }
    catch { fail('Git index is not reconciled with the current commit'); }
    commitId = await factoryTargetHead(root);
    const parents = (await git('git', ['-C', root, 'show', '-s', '--format=%P', commitId], { windowsHide: true })).stdout.trim().split(/\s+/);
    const message = (await git('git', ['-C', root, 'show', '-s', '--format=%B', commitId], { windowsHide: true })).stdout;
    if (parents.length !== 1 || parents[0] !== prepared.op.expected_head
        || !message.split(/\r?\n/).includes(`Factory-Operation: ${operationId}`)
        || !message.split(/\r?\n/).includes(`Factory-Candidate: ${prepared.op.candidate_digest}`)) fail('Git commit outcome is unknown or does not match this operation');
    const committedPaths = (await git('git', ['-C', root, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitId], { windowsHide: true })).stdout.split('\0').filter(Boolean).sort();
    if (JSON.stringify(committedPaths) !== JSON.stringify([...paths].sort())) fail('Commit paths differ from the accepted candidate');
    for (const change of prepared.changes) {
      let bytes = null;
      try { bytes = (await git('git', ['-C', root, 'show', `${commitId}:${change.path}`], { windowsHide: true, encoding: 'buffer', maxBuffer: 34 * 1024 * 1024 })).stdout; } catch {}
      if (change.type === 'delete' ? bytes !== null : !bytes || sha(bytes) !== change.digest) fail('Commit contents differ from the accepted candidate');
    }
    const treeId = (await git('git', ['-C', root, 'rev-parse', `${commitId}^{tree}`], { windowsHide: true })).stdout.trim();
    const resultDigest = sha(JSON.stringify({ parent: prepared.op.expected_head, commit: commitId, tree: treeId }));
    await factoryTransaction((db) => db.prepare("UPDATE factory_integration_operations SET state='commit_verified',commit_id=?,tree_id=?,result_digest=?,updated_at=? WHERE id=? AND state IN ('committing','commit_verified','milestone_recorded')").run(commitId, treeId, resultDigest, now(), operationId));
    const milestone = await recordFactoryMilestone({ organizationId, workItemId, expectedVersion: prepared.rowVersion,
      contractRevision: prepared.binding.contractRevision, executionEpoch: prepared.binding.executionEpoch,
      bindingGeneration: prepared.binding.bindingGeneration, candidateDigest: prepared.op.candidate_digest,
      milestone: 'integrated', operationId, target: root, sourceDigest: prepared.op.candidate_digest, resultDigest }, actor, {
      verifyMilestone: ({ db, operationId: id, milestone: kind, target, sourceDigest, resultDigest: digest, candidateDigest }) => {
        const op = db.prepare('SELECT * FROM factory_integration_operations WHERE id=?').get(id);
        if (!op || op.state !== 'commit_verified' || op.target_root !== target || op.candidate_digest !== candidateDigest
            || sourceDigest !== candidateDigest || op.result_digest !== digest || op.commit_id !== commitId || op.tree_id !== treeId) return null;
        return { operationId: id, milestone: kind, target, sourceDigest, resultDigest: digest, candidateDigest,
          evidence: { commit: commitId, tree: treeId, parent: op.expected_head } };
      },
    });
    await factoryTransaction((db) => db.prepare("UPDATE factory_integration_operations SET state='milestone_recorded',updated_at=? WHERE id=? AND state='commit_verified'").run(now(), operationId));
    return { commitId, treeId, resultDigest, milestone: milestone.milestone };
  } });
  return { state: 'integrated', operationId, ...result.result };
}
