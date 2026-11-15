#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const root = await mkdtemp(join(tmpdir(), 'ragent-p2p-host-contract-'));
const binary = join(root, 'fake-p2p-host.mjs');
await writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 60_000);\n', 'ascii');
await chmod(binary, 0o755);

const signalingHttp = http.createServer();
const signaling = new WebSocketServer({ server: signalingHttp, path: '/signal' });
signaling.on('connection', (socket) => {
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'join') socket.send(JSON.stringify({ type: 'joined', roomId: message.roomId, role: message.role }));
    } catch {}
  });
});
const address = await listen(signalingHttp);
let agent = null;
try {
  agent = await runP2PHostAgent({
    signalingUrl: `http://127.0.0.1:${address.port}/signal`,
    roomId: 'a'.repeat(40),
    secret: 'p2p-host-contract-secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    // CreateProcess cannot execute a POSIX shebang script. Node with a piped,
    // idle stdin is a real executable that stays alive for this lifecycle test.
    binaryPath: process.platform === 'win32' ? process.execPath : binary,
    localBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  await agent.ready;
  assert.ok(Number.isInteger(agent.child.pid) && agent.child.pid > 0, 'host process should expose a pid');
  if (process.platform === 'win32') {
    assert.equal(agent.child.__ragentWindowsManaged, true, 'Windows P2P host must use a Job Object');
    assert.equal(agent.child.__ragentWindowsJobObjectCreation, 'suspended-create-assign-resume');
    assert.equal(typeof agent.child.__ragentWindowsJobList, 'function');
  } else {
    assert.equal(agent.child.__ragentWindowsManaged, undefined, 'POSIX host should retain the native child contract');
  }
} finally {
  agent?.stop();
  await agent?.done;
  signaling.close();
  await close(signalingHttp);
  await rm(root, { recursive: true, force: true });
}

console.log('test-p2p-host-agent-platform-contract: ok');
