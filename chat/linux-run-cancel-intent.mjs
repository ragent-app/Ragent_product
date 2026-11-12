// Control-plane cancellation intent. The config directory must be masked
// from the runner namespace; processes with equivalent access to the control
// service account remain in the trust base. Markers are deliberately retained.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
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
function outboxPath(runId, launchAttempt) {
  marker(runId, launchAttempt); // validates both fields
  return join(DIRECTORY, `${createHash('sha256').update(runId, 'utf8').digest('hex')}-${launchAttempt}.revoke.json`);
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
async function persistRecord(filename, value) {
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
  let file;
  try {
    try {
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024) fail();
      if (await file.readFile('utf8') !== value) fail();
      await file.sync();
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
    await file.writeFile(value, 'utf8');
    await file.sync();
    await file.close(); file = null;
    // The directory is private to the control UID. Concurrent writers for
    // this deterministic name publish identical bytes by atomic replacement.
    await rename(temporary, filename);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await syncDirectory(DIRECTORY);
  }
}

export async function persistLinuxRunCancelIntent(runId, launchAttempt) {
  await ensureLinuxRunCancelIntentStore();
  // Preserve a recoverable root notification before publishing the intent or
  // any runner-writable status. This file contains identifiers, never tokens.
  await persistRecord(outboxPath(runId, launchAttempt), `${JSON.stringify({ version: 1, runId, launchAttempt })}\n`);
  await persistRecord(marker(runId, launchAttempt), '{"version":1}\n');
}

// Read only strict, owner-protected outbox records. Malformed or partial
// records remain on disk for diagnosis and are never treated as authorization.
export async function listLinuxRunRevocationOutbox() {
  await ensureLinuxRunCancelIntentStore();
  const names = (await readdir(DIRECTORY)).filter((name) => /^[a-f0-9]{64}-(?:0|[1-9][0-9]{0,4})\.revoke\.json$/.test(name)).sort();
  const records = [];
  let invalid = 0;
  for (const name of names) {
    let file;
    try {
      file = await open(join(DIRECTORY, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 1024) fail();
      const value = JSON.parse(await file.readFile('utf8'));
      if (!value || Object.keys(value).sort().join(',') !== 'launchAttempt,runId,version' || value.version !== 1 ||
          outboxPath(value.runId, value.launchAttempt) !== join(DIRECTORY, name)) fail();
      records.push({ runId: value.runId, launchAttempt: value.launchAttempt });
    } catch (error) { if (error.code !== 'ENOENT') invalid++; }
    finally { await file?.close(); }
  }
  return { records, invalid };
}

export async function acknowledgeLinuxRunRevocation(runId, launchAttempt) {
  await ensureLinuxRunCancelIntentStore();
  try { await unlink(outboxPath(runId, launchAttempt)); await syncDirectory(DIRECTORY); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
