import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readdir, realpath, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { withDatabase } from './collaboration-store.mjs';
import { resolveStagingDiff } from './managed-writer.mjs';
import { getRun } from './runs.mjs';
import { MANAGED_WORK_ROOT_DIR, CHAT_COLLABORATIONS_DIR } from '../lib/config.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 1000;
const git = promisify(execFile);
const EXCLUDED = new Set(['.git', 'node_modules', '.cache', 'build', 'dist']);
const sha = (value) => createHash('sha256').update(value).digest('hex');
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_candidate_payloads (
    candidate_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, contract_revision INTEGER NOT NULL,
    execution_epoch INTEGER NOT NULL, binding_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
    baseline_digest TEXT NOT NULL, files_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS factory_candidate_payload_no_update BEFORE UPDATE ON factory_candidate_payloads BEGIN SELECT RAISE(ABORT, 'immutable candidate'); END;
  CREATE TRIGGER IF NOT EXISTS factory_candidate_payload_no_delete BEFORE DELETE ON factory_candidate_payloads BEGIN SELECT RAISE(ABORT, 'immutable candidate'); END;`);
}
function payloadDigest(row) {
  return sha(JSON.stringify({ workItemId: row.work_item_id, contractRevision: row.contract_revision,
    executionEpoch: row.execution_epoch, bindingGeneration: row.binding_generation, runId: row.run_id,
    baselineDigest: row.baseline_digest, filesJson: row.files_json }));
}
function invalid(message) { throw Object.assign(new Error(message), { code: 'FACTORY_CANDIDATE_INVALID', statusCode: 409 }); }

export async function preflightFactoryWorkspace({ canonicalCwd, writablePaths }) {
  const root = await realpath(canonicalCwd), seen = new Set(), queue = [];
  for (const path of writablePaths || []) {
    if (typeof path !== 'string' || !path || path === '.' || isAbsolute(path)
        || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) invalid('Factory writable scope must name bounded relative paths');
    queue.push(join(root, ...path.split('/')));
  }
  if (!queue.length) invalid('Factory writer has no authorized paths');
  let count = 0, bytes = 0;
  while (queue.length) {
    const path = queue.pop();
    if (seen.size >= 5000) invalid('Factory writable scope exceeds the directory-entry limit');
    const stats = await lstat(path).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stats || seen.has(path)) continue;
    seen.add(path);
    if (stats.isSymbolicLink()) invalid('Factory writable scope contains a symbolic link');
    const resolved = await realpath(path), rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) invalid('Factory writable scope escapes its project');
    if (stats.isDirectory()) {
      if (EXCLUDED.has(path.split(/[\\/]/).at(-1).toLowerCase())) invalid('Factory writable scope includes a repository cache or build directory');
      for (const entry of await readdir(path)) queue.push(join(path, entry));
    } else if (stats.isFile()) {
      count += 1; bytes += stats.size;
      if (count > MAX_FILES || bytes > MAX_BYTES) invalid('Factory writable scope exceeds the file-count or byte limit');
    } else invalid('Factory writable scope contains an unsupported object');
  }
  for (const location of [MANAGED_WORK_ROOT_DIR, CHAT_COLLABORATIONS_DIR]) {
    const volume = await statfs(location);
    if (Number(volume.bavail) * Number(volume.bsize) < (bytes + MAX_BYTES * 3 + 64 * 1024 * 1024)) {
      invalid('Insufficient storage for Factory staging, evidence and SQLite journal');
    }
  }
  return { fileCount: count, bytes };
}

async function snapshot({ stagingDir, canonicalCwd, writablePaths }, includeBytes = true) {
  // Reuse existing symlink/path validation before reading a single payload.
  await resolveStagingDiff({ stagingDir, canonicalCwd, writablePaths });
  const files = [], queue = ['']; let total = 0;
  while (queue.length) {
    const prefix = queue.pop();
    for (const entry of await readdir(join(stagingDir, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
      const path = prefix ? posix.join(prefix, entry.name) : entry.name;
      const absolute = join(stagingDir, ...path.split('/'));
      if (entry.isSymbolicLink()) invalid('Candidate snapshots do not support symbolic links');
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name.toLowerCase())) invalid('Candidate contains a cache or generated build directory; narrow the authorized scope');
        queue.push(path); continue;
      }
      if (!entry.isFile()) invalid('Candidate contains an unsupported filesystem object');
      const before = await lstat(absolute);
      total += before.size;
      if (total > MAX_BYTES) invalid('Candidate exceeds the snapshot size limit');
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) invalid('Candidate file changed before reading');
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) invalid('Candidate file changed while being read');
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      const after = await lstat(absolute);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid('Candidate changed while being read');
      files.push({ path, digest: sha(bytes), executable: Boolean(before.mode & 0o111), ...(includeBytes ? { bytes: bytes.toString('base64') } : {}) });
      if (files.length > MAX_FILES) invalid('Candidate exceeds the file-count limit');
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  await resolveStagingDiff({ stagingDir, canonicalCwd, writablePaths });
  return files;
}

// The baseline is captured before the outbox can launch a worker. It includes
// pre-existing user changes so they are not mistaken for worker output.
export async function captureFactoryBaseline(context, workspace) {
  const files = await snapshot(workspace, false);
  const identity = { stagingDir: await realpath(workspace.stagingDir), canonicalCwd: await realpath(workspace.canonicalCwd),
    writablePaths: workspace.writablePaths };
  let source;
  try {
    const head = (await git('git', ['-C', identity.canonicalCwd, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true })).stdout.trim();
    const branch = (await git('git', ['-C', identity.canonicalCwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true })).stdout.trim();
    if (!head || !branch) invalid('Factory requires a checked-out Git branch and base HEAD');
    source = { head, branch };
  } catch { invalid('Factory requires a readable Git branch and base HEAD'); }
  const row = { work_item_id: context.workItemId, contract_revision: context.contractRevision,
    execution_epoch: context.executionEpoch, binding_generation: context.bindingGeneration,
    run_id: '', baseline_digest: '', files_json: JSON.stringify({ workspace: identity, source, files }) };
  row.digest = payloadDigest(row);
  await withDatabase((db) => { schema(db);
    const id = `baseline:${context.dispatchKey}`;
    const existing = db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(id);
    if (existing) {
      if (existing.digest !== row.digest || payloadDigest(existing) !== row.digest) invalid('Factory baseline replay conflicts with persisted workspace or content');
      return;
    }
    db.prepare(`INSERT INTO factory_candidate_payloads VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, row.work_item_id, row.contract_revision, row.execution_epoch,
        row.binding_generation, '', '', row.files_json, row.digest, new Date().toISOString()); }, { mutate: true });
  return row.digest;
}

