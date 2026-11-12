import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function codexRefreshFingerprint(tokens) {
  const refresh = tokens?.refresh_token;
  return typeof refresh === 'string' && refresh
    ? createHash('sha256').update('ragent-codex-refresh-v1\0').update(refresh).digest('hex') : '';
}

// A running broker may have rotated beyond the vault snapshot. Its recorded
// source fingerprint proves when that exact snapshot was the starting point;
// a different vault generation may instead represent a separate re-login.
export async function verifySelectedCodexCredential({ accountId, canonicalHomeRoot, selectedTokens, canonicalAuth = null }) {
  if (!selectedTokens) return;
  const owner = canonicalAuth || await readAuth(canonicalHomeRoot);
  const selected = { tokens: selectedTokens };
  if (codexRolloutAccountId(owner) !== accountId || codexRolloutAccountId(selected) !== accountId
      || typeof owner?.tokens?.refresh_token !== 'string' || !owner.tokens.refresh_token
      || typeof selectedTokens.refresh_token !== 'string' || !selectedTokens.refresh_token) {
    throw Object.assign(new Error('Codex account credentials could not be verified'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  }
  if (owner.tokens.refresh_token === selectedTokens.refresh_token) return;
  let state = null;
  try { state = JSON.parse(await readFile(join(canonicalHomeRoot, 'codex', '.agentoc-oauth-state.json'), 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw Object.assign(new Error('Codex credential provenance is invalid'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' }); }
  const fingerprint = createHash('sha256').update(JSON.stringify(stableValue(selectedTokens))).digest('hex').slice(0, 16);
  if (state?.sourceFingerprint === fingerprint || state?.sourceRefreshFingerprint === codexRefreshFingerprint(selectedTokens)) return;
  throw Object.assign(new Error('Codex credential generations cannot be safely reconciled'), { code: 'CODEX_HANDOFF_CREDENTIALS_DIVERGED' });
}

// Both old-home locks are held. Never guess an ordering between independently
// rotated refresh tokens: they may be from different login families.
export async function verifyCodexHandoffCredentials({ accountId, legacyHomeRoot, canonicalHomeRoot, selectedTokens }) {
  const [legacy, canonical] = await Promise.all([readAuth(legacyHomeRoot), readAuth(canonicalHomeRoot)]);
  const validRefresh = (auth) => typeof auth?.tokens?.refresh_token === 'string' && auth.tokens.refresh_token.length > 0;
  if (!canonical || codexRolloutAccountId(canonical) !== accountId || !validRefresh(canonical)) {
    throw Object.assign(new Error('Canonical Codex credentials could not be verified'), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  }
  await verifySelectedCodexCredential({ accountId, canonicalHomeRoot, selectedTokens, canonicalAuth: canonical });
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
    await verifySelectedCodexCredential({ accountId, canonicalHomeRoot, selectedTokens: legacy.tokens, canonicalAuth: canonical });
  }
  return { retainLegacySource: true };
}
