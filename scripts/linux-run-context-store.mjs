// Root-controlled launch record. Call registration only from the lifecycle
// broker for a unit it just launched; a matching existing unit is not proof of
// provenance. Neither this store nor its revocation marker is wired to the
// production launch/cancellation paths yet.
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, statfs, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { posix as path } from 'node:path';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';
import { verifyLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { resolveApprovedActionRunDirectories } from '../chat/approved-action-run-directories.mjs';
import { loadLinuxServiceKeyPin } from './linux-service-key-pin.mjs';
import { captureLinuxRunUnitIdentity, isLinuxRunUnitLive, linuxRunUnitName } from './linux-run-unit-liveness.mjs';
import { isLinuxRunPeerLive } from './linux-run-peer-identity.mjs';
import { withLinuxRunOperationLock } from './linux-run-operation-lock.mjs';

const RUN_ID = /^run_[A-Za-z0-9_-]{8,128}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);
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
  return { record: `${base}.json`, revoked: `${base}.revoked` };
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

export async function registerLinuxRunContext({ directory, pinDirectory, run, manifest, grant, launchAttempt, runnerUid } = {}) {
  await validateDirectory(directory);
  const saved = minimalRunAndManifest(run, manifest);
  const paths = recordPaths(directory, saved.run.id, launchAttempt);
  await assertNotRevoked(paths.revoked);
  const { publicKey } = await loadLinuxServiceKeyPin(pinDirectory);
  if (!verifyLinuxRunScopeGrant(grant, { ...saved, launchAttempt, publicKey }).ok) unavailable();
  const directories = resolveApprovedActionRunDirectories({ ...saved, session: {}, platform: 'linux' });
  let unit = null;
  // A group-dropping launcher may still be transitioning from root immediately
  // after systemd reports MainPID. Never register until it reaches the fixed UID.
  for (let i = 0; i < 20 && !unit; i++) {
    unit = await captureLinuxRunUnitIdentity({ runId: saved.run.id, launchAttempt, runnerUid });
    if (!unit && i < 19) await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  // Marker first prevents later operations. Acquiring the same lock then
  // waits for any operation that had already begun before acknowledging.
  await withLinuxRunOperationLock({ directory, runId, launchAttempt }, async () => {});
}

// Root-only evidence for cancellation recovery. A revocation prevents new
// privileged operations but does not itself stop the provider. Before the
// control service can publish a cancellation without a runner result, verify
// that the exact registered systemd invocation has stopped and its cgroup is
// empty. An unknown state, different invocation or non-cgroup-v2 host fails
// closed. This endpoint neither stops a unit nor grants execution authority.
export async function confirmRevokedLinuxRunStopped({ directory, runId, launchAttempt } = {}) {
  await validateDirectory(directory);
  const paths = recordPaths(directory, runId, launchAttempt);
  const unitName = linuxRunUnitName(runId, launchAttempt);
  return withLinuxRunOperationLock({ directory, runId, launchAttempt }, async () => {
    const marker = await readRecord(paths.revoked);
    const record = await readRecord(paths.record);
    const identity = record?.unit;
    if (Object.keys(marker).join(',') !== 'version' || marker.version !== 1 || record?.version !== 1 ||
        record.run?.id !== runId || identity?.runId !== runId || identity?.launchAttempt !== launchAttempt ||
        typeof identity.invocationId !== 'string' || !/^[a-f0-9]{32}$/.test(identity.invocationId) ||
        /^0+$/.test(identity.invocationId)) unavailable();
    const fields = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'ControlPID', 'InvocationID', 'ControlGroup'];
    const args = ['show', ...fields.map(field => `--property=${field}`), '--', unitName];
    const options = { timeout: 5000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
    const inspect = async () => {
      const { stdout } = await execFileAsync('/usr/bin/systemctl', args, options);
      const values = Object.create(null);
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const index = line.indexOf('=');
        const key = line.slice(0, index);
        if (index < 1 || !fields.includes(key) || Object.hasOwn(values, key)) unavailable();
        values[key] = line.slice(index + 1);
      }
      if (!fields.every(key => Object.hasOwn(values, key)) || values.Id !== unitName ||
          !['loaded', 'not-found'].includes(values.LoadState) || !['inactive', 'failed'].includes(values.ActiveState) ||
          values.MainPID !== '0' || values.ControlPID !== '0') unavailable();
      if (values.LoadState === 'loaded' && values.InvocationID !== identity.invocationId) unavailable();
      if (values.LoadState === 'not-found' && values.ActiveState !== 'inactive') unavailable();
      const expectedGroup = `/agentoc.slice/agentoc-runners.slice/${unitName}`;
      if (values.ControlGroup && values.ControlGroup !== expectedGroup) unavailable();
      return stdout;
    };
    const first = await inspect();
    // cgroup.events reports descendants too; unlike cgroup.procs it cannot
    // miss a child cgroup. The filesystem itself must be kernel cgroup v2.
    if ((await statfs('/sys/fs/cgroup', { bigint: true })).type !== 0x63677270n) unavailable();
    const eventsPath = `/sys/fs/cgroup/agentoc.slice/agentoc-runners.slice/${unitName}/cgroup.events`;
    let events;
    try { events = await readFile(eventsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (events !== undefined) {
      const populated = events.split('\n').filter(line => line.startsWith('populated '));
      if (populated.length !== 1 || populated[0] !== 'populated 0') unavailable();
    }
    if (await inspect() !== first) unavailable();
    return { stopped: true };
  });
}

// Extend a still-live, non-revoked record without changing its signed scope or
// systemd invocation. Use the same crash-released lock as execution and
// revocation: a dead broker must not leave a permanent renewal lock behind.
export async function renewLinuxRunContext({ directory, pinDirectory, runId, launchAttempt, grant } = {}) {
  await validateDirectory(directory);
  const paths = recordPaths(directory, runId, launchAttempt);
  return withLinuxRunOperationLock({ directory, runId, launchAttempt }, async () => {
    let temporary = '';
    try {
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
      if (temporary) await unlink(temporary).catch(() => {});
    }
  });
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

// Internal primitive for a future root-mediated Run channel. The caller must
// obtain `peer` from SO_PEERCRED on the accepted socket and validate every
// request payload; a request-supplied identity is never acceptable. Holding
// the operation lock makes revocation wait for a callback already admitted.
export async function withLinuxRunPeerContext({ directory, pinDirectory, runId, launchAttempt, peer } = {}, action) {
  if (typeof action !== 'function') unavailable();
  await validateDirectory(directory);
  const paths = recordPaths(directory, runId, launchAttempt);
  return withLinuxRunOperationLock({ directory, runId, launchAttempt }, async () => {
    const context = await readLinuxRunContext({ directory, pinDirectory, runId, launchAttempt });
    if (!context) unavailable();
    const record = await readRecord(paths.record);
    if (!await isLinuxRunPeerLive(record.unit, peer)) unavailable();
    await assertNotRevoked(paths.revoked);
    return action(context);
  });
}
