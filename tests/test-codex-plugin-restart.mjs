import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from '../chat/codex-app-server-broker.mjs';
import { retireIdleCodexBrokerForPluginChange } from '../chat/codex-plugin-restart.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-plugin-restart-'));
let server;
try {
  assert.equal(await retireIdleCodexBrokerForPluginChange({ homeRoot: root, accountId: 'account-a' }), 'not-running');
  const home = join(root, 'codex');
  await mkdir(home);
  let idle = false;
  server = createServer((socket) => socket.once('data', (chunk) => {
    const request = JSON.parse(chunk.toString().trim());
    assert.equal(request.expectedAccountDigest, codexBrokerAccountDigest('account-a'));
    socket.end(`${JSON.stringify({ type: 'agentoc-codex-broker-retire-result', accepted: idle })}\n`);
  }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(codexAppServerBrokerSocketPath(home), resolve));
  await assert.rejects(retireIdleCodexBrokerForPluginChange({ homeRoot: root, accountId: 'account-a' }), { code: 'CODEX_RETIRE_BUSY' });
  idle = true;
  assert.equal(await retireIdleCodexBrokerForPluginChange({ homeRoot: root, accountId: 'account-a' }), 'retired');
  console.log('Codex Plugin idle restart tests passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
