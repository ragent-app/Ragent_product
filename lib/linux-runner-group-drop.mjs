// Building block for a future systemd launcher that starts a fixed trusted
// setpriv executable as root and drops to the Run identity before Node starts.
// This module does not authorize a Run or select which groups are safe; the
// caller must resolve and validate the permitted numeric IDs first.
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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
    args: ['--reuid', String(uid), '--regid', String(gid),
      ...(groups.length ? ['--groups', groups.join(',')] : ['--clear-groups']),
      '--', command, ...args],
  };
}
