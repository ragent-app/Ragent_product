import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveBoundCodexAccountHome } from '../lib/provider-runtime/codex-account-route.mjs';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';

test('only a completed account handoff routes a provider to the canonical home', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-account-route-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const base = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'account-a' };
  const canonical = join(base.providerHomesRoot, 'provider-a');
  const candidate = join(base.providerHomesRoot, 'provider-b');
  const route = () => resolveBoundCodexAccountHome({ ...base, candidateHomeRoot: candidate });
  assert.equal(await route(), candidate);
  await resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: canonical, initialize: true });
  await assert.rejects(route(), { code: 'CODEX_ACCOUNT_HANDOFF_REQUIRED' });
  await assert.rejects(resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: candidate, initialize: true,
    assertMigrationSafe: async () => { throw new Error('handoff failed'); } }), /handoff failed/);
  await assert.rejects(route(), { code: 'CODEX_ACCOUNT_HANDOFF_REQUIRED' });
  await resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: candidate, initialize: true,
    assertMigrationSafe: async () => ({ retainLegacySource: true }) });
  assert.equal(await route(), canonical);
  assert.equal(await resolveBoundCodexAccountHome({ ...base, accountId: 'account-b', candidateHomeRoot: candidate }), candidate);
  const otherRoot = join(root, 'other-homes');
  const otherCandidate = join(otherRoot, 'provider-a');
  const other = { ...base, providerHomesRoot: otherRoot, candidateHomeRoot: otherCandidate };
  assert.equal(await resolveBoundCodexAccountHome(other), otherCandidate);
  await resolveCanonicalCodexAccountHome({ ...other, initialize: true });
  assert.equal(await resolveBoundCodexAccountHome(other), otherCandidate);
  assert.equal(await route(), canonical);
});