export async function sealFactoryCandidate({ context, workspace, runId }) {
  const run = await getRun(runId);
  if (!run || run.state !== 'completed') invalid('A completed canonical Run is required');
  const files = await snapshot(workspace);
  const identity = { stagingDir: await realpath(workspace.stagingDir), canonicalCwd: await realpath(workspace.canonicalCwd),
    writablePaths: workspace.writablePaths };
  return withDatabase((db) => {
    schema(db);
    const baseline = db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${context.dispatchKey}`);
    if (!baseline || baseline.digest !== payloadDigest(baseline)) invalid('Factory baseline is missing or corrupted');
    let baselinePayload;
    try { baselinePayload = JSON.parse(baseline.files_json); } catch { invalid('Factory baseline is unreadable'); }
    if (JSON.stringify(baselinePayload.workspace) !== JSON.stringify(identity)) invalid('Candidate workspace differs from its baseline');
    const before = new Map(baselinePayload.files.map((file) => [file.path, file]));
    const after = new Map(files.map((file) => [file.path, file]));
    if (files.some((file) => file.executable !== (before.get(file.path)?.executable || false))) invalid('Executable mode changes are not supported by Factory integration');
    const changes = files.filter((file) => before.get(file.path)?.digest !== file.digest).map((file) => ({ ...file, type: before.has(file.path) ? 'modify' : 'add' }));
    for (const file of baselinePayload.files) if (!after.has(file.path)) changes.push({ path: file.path, type: 'delete', digest: '' });
    if (changes.length > MAX_FILES) invalid('Candidate exceeds the changed-file limit; split the task into smaller scopes');
    changes.sort((a, b) => a.path.localeCompare(b.path));
    const existing = db.prepare('SELECT * FROM factory_candidate_payloads WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND run_id=?')
      .get(context.workItemId, context.contractRevision, context.executionEpoch, context.bindingGeneration, runId);
    if (existing) return { candidateId: existing.candidate_id, digest: existing.digest };
    const row = { work_item_id: context.workItemId, contract_revision: context.contractRevision,
      execution_epoch: context.executionEpoch, binding_generation: context.bindingGeneration, run_id: runId,
      baseline_digest: baseline.digest, files_json: JSON.stringify(changes) };
    row.digest = payloadDigest(row);
    const candidateId = `candidate_${randomUUID()}`;
    db.prepare('INSERT INTO factory_candidate_payloads VALUES(?,?,?,?,?,?,?,?,?,?)').run(candidateId, row.work_item_id,
      row.contract_revision, row.execution_epoch, row.binding_generation, runId, row.baseline_digest,
      row.files_json, row.digest, new Date().toISOString());
    return { candidateId, digest: row.digest };
  }, { mutate: true });
}

// Synchronous verifier for the graph's transaction; caller supplies no verdict.
export function verifyFactoryCandidate({ db, binding, item, payload }) {
  schema(db);
  const row = db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(payload?.candidateId);
  if (!row || !['running', 'candidate'].includes(binding.status) || row.work_item_id !== item.id
      || row.contract_revision !== binding.contractRevision || row.execution_epoch !== binding.executionEpoch
      || row.binding_generation !== binding.bindingGeneration || row.run_id !== binding.runId
      || row.digest !== payload.digest || row.digest !== payloadDigest(row)) return null;
  const baseline = db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${binding.dispatchKey}`);
  if (!baseline || baseline.digest !== row.baseline_digest || baseline.digest !== payloadDigest(baseline)
      || baseline.work_item_id !== row.work_item_id || baseline.contract_revision !== row.contract_revision
      || baseline.execution_epoch !== row.execution_epoch || baseline.binding_generation !== row.binding_generation) return null;
  const attempt = db.prepare('SELECT a.state,a.run_id,a.result_packet_id FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id WHERE a.id=? AND t.collaboration_id=?')
    .get(binding.attemptId, binding.collaborationId);
  if (!attempt || attempt.state !== 'succeeded' || attempt.run_id !== row.run_id || !attempt.result_packet_id) return null;
  let files;
  try { files = JSON.parse(row.files_json); } catch { return null; }
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some((file) => typeof file.path !== 'string'
      || !['add', 'modify', 'delete'].includes(file.type)
      || (file.type === 'delete' ? file.digest !== '' || file.bytes !== undefined
        : typeof file.bytes !== 'string' || sha(Buffer.from(file.bytes, 'base64')) !== file.digest))) return null;
  return { candidateId: row.candidate_id, digest: row.digest, baselineDigest: row.baseline_digest,
    runId: row.run_id, terminalEvidenceRef: `run:${row.run_id}`, resultPacketId: attempt.result_packet_id,
    files: files.map(({ path, digest, type }) => ({ path, digest, type })) };
}
