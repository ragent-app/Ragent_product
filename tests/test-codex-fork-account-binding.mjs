import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from '../chat/codex-app-server-broker.mjs';
const { forkCodexThreadViaBroker } = await import(process.env.RAGENT_TEST_CODEX_CLIENT_ENTRY
  ? pathToFileURL(process.env.RAGENT_TEST_CODEX_CLIENT_ENTRY).href
  : '../chat/codex-app-server-client.mjs');

test('fork checks the selected account on the same broker connection', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-fork-account-'));
  const socketPath = codexAppServerBrokerSocketPath(join(root, 'codex'));
  let forks = 0;
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const send = (reply) => socket.write(`${JSON.stringify(reply)}\n`);
        if (message.type === 'agentoc-codex-broker-ping') send({ type: 'agentoc-codex-broker-pong', ready: true,
          accountMatches: message.expectedAccountDigest === codexBrokerAccountDigest('account-a') });
        else if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/fork') { forks++; send({ id: message.id, result: { thread: { id: 'forked-thread' } } }); }
      }
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
  t.after(async () => {
    await new Promise((done) => server.close(done));
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const request = { params: { threadId: 'source-thread' } };
  await assert.rejects(forkCodexThreadViaBroker(socketPath, request, { expectedAccountId: 'account-b' }), /could not verify/);
  assert.equal(forks, 0);
  assert.equal((await forkCodexThreadViaBroker(socketPath, request, { expectedAccountId: 'account-a' })).threadId, 'forked-thread');
  assert.equal(forks, 1);
});
