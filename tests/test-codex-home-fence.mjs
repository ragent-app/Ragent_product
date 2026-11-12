import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertCodexHomeNotFenced, fenceLegacyCodexHome } from '../lib/provider-runtime/codex-home-fence.mjs';
import { withCodexAccountHomeHandoff } from '../lib/provider-runtime/codex-account-handoff.mjs';
import { ensureCodexAppServerBroker } from '../chat/codex-app-server-broker.mjs';

test('legacy home stays fenced if replacement startup fails', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-codex-fence-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const legacy = join(root, 'legacy');
  const canonical = join(root, 'canonical');
  await mkdir(legacy);
  const input = { accountId: 'account-a', legacyHomeRoot: legacy, canonicalHomeRoot: canonical };
  await assertCodexHomeNotFenced(legacy);
  await assert.rejects(withCodexAccountHomeHandoff({ ...input,
    acquireCreationLock: async () => ({ release: async () => {} }),
    retireAndAcquireHome: async () => ({ release: async () => {} }),
    reconcileCredentials: async () => {},
    startCanonical: async () => {
      await assert.rejects(assertCodexHomeNotFenced(legacy), { code: 'CODEX_HOME_RETIRED' });
      throw new Error('startup failed');
    },
  }), /startup failed/);
  await assert.rejects(assertCodexHomeNotFenced(legacy), { code: 'CODEX_HOME_RETIRED' });
  await fenceLegacyCodexHome(input); // retry is idempotent
  await assert.rejects(fenceLegacyCodexHome({ ...input, accountId: 'account-b' }), { code: 'CODEX_FENCE_INVALID' });
  assert.ok(!(await readFile(join(legacy, '.agentoc-codex-home-fence.json'), 'utf8')).includes('account-a'));
  let spawned = false;
  await assert.rejects(ensureCodexAppServerBroker({ socketPath: process.platform === 'win32'
    ? `\\\\.\\pipe\\ragent-fenced-${process.pid}` : join(root, 'broker.sock'),
    upstreamFile: process.execPath, env: { CODEX_HOME: join(legacy, 'codex') },
    spawnImpl: () => { spawned = true; },
  }), { code: 'CODEX_HOME_RETIRED' });
  assert.equal(spawned, false);
});
