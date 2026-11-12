// Cross-process serialization for all generations of one root-controlled Run. Lock
// files must never be unlinked while the installation is active. Linux flock
// locks the open file description: the helper inherits a duplicate of that
// descriptor so a parent crash cannot release the lock before the helper exits.
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { posix as path } from 'node:path';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';

function fail() { throw Object.assign(new Error('Run operation lock unavailable'), { code: 'LINUX_RUN_LOCK_UNAVAILABLE' }); }

async function acquire(fd) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '8', '3'],
      { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', fd] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (!timedOut && code === 0 && !signal) resolve(); else reject(new Error('flock failed')); });
  });
}

export async function withLinuxRunOperationLock({ directory, runId, launchAttempt } = {}, action) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || typeof action !== 'function' ||
      typeof directory !== 'string' || !directory.startsWith('/') || directory === '/' ||
      directory.endsWith('/') || path.normalize(directory) !== directory ||
      typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(launchAttempt) || launchAttempt < 0 || launchAttempt > 10000) fail();
  await assertLinuxRootControlledDirectory(directory);
  const dirStat = await lstat(directory);
  if ((dirStat.mode & 0o7777) !== 0o700 || (await statfs(directory, { bigint: true })).type !== 0xef53n) fail();
  await assertLinuxRootControlledDirectory('/usr/bin');
  const binary = await lstat('/usr/bin/flock');
  if (!binary.isFile() || binary.isSymbolicLink() || binary.uid !== 0 || binary.gid !== 0 ||
      binary.nlink !== 1 || (binary.mode & 0o022) || !(binary.mode & 0o100)) fail();
  const hash = createHash('sha256').update(runId, 'utf8').digest('hex');
  // Revocation intent applies to the whole Run. A new generation must not
  // execute concurrently while an earlier generation's revocation is waiting.
  const filename = path.join(directory, `${hash}.operation.lock`);
  let file;
  try {
    try {
      file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.chown(0, 0); await file.chmod(0o600); await file.sync();
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      if (file || error.code !== 'EEXIST') throw error;
      file = await open(filename, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) fail();
    await acquire(file.fd);
    return await action(file.fd);
  } finally { if (file) await file.close(); }
}
