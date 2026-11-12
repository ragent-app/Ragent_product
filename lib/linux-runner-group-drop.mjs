// The experimental systemd launcher starts this fixed trusted setpriv
// executable as root and drops to the Run identity before Node starts.
// This module does not authorize a Run or select which groups are safe; the
// caller must resolve and validate the permitted numeric IDs first.
import { lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RUNNER_DENIED_GROUPS } from './runner-user-groups.mjs';

const execFileAsync = promisify(execFile);

export const TRUSTED_SETPRIV_PATH = '/usr/bin/setpriv';

export function isTrustedSetpriv({ stat = lstatSync } = {}) {
  try {
    for (const [path, directory] of [['/', true], ['/usr', true], ['/usr/bin', true], [TRUSTED_SETPRIV_PATH, false]]) {
      const entry = stat(path);
      if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0
          || (directory ? !entry.isDirectory() : !entry.isFile())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 0xfffffffe;
}

async function lookupGroupId(name, { execFileImpl, optional }) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl('/usr/bin/getent', ['group', name], { timeout: 2_000, maxBuffer: 16 * 1024 }));
  } catch (error) {
    if (optional && error?.code === 2) return null;
    throw Object.assign(new Error('Cannot verify runner group identity'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  const fields = String(stdout || '').trim().split(':');
  if (fields.length < 3 || fields[0] !== name || !/^\d+$/.test(fields[2])
      || !Number.isSafeInteger(Number(fields[2])) || Number(fields[2]) > 0xfffffffe) {
    throw Object.assign(new Error('Cannot verify runner group identity'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  return Number(fields[2]);
}

export async function resolveRestrictedRunnerGroupIds({ execFileImpl = execFileAsync } = {}) {
  const ids = await Promise.all([...new Set(RUNNER_DENIED_GROUPS)].map(name => lookupGroupId(name, { execFileImpl, optional: true })));
  const restricted = new Set(ids.filter(id => id !== null));
  if (!restricted.has(0)) throw Object.assign(new Error('Cannot verify root group identity'), { code: 'RUNNER_IDENTITY_INVALID' });
  return restricted;
}

/** Resolve every group by name, then reject restricted IDs, including aliases. */
export async function resolveAllowedRunnerGroupIds(groups, { restrictedIds, execFileImpl = execFileAsync } = {}) {
  if (!Array.isArray(groups) || !(restrictedIds instanceof Set) || !restrictedIds.has(0)
      || groups.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(name))) {
    throw Object.assign(new Error('Invalid runner group selection'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  const names = [...new Set(groups)];
  const ids = await Promise.all(names.map(name => lookupGroupId(name, { execFileImpl, optional: false })));
  if (ids.some(id => !validId(id) || restrictedIds.has(id))) {
    throw Object.assign(new Error('Runner group selection includes a restricted group'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Refuse to reuse a privileged-wrapper unit until its process has dropped privileges. */
export async function verifyDroppedRunnerProcess(pid, { uid, gid, restrictedIds, readFileImpl = readFile } = {}) {
  const fail = () => { throw Object.assign(new Error('Cannot verify dropped runner process identity'), { code: 'RUNNER_IDENTITY_INVALID' }); };
  if (!Number.isSafeInteger(pid) || pid <= 0 || !validId(uid) || !validId(gid)
      || !(restrictedIds instanceof Set) || !restrictedIds.has(0)) fail();
  let status;
  try { status = await readFileImpl(`/proc/${pid}/status`, 'utf8'); } catch { fail(); }
  const line = name => String(status).split(/\r?\n/).find(item => item.startsWith(`${name}:`))?.split(':', 2)[1]?.trim();
  const parse = value => typeof value === 'string' && value && value.split(/\s+/).every(x => /^\d+$/.test(x))
    ? value.split(/\s+/).map(Number) : null;
  const uids = parse(line('Uid'));
  const gids = parse(line('Gid'));
  const groupLine = line('Groups');
  const groups = groupLine === '' ? [] : parse(groupLine);
  // UID changes normally clear these capabilities, but an inherited securebits
  // configuration must not let a reused runner retain privilege silently.
  const capsDropped = ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].every(name => {
    const value = line(name);
    return typeof value === 'string' && /^0+$/.test(value);
  });
  if (!uids || uids.length !== 4 || uids.some(id => id !== uid)
      || !gids || gids.length !== 4 || gids.some(id => id !== gid)
      || !groups || groups.some(id => !Number.isSafeInteger(id) || restrictedIds.has(id))
      || !capsDropped) fail();
  return true;
}

/** Construct an argv-only privilege drop. Group authorization is external. */
export function buildRunnerGroupDropCommand({ uid, gid, supplementaryGids = [], command, args = [] } = {}) {
  if (!validId(uid) || !validId(gid) || !Array.isArray(supplementaryGids)
      || supplementaryGids.some(id => !validId(id))
      || typeof command !== 'string' || !isAbsolute(command) || command.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw Object.assign(new Error('Invalid runner privilege-drop parameters'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  const groups = [...new Set(supplementaryGids)].sort((a, b) => a - b);
  return {
    command: TRUSTED_SETPRIV_PATH,
    args: ['--inh-caps=-all', '--ambient-caps=-all', '--reuid', String(uid), '--regid', String(gid),
      ...(groups.length ? ['--groups', groups.join(',')] : ['--clear-groups']),
      '--', command, ...args],
  };
}
