import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { codexRefreshFingerprint, verifyCodexHandoffCredentials, verifySelectedCodexCredential } from '../lib/provider-runtime/codex-account-credentials.mjs';

test('handoff refuses ambiguous credentials and unverifiable history', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-handoff-creds-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const legacyHomeRoot = join(root, 'old');
  const canonicalHomeRoot = join(root, 'owner');
  await mkdir(join(legacyHomeRoot, 'codex'), { recursive: true });
  await mkdir(join(canonicalHomeRoot, 'codex'), { recursive: true });
  const args = { accountId: 'account-a', legacyHomeRoot, canonicalHomeRoot };
  const writeAuth = (home, id, refresh) => writeFile(join(home, 'codex', 'auth.json'), JSON.stringify({ tokens: { account_id: id, refresh_token: refresh } }));
  await writeAuth(canonicalHomeRoot, 'account-a', 'refresh-a');
  assert.deepEqual(await verifyCodexHandoffCredentials(args), { retainLegacySource: false });
  await mkdir(join(legacyHomeRoot, 'codex', 'sessions'));
  await assert.rejects(verifyCodexHandoffCredentials(args), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  await writeAuth(legacyHomeRoot, 'account-b', 'refresh-a');
  await assert.rejects(verifyCodexHandoffCredentials(args), { code: 'CODEX_HANDOFF_CREDENTIALS_INVALID' });
  await writeAuth(legacyHomeRoot, 'account-a', 'refresh-b');
  await assert.rejects(verifyCodexHandoffCredentials(args), { code: 'CODEX_HANDOFF_CREDENTIALS_DIVERGED' });
  const prior = { account_id: 'account-a', refresh_token: 'refresh-b' };
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(prior)).digest('hex').slice(0, 16);
  await writeFile(join(canonicalHomeRoot, 'codex', '.agentoc-oauth-state.json'), JSON.stringify({ sourceFingerprint }));
  assert.deepEqual(await verifyCodexHandoffCredentials({ ...args, selectedTokens: prior }), { retainLegacySource: true });
  await writeFile(join(canonicalHomeRoot, 'codex', '.agentoc-oauth-state.json'), JSON.stringify({ sourceRefreshFingerprint: codexRefreshFingerprint(prior) }));
  await verifySelectedCodexCredential({ ...args, selectedTokens: { ...prior, access_token: 'different-metadata' } });
  await assert.rejects(verifySelectedCodexCredential({ ...args, selectedTokens: { account_id: 'account-a', refresh_token: 'different-login' } }),
    { code: 'CODEX_HANDOFF_CREDENTIALS_DIVERGED' });
  await writeAuth(legacyHomeRoot, 'account-a', 'refresh-a');
  assert.deepEqual(await verifyCodexHandoffCredentials(args), { retainLegacySource: true });
});
