import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';
import { resolveCodexRuntimeRolloutSources } from '../lib/provider-runtime/codex-rollout-sources.mjs';

test('launcher reads legacy sources only for the registered canonical account home', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-runtime-sources-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'config');
  const providerHomesRoot = join(root, 'homes');
  const canonical = join(providerHomesRoot, 'one');
  const legacy = join(providerHomesRoot, 'two');
  const args = { configDir, providerHomesRoot, accountId: 'account-a' };
  assert.deepEqual(await resolveCodexRuntimeRolloutSources({ ...args, homeRoot: canonical }), []);
  await resolveCanonicalCodexAccountHome({ ...args, candidateHomeRoot: canonical, initialize: true });
  await resolveCanonicalCodexAccountHome({ ...args, candidateHomeRoot: legacy, initialize: true, assertMigrationSafe: async () => {} });
  assert.deepEqual(await resolveCodexRuntimeRolloutSources({ ...args, homeRoot: canonical }), [legacy]);
  assert.deepEqual(await resolveCodexRuntimeRolloutSources({ ...args, homeRoot: legacy }), []);
  assert.deepEqual(await resolveCodexRuntimeRolloutSources({ ...args, accountId: '', homeRoot: canonical }), []);
});
