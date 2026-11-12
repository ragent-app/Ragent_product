// Apply a narrowly scoped ACL to an open, unpublished Run file. The caller
// chooses the authorized numeric UID and keeps the file private until rename.
import { constants, lstatSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';

const SETFACL = '/usr/bin/setfacl';
const execFileAsync = promisify(execFile);

/** Resolve the other local principal only in explicitly separate-user mode. */
export async function resolveRunFilePeerUid(runDirectory, {
  environment = process.env, currentUid = process.getuid?.(),
  statImpl = lstat, readFileImpl = readFile, execFileImpl = execFileAsync,
} = {}) {
  if (process.platform !== 'linux') return null;
  const fail = () => Object.assign(new Error('Cannot verify runner file identity'), { code:'RUNNER_FILE_ACCESS_INVALID' });
  const valid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xfffffffe;
  if (environment.AGENTOC_RUNNER_DISTINCT_IDENTITY === '1') {
    const info = await statImpl(runDirectory).catch(() => { throw fail(); });
    if (!info.isDirectory() || info.isSymbolicLink() || !valid(info.uid) || !valid(currentUid)
        || info.uid === currentUid) throw fail();
    return info.uid;
  }
  if (String(environment.AGENTOC_RUNNER_SAME_USER ?? '1').trim() !== '0') return null;
  const explicitName = String(environment.AGENTOC_RUNNER_USER || '').trim();
  let name = explicitName;
  if (!name) {
    const configuredPath = String(environment.AGENTOC_RUNNER_USER_FILE || '/etc/agentoc/runner-user');
    if (!isAbsolute(configuredPath) || configuredPath.includes('\0')) throw fail();
    const path = resolve(configuredPath);
    try {
      const parents = [];
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        parents.push(parent);
        if (parent === dirname(parent)) break;
      }
      for (const item of [...parents, path]) {
        const info = await statImpl(item);
        if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0
            || (item === path ? !info.isFile() : !info.isDirectory())) throw fail();
      }
      name = String(await readFileImpl(path, 'utf8')).split(/\r?\n/, 1)[0].trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fail();
      name = 'agentoc-runner';
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(name)) throw fail();
  if (!isTrustedSystemBinary('/usr/bin/getent')) throw fail();
  const readUid = async (account) => {
    let result;
    try { result = await execFileImpl('/usr/bin/getent', ['passwd', account], { timeout:2_000, maxBuffer:16 * 1024 }); }
    catch { throw fail(); }
    const fields = String(result.stdout || '').trim().split(':');
    if (fields[0] !== account || !/^\d+$/.test(fields[2] || '')) throw fail();
    const uid = Number(fields[2]);
    if (!valid(uid)) throw fail();
    return uid;
  };
  let uid = await readUid(name);
  // Older installs wrote the control user into runner-user. In explicit
  // separate-user mode that stale default must not suppress the runner ACL.
  if (uid === currentUid && !explicitName && name !== 'agentoc-runner') uid = await readUid('agentoc-runner');
  if (uid === currentUid) throw fail();
  return uid;
}

function isTrustedSystemBinary(binary, { stat = lstatSync } = {}) {
  try {
    return [['/', true], ['/usr', true], ['/usr/bin', true], [binary, false]].every(([path, directory]) => {
      const entry = stat(path);
      return !entry.isSymbolicLink() && entry.uid === 0 && (entry.mode & 0o022) === 0
        && (directory ? entry.isDirectory() : entry.isFile());
    });
  } catch { return false; }
}

export function isTrustedSetfacl(options = {}) { return isTrustedSystemBinary(SETFACL, options); }

/** Grant exactly one non-root UID access to an open regular file descriptor. */
export async function grantRunnerFileAccess(handle, uid, { writable = false, spawnImpl = spawn, trusted = isTrustedSetfacl } = {}) {
  const fail = () => Object.assign(new Error('Cannot establish runner file access'), { code: 'RUNNER_FILE_ACCESS_INVALID' });
  if (process.platform !== 'linux' || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xfffffffe
      || !Number.isSafeInteger(handle?.fd) || handle.fd < 0 || typeof handle.stat !== 'function' || !trusted()) throw fail();
  const entry = await handle.stat().catch(() => { throw fail(); });
  if (!entry.isFile()) throw fail();
  const mode = writable ? 'rw-' : 'r--';
  // Replace inherited ACLs, granting neither the owning group nor other users
  // access. Passing the already-open descriptor prevents pathname substitution.
  const acl = `u::rw-,u:${uid}:${mode},g::---,m::${mode},o::---`;
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(SETFACL, ['--set', acl, '--', '/proc/self/fd/3'], {
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        signal: AbortSignal.timeout(2_000),
      });
    } catch { reject(fail()); return; }
    child.once('error', () => reject(fail()));
    child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(fail()));
  });
}

/** Repair only the known inputs of one inactive Run created before ACL support. */
export async function grantExistingRunnerFiles(runDirectory, { controlUid, runnerUid } = {}) {
  const fail = () => Object.assign(new Error('Cannot verify existing runner inputs'), { code:'RUNNER_FILE_ACCESS_INVALID' });
  const valid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xfffffffe;
  if (process.platform !== 'linux' || !valid(controlUid) || !valid(runnerUid) || controlUid === runnerUid) throw fail();
  let dir;
  try {
    dir = await open(runDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await dir.stat();
    if (!info.isDirectory() || info.uid !== controlUid) throw fail();
    for (const [name, required, writable] of [
      ['status.json', true, false], ['manifest.json', true, false],
      ['auth-recovery.cap', false, false], ['browser.cap', false, false],
      ['session-control.cap', false, false], ['session-control-renewal.cap', false, false],
    ]) {
      let file;
      try {
        file = await open(`/proc/self/fd/${dir.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        const entry = await file.stat();
        if (!entry.isFile() || entry.nlink !== 1 || ![controlUid, runnerUid].includes(entry.uid)) throw fail();
        await grantRunnerFileAccess(file, entry.uid === controlUid ? runnerUid : controlUid, { writable });
      } catch (error) {
        if (!(error?.code === 'ENOENT' && !required)) throw fail();
      } finally { await file?.close(); }
    }
  } catch { throw fail(); }
  finally { await dir?.close(); }
}
