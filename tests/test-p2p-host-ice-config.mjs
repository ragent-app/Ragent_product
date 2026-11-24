#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { normalizeP2PHostIceServers, runP2PHostAgent } from '../lib/p2p-host-agent.mjs';

assert.deepEqual(
  normalizeP2PHostIceServers([{
    urls: ' turn:turn.example.test:3478?transport=udp ',
    username: ' user ',
    password: ' password ',
  }]),
  [{
    urls: ['turn:turn.example.test:3478?transport=udp'],
    username: 'user',
    credential: 'password',
  }],
  'TURN broker scalar urls must become the Go sidecar list shape',
);

assert.deepEqual(
  normalizeP2PHostIceServers([{
    urls: ['stun:stun.example.test:3478', ' turn:turn.example.test:3478 '],
    username: 'user',
    credential: 'credential',
  }]),
  [{
    urls: ['stun:stun.example.test:3478', 'turn:turn.example.test:3478'],
    username: 'user',
    credential: 'credential',
  }],
  'already-list-shaped ICE servers must remain compatible',
);

assert.throws(
  () => normalizeP2PHostIceServers([{ urls: '' }]),
  /has no URLs/,
  'invalid ICE servers must fail closed before sidecar startup',
);

// Verify RAGENT_P2P_RELAY_ONLY propagation from runP2PHostAgent to the spawned sidecar.
const tempDir = mkdtempSync(join(tmpdir(), 'ragent-p2p-ice-env-'));
const stubGo = join(tempDir, 'env_probe.go');
const stubExe = join(tempDir, process.platform === 'win32' ? 'env-probe.exe' : 'env-probe');
writeFileSync(
  stubGo,
  `package main
import (
	"bufio"
	"fmt"
	"os"
)
func main() {
	fmt.Fprintf(os.Stderr, "ENV_PROBE relay_only=%s browser_auth=%s ice=%s\\n",
		os.Getenv("RAGENT_P2P_RELAY_ONLY"),
		os.Getenv("RAGENT_P2P_BROWSER_AUTH_REQUIRED"),
		os.Getenv("RAGENT_P2P_ICE_SERVERS_JSON"))
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {}
}
`,
  'utf8',
);
execFileSync('go', ['build', '-o', stubExe, stubGo], { stdio: 'inherit' });

const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/signal' });
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'join') {
      socket.send(JSON.stringify({ type: 'joined', roomId: msg.roomId, role: msg.role }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const signalingUrl = `http://127.0.0.1:${server.address().port}/signal`;

async function probeEnv(agentOptions) {
  const logs = [];
  const agent = await runP2PHostAgent({
    signalingUrl,
    roomId: 'a'.repeat(40),
    secret: 'ice-env-probe-secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath: stubExe,
    onSidecarLog: (line) => logs.push(line),
    ...agentOptions,
  });
  try {
    await agent.ready;
    const deadline = Date.now() + 4_000;
    while (!logs.some((line) => line.startsWith('ENV_PROBE ')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = logs.find((entry) => entry.startsWith('ENV_PROBE ')) || '';
    assert.ok(line, `expected ENV_PROBE stderr log, got: ${JSON.stringify(logs)}`);
    return line;
  } finally {
    agent.stop();
    await agent.done;
  }
}

try {
  const turnServers = [{ urls: 'turn:turn.example.test:3478?transport=udp', username: 'u', password: 'p' }];
  const directLine = await probeEnv({ iceServers: turnServers, relayOnly: false });
  assert.match(directLine, /\brelay_only=0\b/);
  assert.match(directLine, /\bbrowser_auth=\s/);

  const relayLine = await probeEnv({ iceServers: turnServers, relayOnly: true });
  assert.match(relayLine, /\brelay_only=1\b/);

  const browserLine = await probeEnv({
    iceServers: turnServers,
    relayOnly: false,
    browserAuth: { publicKeyPem: 'pem', keyId: 'k1', issuer: 'iss', instanceId: 'ins_1' },
  });
  assert.match(browserLine, /\brelay_only=1\b/);
  assert.match(browserLine, /\bbrowser_auth=1\b/);

  const temporaryLine = await probeEnv({
    iceServers: turnServers,
    relayOnly: false,
    temporaryDevice: { instanceId: 'ins_1', grantId: 'rtg_1', deviceId: 'tmp_1' },
    temporaryIngress: (_req, res) => { res.writeHead(200); res.end(); },
  });
  assert.match(temporaryLine, /\brelay_only=1\b/);
} finally {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('test-p2p-host-ice-config: ICE server normalization and RAGENT_P2P_RELAY_ONLY propagation passed');
