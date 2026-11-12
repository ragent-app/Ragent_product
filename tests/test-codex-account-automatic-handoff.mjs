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
  assert.equal(await coordinateCodexAccountRoute({ ...base, candidateHomeRoot: canonical }), canonical);
  await mkdir(join(canonical, 'codex'), { recursive: true });
  await writeFile(join(canonical, 'codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a', refresh_token: 'secret' } }));
  await assert.rejects(coordinateCodexAccountRoute({ ...base, candidateHomeRoot: legacy, waitMs: 0 }), { code: 'CODEX_HANDOFF_UNAVAILABLE' });
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
