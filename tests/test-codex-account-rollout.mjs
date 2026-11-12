import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findAccountCodexRollout } from '../chat/codex-managed-rollout.mjs';

test('account rollout lookup checks ownership and rejects ambiguous histories', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-account-rollout-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const id = '12345678-1234-1234-1234-123456789abc';
  const roots = ['first', 'second'].map((name) => join(root, name));
  const files = [];
  for (const homeRoot of roots) {
    const home = join(homeRoot, 'codex');
    const folder = join(home, 'sessions', '2026', '11', '12');
    await mkdir(folder, { recursive: true });
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a' } }));
    const file = join(folder, `rollout-${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
    files.push(file);
  }
  await assert.rejects(findAccountCodexRollout(roots, 'account-a', id), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  await writeFile(join(roots[1], 'codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-b' } }));
  await assert.rejects(findAccountCodexRollout(roots, 'account-a', id), { code: 'CODEX_ROLLOUT_ACCOUNT_MISMATCH' });
  assert.equal((await findAccountCodexRollout([roots[0]], 'account-a', id)).toLowerCase(), files[0].toLowerCase());
  await writeFile(join(roots[0], 'codex', 'auth.json'), '{}');
  await assert.rejects(findAccountCodexRollout(roots, 'account-a', id), { code: 'CODEX_ROLLOUT_ACCOUNT_UNVERIFIED' });
  await rm(join(roots[0], 'codex', 'auth.json'));
  await assert.rejects(findAccountCodexRollout(roots, 'account-a', id), { code: 'CODEX_ROLLOUT_ACCOUNT_UNVERIFIED' });
});
