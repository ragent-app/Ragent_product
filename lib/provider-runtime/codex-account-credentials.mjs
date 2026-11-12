import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexRolloutAccountId } from '../../chat/codex-managed-rollout.mjs';

async function readAuth(homeRoot) {
  const path = join(homeRoot, 'codex', 'auth.json');
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Codex credential file is not a regular file'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw Object.assign(new Error('Codex credential file could not be verified'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID', cause: error }); }
}

async function hasLegacyHistory(homeRoot) {
  for (const name of ['sessions', 'archived_sessions']) {
    try { await lstat(join(homeRoot, 'codex', name)); return true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return false;
}

export async function verifyCodexCandidateAccount({ accountId, candidateHomeRoot }) {
  const auth = await readAuth(candidateHomeRoot);
  if (!auth) {
    if (await hasLegacyHistory(candidateHomeRoot)) {
      throw Object.assign(new Error('Codex history has no verifiable account'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
    }
    return;
  }
  if (codexRolloutAccountId(auth) !== accountId) {
    throw Object.assign(new Error('Codex home belongs to another account'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  }
}

// Both old-home locks are held. Never guess an ordering between independently
// rotated refresh tokens: they may be from different login families.
export async function verifyCodexHandoffCredentials({ accountId, legacyHomeRoot, canonicalHomeRoot }) {
  const [legacy, canonical] = await Promise.all([readAuth(legacyHomeRoot), readAuth(canonicalHomeRoot)]);
  const validRefresh = (auth) => typeof auth?.tokens?.refresh_token === 'string' && auth.tokens.refresh_token.length > 0;
  if (!canonical || codexRolloutAccountId(canonical) !== accountId || !validRefresh(canonical)) {
    throw Object.assign(new Error('Canonical Codex credentials could not be verified'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  }
  if (!legacy) {
    if (await hasLegacyHistory(legacyHomeRoot)) {
      throw Object.assign(new Error('Legacy Codex history has no verifiable account'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
    }
    return { retainLegacySource: false };
  }
  if (codexRolloutAccountId(legacy) !== accountId || !validRefresh(legacy)) {
    throw Object.assign(new Error('Legacy Codex credentials could not be verified'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  }
  if (legacy.tokens.refresh_token !== canonical.tokens.refresh_token) {
    throw Object.assign(new Error('Codex credential generations cannot be safely reconciled'), { code: 'CODEX_HANDOFF_CREDENTIALS_DIVERGED' });
  }
  return { retainLegacySource: true };
}
