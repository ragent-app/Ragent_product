// Control-owned commit record for unguarded internal terminal updates. It is
// written only after root revocation and before the shared status replacement.
import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { ensureLinuxRunCancelIntentStore } from './linux-run-cancel-intent.mjs';
import { readLinuxRunControlBindingRecord } from './linux-run-control-binding.mjs';
import { hasLinuxRunCompletionReceipt } from './linux-run-completion-receipt.mjs';

const directory = join(CONFIG_DIR, 'linux-run-cancel-intents');
const maxBytes = 8 * 1024 * 1024;
function filename(runId, attempt) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) throw new Error('Invalid Run identity');
  return join(directory, `${createHash('sha256').update(runId).digest('hex')}-${attempt}.status-result.json`);
}
async function bindingFor(runId, attempt) {
  const binding = await readLinuxRunControlBindingRecord(runId, attempt);
  if (!await hasLinuxRunCompletionReceipt(runId, attempt)) throw new Error('Completion receipt unavailable');
  return binding;
}
function valid(record, binding) {
  if (!record || Object.keys(record).sort().join(',') !== 'after,before,launchAttempt,publicationId,runId,scopeDigest,version' ||
      record.version !== 1 || record.runId !== binding.runId || record.launchAttempt !== binding.launchAttempt ||
      record.publicationId !== binding.publicationId || record.scopeDigest !== binding.scopeDigest) return false;
  const matches = (run) => run && typeof run === 'object' && !Array.isArray(run) && run.id === binding.runId &&
    run.sessionId === binding.sessionId && run.requestId === binding.turnId && run.runPublication?.publicationId === binding.publicationId;
  return matches(record.before) && matches(record.after) && record.after.runnerLaunchAttempt === binding.launchAttempt &&
    ['completed', 'failed', 'cancelled'].includes(record.after.state) && record.after.result &&
    typeof record.after.result === 'object' && !Array.isArray(record.after.result);
}
async function syncDirectory() {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readChecked(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 1 || stat.size > maxBytes) throw new Error('Invalid result transaction');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function readLinuxRunResultTransaction(runId, attempt) {
  const binding = await bindingFor(runId, attempt);
  try {
    const record = await readChecked(filename(runId, attempt));
    if (!valid(record, binding)) throw new Error('Invalid result transaction');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function hasLinuxRunResultTransaction(runId, attempt) {
  try { await lstat(filename(runId, attempt)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function writeLinuxRunResultTransaction(runId, attempt, before, after) {
  const binding = await bindingFor(runId, attempt), path = filename(runId, attempt);
  const record = { version: 1, runId, launchAttempt: attempt, publicationId: binding.publicationId,
    scopeDigest: binding.scopeDigest, before, after };
  const text = `${JSON.stringify(record)}\n`;
  if (!valid(record, binding) || Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Invalid result transaction');
  try {
    const existing = await readChecked(path);
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Unresolved result transaction');
    await syncDirectory();
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600); await file.writeFile(text, 'utf8'); await file.sync(); await file.close(); file = null;
    // Do not overwrite a competing committed intent, even if the advisory
    // Run lock was removed by another process. A crash before unlinking the
    // temporary hard link leaves an invalid record and fails closed.
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST' || JSON.stringify(await readChecked(path)) !== JSON.stringify(record)) throw error;
    }
    await unlink(temporary);
    await syncDirectory();
  } finally { if (file) await file.close(); await unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function removeLinuxRunResultTransaction(runId, attempt) {
  await bindingFor(runId, attempt);
  try { await unlink(filename(runId, attempt)); await syncDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function listLinuxRunResultTransactions() {
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return { records: [], invalid: 0 }; throw error; }
  await ensureLinuxRunCancelIntentStore();
  const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}-(?:0|[1-9][0-9]{0,4})\.status-result\.json$/.test(name)).sort();
  const records = []; let invalid = 0;
  for (const name of names) {
    try {
      const candidate = await readChecked(join(directory, name));
      if (filename(candidate.runId, candidate.launchAttempt) !== join(directory, name) ||
          !await readLinuxRunResultTransaction(candidate.runId, candidate.launchAttempt)) throw new Error('Invalid result transaction');
      records.push({ runId: candidate.runId, launchAttempt: candidate.launchAttempt });
    } catch (error) { if (error.code !== 'ENOENT') invalid++; }
  }
  return { records, invalid };
}
