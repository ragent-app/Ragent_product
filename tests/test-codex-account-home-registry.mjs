import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { codexAccountHomeKey, resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';

test('verified accounts converge on one guarded home across provider profiles', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-account-home-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'config');
  const providerHomesRoot = join(root, 'homes');
  const first = join(providerHomesRoot, 'by-provider', 'first');
  const second = join(providerHomesRoot, 'by-provider', 'second');
  const base = { configDir, providerHomesRoot, accountId: 'account-a' };
  assert.equal(await resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: first }), null);
  assert.equal(await resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: first, initialize: true }), first);
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: second, initialize: true }), { code: 'CODEX_ACCOUNT_HOME_MIGRATION_REQUIRED' });
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: second, initialize: true,
    assertMigrationSafe: async () => { throw new Error('legacy broker active'); } }), /legacy broker active/);
  let guarded = false;
  assert.equal(await resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: second, initialize: true,
    assertMigrationSafe: async ({ canonicalHomeRoot, legacyHomeRoot }) => {
      assert.equal(canonicalHomeRoot, first);
      assert.equal(legacyHomeRoot, second);
      guarded = true;
    } }), first);
  assert.equal(guarded, true);
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, accountId: 'account-b', candidateHomeRoot: first, initialize: true }), { code: 'CODEX_ACCOUNT_HOME_OWNED' });
  assert.equal(await resolveCanonicalCodexAccountHome({ ...base, accountId: 'account-b', candidateHomeRoot: second, initialize: true }), second);
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, accountId: '', candidateHomeRoot: first, initialize: true }), { code: 'CODEX_ACCOUNT_UNVERIFIED' });
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: root, initialize: true }), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  const registry = join(configDir, 'native-provider-runtime', 'codex-canonical-accounts');
  const marker = join(registry, `${codexAccountHomeKey('account-a')}.json`);
  assert.doesNotMatch(await readFile(marker, 'utf8'), /account-a/);
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, providerHomesRoot: join(root, 'other-homes'), candidateHomeRoot: join(root, 'other-homes', 'first') }), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  await writeFile(marker, JSON.stringify({ version: 1, home: '../outside' }));
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: first }), { code: 'CODEX_ACCOUNT_HOME_INVALID' });
  await mkdir(providerHomesRoot, { recursive: true });
});

test('concurrent provider initialization elects a single home', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-account-race-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const options = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'race', initialize: true,
    assertMigrationSafe: async () => {} };
  const homes = await Promise.all(['one', 'two'].map((name) => resolveCanonicalCodexAccountHome({ ...options, candidateHomeRoot: join(options.providerHomesRoot, name) })));
  assert.equal(homes[0], homes[1]);
  const sharedCandidate = join(options.providerHomesRoot, 'cross-account');
  const claims = await Promise.allSettled(['third', 'fourth'].map((accountId) => resolveCanonicalCodexAccountHome({ ...options, accountId, candidateHomeRoot: sharedCandidate })));
  assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
  assert.equal(claims.find((claim) => claim.status === 'rejected').reason.code, 'CODEX_ACCOUNT_HOME_OWNED');
});
