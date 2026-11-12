// Root-controlled launch record. Call registration only from the lifecycle
// broker for a unit it just launched; a matching existing unit is not proof of
// provenance. Neither this store nor its revocation marker is wired to the
// production launch/cancellation paths yet.
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { posix as path } from 'node:path';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';
import { verifyLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { resolveApprovedActionRunDirectories } from '../chat/approved-action-run-directories.mjs';
import { loadLinuxServiceKeyPin } from './linux-service-key-pin.mjs';
import { captureLinuxRunUnitIdentity, isLinuxRunUnitLive } from './linux-run-unit-liveness.mjs';

const RUN_ID = /^run_[A-Za-z0-9_-]{8,128}$/;
const MAX_RECORD_BYTES = 256 * 1024;
function unavailable() { throw Object.assign(new Error('Trusted Run context is unavailable'), { code: 'LINUX_RUN_CONTEXT_UNAVAILABLE' }); }
function validateId(runId, launchAttempt) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || !Number.isSafeInteger(launchAttempt) ||
      launchAttempt < 0 || launchAttempt > 10000) unavailable();
}
async function validateDirectory(directory) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || typeof directory !== 'string' ||
      !directory.startsWith('/') || directory === '/' || directory.endsWith('/') || path.normalize(directory) !== directory) unavailable();
  await assertLinuxRootControlledDirectory(directory);
  const stat = await lstat(directory);
  if ((stat.mode & 0o7777) !== 0o700) unavailable();
}
function recordPaths(directory, runId, launchAttempt) {
  validateId(runId, launchAttempt);
  const hash = createHash('sha256').update(runId, 'utf8').digest('hex');
  const base = path.join(directory, `${hash}-${launchAttempt}`);
  return { record: `${base}.json`, revoked: `${base}.revoked`, renewalLock: `${base}.renew.lock` };
}
async function createRecord(filePath, text, directory) {
  const file = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chown(0, 0); await file.chmod(0o600);
    await file.writeFile(text, 'utf8'); await file.sync();
  } finally { await file.close(); }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readRecord(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > MAX_RECORD_BYTES) unavailable();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
