// Durable control-owned evidence that root acknowledged the revocation
// barrier. It is not an authorization or proof of a result's authenticity.
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readLinuxRunControlBindingRecord } from './linux-run-control-binding.mjs';

const directory = join(CONFIG_DIR, 'linux-run-cancel-intents');
function receiptPath(runId, launchAttempt) {
  return join(directory, `${createHash('sha256').update(runId).digest('hex')}-${launchAttempt}.completion.json`);
}
function expected(binding) {
  return { version: 1, runId: binding.runId, launchAttempt: binding.launchAttempt,
    publicationId: binding.publicationId, scopeDigest: binding.scopeDigest };
}
async function readReceipt(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 4096) throw new Error('Invalid completion receipt');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function hasLinuxRunCompletionReceipt(runId, launchAttempt) {
  try {
    const binding = await readLinuxRunControlBindingRecord(runId, launchAttempt);
    return JSON.stringify(await readReceipt(receiptPath(runId, launchAttempt))) === JSON.stringify(expected(binding));
  } catch { return false; }
}
export async function persistLinuxRunCompletionReceipt(runId, launchAttempt) {
  const binding = await readLinuxRunControlBindingRecord(runId, launchAttempt);
  const filename = receiptPath(runId, launchAttempt), value = expected(binding);
  try {
    const existing = await readReceipt(filename);
    if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('Invalid completion receipt');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.chmod(0o600); await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await file.sync();
      await file.close(); file = null;
      await rename(temporary, filename);
    } finally { if (file) await file.close(); await unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
