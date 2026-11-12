import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';

test('control routing waits for this provider home handoff', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-home-routing-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'config');
  const providerHomesRoot = join(root, 'homes');
  const canonical = nativeProviderHomeRoot(providerHomesRoot, 'codex', 'profile-a');
  const candidate = nativeProviderHomeRoot(providerHomesRoot, 'codex', 'profile-b');
  const accountId = 'account-a';
  await resolveCanonicalCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot: canonical, accountId, initialize: true });
  const lookup = () => resolveCodexAccountHomeRoot({ configDir, providerHomeRoot: candidate, providerProfileId: 'profile-b', accountId });
  await assert.rejects(lookup(), { code: 'CODEX_ACCOUNT_HANDOFF_REQUIRED' });
  await resolveCanonicalCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot: candidate, accountId, initialize: true,
    assertMigrationSafe: async () => ({ retainLegacySource: false }) });
  assert.equal(await lookup(), canonical);
});