async function assertNotRevoked(filePath) {
  try { await lstat(filePath); unavailable(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function minimalRunAndManifest(run, manifest) {
  // Never persist the approved-action channel token or other manifest secrets.
  const publication = { version: run?.runPublication?.version, publicationId: run?.runPublication?.publicationId };
  const minimalRun = { id: run?.id, sessionId: run?.sessionId, requestId: run?.requestId, runPublication: publication };
  const minimalManifest = { id: manifest?.id, sessionId: manifest?.sessionId, requestId: manifest?.requestId,
    runPublication: manifest?.runPublication, executionScope: manifest?.executionScope,
    executionScopeDigest: manifest?.executionScopeDigest,
    options: { approvedActionChannel: { turnId: manifest?.options?.approvedActionChannel?.turnId } } };
  return JSON.parse(JSON.stringify({ run: minimalRun, manifest: minimalManifest }));
}

export async function registerLinuxRunContext({ directory, pinDirectory, run, manifest, grant, launchAttempt } = {}) {
  await validateDirectory(directory);
  const saved = minimalRunAndManifest(run, manifest);
  const paths = recordPaths(directory, saved.run.id, launchAttempt);
  await assertNotRevoked(paths.revoked);
  const { publicKey } = await loadLinuxServiceKeyPin(pinDirectory);
  if (!verifyLinuxRunScopeGrant(grant, { ...saved, launchAttempt, publicKey }).ok) unavailable();
  const directories = resolveApprovedActionRunDirectories({ ...saved, session: {}, platform: 'linux' });
  const unit = await captureLinuxRunUnitIdentity({ runId: saved.run.id, launchAttempt });
  if (!unit) unavailable();
  const record = { version: 1, ...saved, grant, unit, directories };
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) unavailable();
  await createRecord(paths.record, text, directory);
  return { runId: saved.run.id, launchAttempt, invocationId: unit.invocationId };
}

export async function revokeLinuxRunContext({ directory, runId, launchAttempt } = {}) {
  await validateDirectory(directory);
  const paths = recordPaths(directory, runId, launchAttempt);
  try { await createRecord(paths.revoked, '{"version":1}\n', directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // An earlier caller may have created the marker but failed before syncing.
    // Re-sync it before reporting a durable, idempotent revocation.
    const file = await open(paths.revoked, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) unavailable();
      await file.sync();
    } finally { await file.close(); }
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

// Extend a still-live, non-revoked record without changing its signed scope or
// systemd invocation. A crash can leave the exclusive lock in place; recovery
// must explicitly investigate it rather than silently allow concurrent writes.
export async function renewLinuxRunContext({ directory, pinDirectory, runId, launchAttempt, grant } = {}) {
  await validateDirectory(directory);
  const paths = recordPaths(directory, runId, launchAttempt);
  const lock = await open(paths.renewalLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let temporary = '';
  try {
    await lock.chown(0, 0); await lock.chmod(0o600); await lock.sync();
    await assertNotRevoked(paths.revoked);
    const current = await readRecord(paths.record);
    const { publicKey } = await loadLinuxServiceKeyPin(pinDirectory);
    if (current?.version !== 1 || current.run?.id !== runId || current.unit?.runId !== runId ||
        current.unit?.launchAttempt !== launchAttempt ||
        !verifyLinuxRunScopeGrant(current.grant, { run: current.run, manifest: current.manifest, launchAttempt, publicKey }).ok ||
        !verifyLinuxRunScopeGrant(grant, { run: current.run, manifest: current.manifest, launchAttempt, publicKey }).ok ||
        Date.parse(grant.issuedAt) < Date.parse(current.grant.issuedAt) ||
        Date.parse(grant.expiresAt) <= Date.parse(current.grant.expiresAt) ||
        !await isLinuxRunUnitLive(current.unit)) unavailable();
    const directories = resolveApprovedActionRunDirectories({ run: current.run, manifest: current.manifest, session: {}, platform: 'linux' });
    if (directories.cwd !== current.directories?.cwd || directories.projectRoot !== current.directories?.projectRoot) unavailable();
    const text = `${JSON.stringify({ ...current, grant })}\n`;
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) unavailable();
    temporary = `${paths.record}.${randomBytes(16).toString('hex')}.tmp`;
    await createRecord(temporary, text, directory);
    await assertNotRevoked(paths.revoked);
    await rename(temporary, paths.record);
    temporary = '';
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
    await assertNotRevoked(paths.revoked);
  } finally {
    await lock.close();
    if (temporary) await unlink(temporary).catch(() => {});
    await unlink(paths.renewalLock);
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

export async function readLinuxRunContext({ directory, pinDirectory, runId, launchAttempt } = {}) {
  try {
    await validateDirectory(directory);
    const paths = recordPaths(directory, runId, launchAttempt);
    await assertNotRevoked(paths.revoked);
    const record = await readRecord(paths.record);
    const { publicKey } = await loadLinuxServiceKeyPin(pinDirectory);
    if (record?.version !== 1 || record.run?.id !== runId || record.unit?.runId !== runId ||
        record.unit?.launchAttempt !== launchAttempt ||
        !verifyLinuxRunScopeGrant(record.grant, { run: record.run, manifest: record.manifest, launchAttempt, publicKey }).ok) unavailable();
    const directories = resolveApprovedActionRunDirectories({ run: record.run, manifest: record.manifest, session: {}, platform: 'linux' });
    if (directories.cwd !== record.directories?.cwd || directories.projectRoot !== record.directories?.projectRoot ||
        !await isLinuxRunUnitLive(record.unit)) unavailable();
    await assertNotRevoked(paths.revoked);
    return { runId, sessionId: record.run.sessionId, turnId: record.run.requestId, launchAttempt,
      invocationId: record.unit.invocationId, ...directories };
  } catch { return null; }
}
