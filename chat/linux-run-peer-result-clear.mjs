// Durable control-side clearing intent. Callers serialize all Run operations
// with the Run mutation lock and retain this marker after clearing the copies.
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { ensureLinuxRunCancelIntentStore } from './linux-run-cancel-intent.mjs';
import { readLinuxRunControlBindingRecord } from './linux-run-control-binding.mjs';
import { hasLinuxRunCompletionReceipt } from './linux-run-completion-receipt.mjs';

const directory = join(CONFIG_DIR, 'linux-run-cancel-intents');
function unavailable() { return Object.assign(new Error('Protected result clearing unavailable'), { code: 'LINUX_RUN_RESULT_UNAVAILABLE' }); }
async function identity(runId, attempt) {
  const binding = await readLinuxRunControlBindingRecord(runId, attempt);
  if (binding.resultChannel !== 'peer-v1' || !await hasLinuxRunCompletionReceipt(runId, attempt)) throw unavailable();
  const filename = join(directory, `${createHash('sha256').update(runId).digest('hex')}-${attempt}.peer-cleared.json`);
  return { filename, value: { version: 1, runId, launchAttempt: attempt,
    publicationId: binding.publicationId, scopeDigest: binding.scopeDigest } };
}
async function readChecked(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 ||
        info.size < 1 || info.size > 4096) throw unavailable();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
async function syncDirectory() {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function hasLinuxPeerResultClearIntent(runId, attempt) {
  const { filename, value } = await identity(runId, attempt);
  try {
    if (JSON.stringify(await readChecked(filename)) !== JSON.stringify(value)) throw unavailable();
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function persistLinuxPeerResultClearIntent(runId, attempt) {
  await ensureLinuxRunCancelIntentStore();
  const { filename, value } = await identity(runId, attempt);
  if (await hasLinuxPeerResultClearIntent(runId, attempt)) { await syncDirectory(); return; }
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600); await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await file.sync();
    await file.close(); file = null;
    await rename(temporary, filename);
    await syncDirectory();
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
