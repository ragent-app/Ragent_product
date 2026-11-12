// Root-only result staging for a future per-Run socket. Not exposed by the
// product yet: callers must authenticate the reader and obtain the writer's
// identity directly from the accepted socket's SO_PEERCRED.
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { posix as path } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';
import { withLinuxRunOperationLock } from './linux-run-operation-lock.mjs';
import { withLinuxRunPeerContext } from './linux-run-context-store.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
function fail(code = 'LINUX_RUN_RESULT_STORE_UNAVAILABLE') {
  throw Object.assign(new Error('Protected Run result unavailable'), { code });
}
function name(runId, attempt, suffix) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) fail();
  return `${createHash('sha256').update(runId).digest('hex')}-${attempt}.${suffix}`;
}
async function validateDirectory(directory) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || typeof directory !== 'string' ||
      !directory.startsWith('/') || directory === '/' || directory.endsWith('/') || path.normalize(directory) !== directory) fail();
  await assertLinuxRootControlledDirectory(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o7777) !== 0o700 || (await statfs(directory, { bigint: true })).type !== 0xef53n) fail();
}
async function readChecked(filename, max) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600 || info.size < 1 || info.size > max) fail();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
function validRecord(record, runId, attempt) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).sort().join(',') === 'invocationId,launchAttempt,result,runId,sessionId,turnId,version' &&
    record.version === 1 && record.runId === runId && record.launchAttempt === attempt &&
    typeof record.sessionId === 'string' && record.sessionId.length > 0 && record.sessionId.length <= 256 &&
    typeof record.turnId === 'string' && record.turnId.length > 0 && record.turnId.length <= 256 &&
    typeof record.invocationId === 'string' && /^[a-f0-9]{32}$/.test(record.invocationId) &&
    record.result && typeof record.result === 'object' && !Array.isArray(record.result);
}
async function syncDirectory(directory) {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
async function cleanupTemporary(directory, target) {
  const prefix = `${path.basename(target)}.`;
  const names = (await readdir(directory)).filter(item => item.startsWith(prefix) && /^[a-f0-9]{32}\.tmp$/.test(item.slice(prefix.length)));
  for (const item of names) {
    const filename = path.join(directory, item), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600) fail();
    await unlink(filename);
  }
  if (names.length) await syncDirectory(directory);
}

export async function stageLinuxRunPeerResult({ directory, pinDirectory, resultDirectory,
  runId, launchAttempt, peer, result } = {}) {
  await validateDirectory(resultDirectory);
  const target = path.join(resultDirectory, name(runId, launchAttempt, 'peer-result.json'));
  let normalized;
  try {
    const encoded = JSON.stringify(result);
    if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_BYTES - 4096) fail();
    normalized = JSON.parse(encoded);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) fail();
  } catch { fail(); }
  return withLinuxRunPeerContext({ directory, pinDirectory, runId, launchAttempt, peer }, async context => {
    await cleanupTemporary(resultDirectory, target);
    const record = { version: 1, runId, launchAttempt, sessionId: context.sessionId, turnId: context.turnId,
      invocationId: context.invocationId, result: normalized };
    if (!validRecord(record, runId, launchAttempt)) fail();
    try {
      const existing = await readChecked(target, MAX_BYTES);
      if (!validRecord(existing, runId, launchAttempt) || !isDeepStrictEqual(existing, record)) fail('LINUX_RUN_RESULT_CONFLICT');
      // A previous write can have reached rename but failed before directory
      // sync; retry must make that publication durable before acknowledging.
      await syncDirectory(resultDirectory);
      return { staged: true, duplicate: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const data = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) fail();
    const temporary = `${target}.${randomBytes(16).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.chown(0, 0); await file.chmod(0o600);
      await file.writeFile(data, 'utf8'); await file.sync(); await file.close(); file = null;
      // All writers for a Run hold the root-owned cross-process operation lock.
      await rename(temporary, target);
      await syncDirectory(resultDirectory);
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { staged: true, duplicate: false };
  });
}

// Root callers must independently authenticate the control service and apply
// cancellation policy. Acquiring the same operation lock after the marker is
// present forms the revocation barrier before a result may be observed.
export async function readRevokedLinuxRunPeerResult({ directory, resultDirectory, runId, launchAttempt } = {}) {
  await validateDirectory(resultDirectory);
  const target = path.join(resultDirectory, name(runId, launchAttempt, 'peer-result.json'));
  const revoked = path.join(directory, name(runId, launchAttempt, 'revoked'));
  return withLinuxRunOperationLock({ directory, runId, launchAttempt }, async () => {
    const marker = await readChecked(revoked, 1024);
    if (!marker || Object.keys(marker).join(',') !== 'version' || marker.version !== 1) fail();
    await cleanupTemporary(resultDirectory, target);
    let record;
    try { record = await readChecked(target, MAX_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!validRecord(record, runId, launchAttempt)) fail();
    return record;
  });
}
