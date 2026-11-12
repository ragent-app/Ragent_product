import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from '../chat/codex-app-server-broker.mjs';
import { coordinateCodexAccountRoute } from '../lib/provider-runtime/codex-account-automatic-handoff.mjs';
import { assertCodexHomeNotFenced } from '../lib/provider-runtime/codex-home-fence.mjs';
import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';

test('automatic handoff fences an unused home and routes to the verified running account', { timeout: 15000 }, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-auto-handoff-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const base = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'account-a' };
  const canonical = join(base.providerHomesRoot, 'a');
  const legacy = join(base.providerHomesRoot, 'b');
  await assert.rejects(coordinateCodexAccountRoute({ ...base, accountId: '', candidateHomeRoot: canonical }), { code: 'CODEX_ACCOUNT_UNVERIFIED' });
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: canonical }), canonical);
  await mkdir(join(canonical, 'codex'), { recursive: true });
  await writeFile(join(canonical, 'codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a', refresh_token: 'secret' } }));
  await assert.rejects(coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 0,
    attest: async () => { throw Object.assign(new Error('identity not verified'), { code: 'CODEX_HANDOFF_UNAVAILABLE' }); } }),
  { code: 'CODEX_HANDOFF_UNAVAILABLE' });
  await assertCodexHomeNotFenced(legacy);
  const server = createServer((socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      const ping = JSON.parse(line);
      socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-pong', ready: true,
        accountMatches: ping.expectedAccountDigest === codexBrokerAccountDigest('account-a') })}\n`);
    });
  });
  const starting = new Promise((resolve) => setTimeout(() => {
    server.listen(codexAppServerBrokerSocketPath(join(canonical, 'codex')), resolve);
  }, 100));
  const routing = coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 3000, pollMs: 25 });
  await starting;
  t.after(() => new Promise((done) => server.close(done)));
  assert.equal(await routing, canonical);
  await assert.rejects(assertCodexHomeNotFenced(legacy), { code: 'CODEX_HOME_RETIRED' });
  const fence = await readFile(join(legacy, '.agentoc-codex-home-fence.json'), 'utf8');
  assert.ok(!fence.includes('account-a'));
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy }), canonical);
});

test('an offline canonical owner can be resumed after a guarded handoff', { timeout: 15000 }, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-offline-handoff-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const base = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'account-a' };
  const canonical = join(base.providerHomesRoot, 'a');
  const legacy = join(base.providerHomesRoot, 'b');
  const tokens = { account_id: 'account-a', refresh_token: 'fixture-refresh' };
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: canonical }), canonical);
  await mkdir(join(canonical, 'codex'), { recursive: true });
  await writeFile(join(canonical, 'codex', 'auth.json'), JSON.stringify({ tokens }));
  await assert.rejects(coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 0,
    selectedTokens: { ...tokens, refresh_token: 'independent-login' } }), { code: 'CODEX_HANDOFF_CREDENTIALS_DIVERGED' });
  await assertCodexHomeNotFenced(legacy);
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 0, selectedTokens: tokens }), canonical);
  await assert.rejects(assertCodexHomeNotFenced(legacy), { code: 'CODEX_HOME_RETIRED' });
});

test('offline handoff waits while the canonical OAuth home is owned', { timeout: 10000 }, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-offline-owner-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const base = { configDir: join(root, 'config'), providerHomesRoot: join(root, 'homes'), accountId: 'account-a' };
  const canonical = join(base.providerHomesRoot, 'a');
  const legacy = join(base.providerHomesRoot, 'b');
  const tokens = { account_id: 'account-a', refresh_token: 'fixture-refresh' };
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: canonical }), canonical);
  await mkdir(join(canonical, 'codex'), { recursive: true });
  await writeFile(join(canonical, 'codex', 'auth.json'), JSON.stringify({ tokens }));
  const owner = await acquireNativeOAuthLock(nativeOAuthLockPath(canonical));
  let finished = false;
  const routing = coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 3000, pollMs: 25, selectedTokens: tokens })
    .then((value) => { finished = true; return value; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(finished, false);
    await assertCodexHomeNotFenced(legacy);
  } finally { await owner.release(); }
  assert.equal(await routing, canonical);
});
