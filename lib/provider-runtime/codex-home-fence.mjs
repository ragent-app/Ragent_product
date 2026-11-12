import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const FENCE_FILE = '.agentoc-codex-home-fence.json';

function fencePath(homeRoot) {
  if (typeof homeRoot !== 'string' || !isAbsolute(homeRoot)) throw new Error('Absolute Codex home is required');
  return join(homeRoot, FENCE_FILE);
}

// Called only while both legacy creation and OAuth ownership locks are held.
// Install before starting the replacement: even a crash during startup leaves
// future legacy launchers fenced. A corrupt record also fails closed.
export async function fenceLegacyCodexHome({ legacyHomeRoot, canonicalHomeRoot, accountId }) {
  if (typeof accountId !== 'string' || !accountId.trim() || typeof canonicalHomeRoot !== 'string' || !isAbsolute(canonicalHomeRoot)) {
    throw Object.assign(new Error('Verified account and canonical home are required'), { code: 'CODEX_FENCE_INVALID' });
  }
  const path = fencePath(legacyHomeRoot);
  const record = { version: 1, account: createHash('sha256').update('ragent-codex-fence\0').update(accountId.trim()).digest('hex'),
    canonical: resolve(canonicalHomeRoot) };
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Invalid Codex home fence'), { code: 'CODEX_FENCE_INVALID' });
    let existing;
    try { existing = JSON.parse(await readFile(path, 'utf8')); } catch { throw Object.assign(new Error('Invalid Codex home fence'), { code: 'CODEX_FENCE_INVALID' }); }
    const samePath = process.platform === 'win32'
      ? String(existing?.canonical || '').toLowerCase() === record.canonical.toLowerCase()
      : existing?.canonical === record.canonical;
    if (existing?.version !== 1 || existing.account !== record.account || !samePath) {
      throw Object.assign(new Error('Codex home is fenced for another owner'), { code: 'CODEX_FENCE_INVALID' });
    }
  }
}

export async function assertCodexHomeNotFenced(homeRoot) {
  try { await lstat(fencePath(homeRoot)); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('Codex account home has been retired; retry using the account owner'), { code: 'CODEX_HOME_RETIRED' });
}
