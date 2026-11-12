import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startCoordinatedCodexAccount } from '../lib/provider-runtime/codex-account-coordinator.mjs';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';

test('account alias is published only after reconciliation and broker startup', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-account-coordinator-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const base = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'account-a' };
  const first = join(base.providerHomesRoot, 'first');
  const second = join(base.providerHomesRoot, 'second');
  const lookup = () => resolveCanonicalCodexAccountHome({ ...base, candidateHomeRoot: first, includeSources: true });
  const starter = async () => 'broker-ready';
  assert.equal((await startCoordinatedCodexAccount({ ...base, candidateHomeRoot: first, reconcileCredentials: async () => {}, startCanonical: starter })).result, 'broker-ready');
  const events = [];
  const handoff = async ({ reconcileCredentials, startCanonical, ...context }) => {
    events.push('fenced');
    await reconcileCredentials(context);
    assert.deepEqual((await lookup()).aliases, []);
    await startCanonical(context);
    events.push('released');
  };
  await assert.rejects(startCoordinatedCodexAccount({ ...base, candidateHomeRoot: second, handoff,
    reconcileCredentials: async () => {}, startCanonical: async () => { throw new Error('startup failed'); },
  }), /startup failed/);
  assert.deepEqual((await lookup()).aliases, []);
  await assert.rejects(startCoordinatedCodexAccount({ ...base, candidateHomeRoot: second, handoff: async () => {},
    reconcileCredentials: async () => {}, startCanonical: starter,
  }), { code: 'CODEX_COORDINATION_INCOMPLETE' });
  assert.deepEqual((await lookup()).aliases, []);
  events.length = 0;
  const result = await startCoordinatedCodexAccount({ ...base, candidateHomeRoot: second, handoff,
    reconcileCredentials: async () => { events.push('reconciled'); return { retainLegacySource: true }; },
    startCanonical: async () => { events.push('started'); return 'broker-ready'; },
  });
  assert.equal(result.canonicalHomeRoot, first);
  assert.deepEqual(events, ['fenced', 'reconciled', 'started', 'released']);
  assert.deepEqual((await lookup()).sources, [second]);
});

test('missing coordination callbacks fail before any mutation', async () => {
  await assert.rejects(startCoordinatedCodexAccount({}), { code: 'CODEX_COORDINATION_INVALID' });
});
