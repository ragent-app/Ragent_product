// Protected result copy for an already-revoked Run generation. This preserves
// what the control service observed; it does not authenticate a runner that
// shares its UID or prove that the original result was truthful.
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { ensureLinuxRunCancelIntentStore } from './linux-run-cancel-intent.mjs';
import { readLinuxRunControlBindingRecord } from './linux-run-control-binding.mjs';
import { hasLinuxRunCompletionReceipt } from './linux-run-completion-receipt.mjs';

const directory = join(CONFIG_DIR, 'linux-run-cancel-intents');
const limit = 4 * 1024 * 1024;
function hash(runId) {
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId)) throw new Error('Invalid Run identity');
  return createHash('sha256').update(runId, 'utf8').digest('hex');
}
function filename(runId, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) throw new Error('Invalid Run generation');
  return join(directory, `${hash(runId)}-${attempt}.result.json`);
}
async function syncDirectory() {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readFileChecked(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 1 || stat.size > limit + 4096) throw new Error('Invalid protected result');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
function valid(record, binding) {
  return record && Object.keys(record).sort().join(',') === 'launchAttempt,publicationId,result,runId,scopeDigest,version' &&
    record.version === 1 && record.runId === binding.runId && record.launchAttempt === binding.launchAttempt &&
    record.publicationId === binding.publicationId && record.scopeDigest === binding.scopeDigest &&
    record.result && typeof record.result === 'object' && !Array.isArray(record.result);
}
async function bindingFor(runId, attempt) {
  const binding = await readLinuxRunControlBindingRecord(runId, attempt);
  if (!await hasLinuxRunCompletionReceipt(runId, attempt)) throw new Error('Completion receipt unavailable');
  return binding;
}
export async function readLinuxRunResultSnapshot(runId, attempt) {
  const binding = await bindingFor(runId, attempt);
  try {
    const record = await readFileChecked(filename(runId, attempt));
    if (!valid(record, binding)) throw new Error('Invalid protected result');
    return record.result;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function saveLinuxRunResultSnapshot(runId, attempt, result, { replace = false } = {}) {
  const binding = await bindingFor(runId, attempt), path = filename(runId, attempt);
  const record = { version: 1, runId, launchAttempt: attempt, publicationId: binding.publicationId,
    scopeDigest: binding.scopeDigest, result };
  try {
    const existing = await readFileChecked(path);
    if (!valid(existing, binding)) throw new Error('Invalid protected result');
    if (!replace) return existing.result;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = `${JSON.stringify(record)}\n`;
  if (!valid(record, binding) || Buffer.byteLength(bytes, 'utf8') > limit) throw new Error('Invalid protected result');
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600); await file.writeFile(bytes, 'utf8'); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
    await syncDirectory();
  } finally { if (file) await file.close(); await unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  return result;
}
export async function removeLinuxRunResultSnapshots(runId, attempt = null) {
  const prefix = hash(runId);
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await ensureLinuxRunCancelIntentStore();
  if (attempt !== null) filename(runId, attempt); // validate before interpolation
  const generation = attempt === null ? '(?:0|[1-9][0-9]{0,4})' : String(attempt);
  const pattern = new RegExp(`^${prefix}-${generation}\\.result\\.json(?:\\.[a-f0-9]{32}\\.tmp)?$`);
  const names = (await readdir(directory)).filter((name) => pattern.test(name));
  for (const name of names) {
    try { await unlink(join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (names.length) await syncDirectory();
}
