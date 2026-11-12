// Control-plane cancellation intent. The config directory must be masked
// from the runner namespace; processes with equivalent access to the control
// service account remain in the trust base. Markers are deliberately retained.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';

const DIRECTORY = join(CONFIG_DIR, 'linux-run-cancel-intents');
function fail() { throw Object.assign(new Error('Linux cancellation intent store is unavailable'), { code: 'LINUX_CANCEL_INTENT_UNAVAILABLE' }); }
function marker(runId, launchAttempt) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(launchAttempt) || launchAttempt < 0 || launchAttempt > 10000) fail();
  // Cancellation is irreversible for the Run, including any launch attempt
  // racing with it; a new attempt must not escape an earlier intent.
  return join(DIRECTORY, `${createHash('sha256').update(runId, 'utf8').digest('hex')}.json`);
}
async function verifyDirectory(directory, mode) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o022) || (mode !== null && (stat.mode & 0o7777) !== mode) || await realpath(directory) !== resolve(directory)) fail();
}
async function syncDirectory(directory) {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function ensureLinuxRunCancelIntentStore() {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function') fail();
  await verifyDirectory(CONFIG_DIR, null);
  try { await mkdir(DIRECTORY, { mode: 0o700 }); await syncDirectory(CONFIG_DIR); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await verifyDirectory(DIRECTORY, 0o700);
}
export async function hasLinuxRunCancelIntent(runId, launchAttempt) {
  await verifyDirectory(CONFIG_DIR, null);
  await verifyDirectory(DIRECTORY, 0o700);
  try { await lstat(marker(runId, launchAttempt)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function persistLinuxRunCancelIntent(runId, launchAttempt) {
  await ensureLinuxRunCancelIntentStore();
  const filename = marker(runId, launchAttempt);
  let file;
  try {
    try { file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) fail();
      await file.sync();
      return;
    }
    await file.chmod(0o600);
    await file.writeFile('{"version":1}\n', 'utf8');
    await file.sync();
  } finally {
    if (file) await file.close();
    await syncDirectory(DIRECTORY);
  }
}
