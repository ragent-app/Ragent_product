import assert from 'assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPrivateKey, generateKeyPairSync } from 'crypto';
import WebSocket from 'ws';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-browser-ws-'));
const configDir = join(tempHome, '.config', 'ragent');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'test', passwordHash: 'test' }), 'utf8');
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_MEMORY_DIR: process.env.RAGENT_MEMORY_DIR,
  RAGENT_BROWSER_SIGNAL_ISSUER: process.env.RAGENT_BROWSER_SIGNAL_ISSUER,
  RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON: process.env.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON,
};
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = join(tempHome, '.ragent', 'memory');

async function browserJoinOutcome(server, joinMessage) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signal`);
  const outcome = await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify(joinMessage)));
    socket.once('message', (raw) => resolve({ joined: JSON.parse(raw.toString()).type === 'joined' }));
    socket.once('close', (code, reason) => resolve({ joined: false, closeCode: code, reason: reason.toString() }));
  });
  socket.terminate();
  return outcome;
}

async function listenOnEphemeralPort(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}

try {
  const { attachWebSocket, closeWebSocketServer } = await import('../chat/ws.mjs');
  const { issueSignalJoinToken } = await import('../lib/browser-connection-grant.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issuer = 'https://chat-ws-signal-test.invalid';
  const keyId = 'chat-ws-signal-fixture';
  const instanceId = 'ins_chat_ws_signal';
  const clientId = 'browser_chat_ws_signal';
  const connectionId = 'conn_chat_ws_signal';
  const roomId = 'c'.repeat(40);
  process.env.RAGENT_BROWSER_SIGNAL_ISSUER = issuer;
  process.env.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON = JSON.stringify({
    [keyId]: publicKey.export({ type: 'spki', format: 'pem' }),
  });

  // 场景 1：env 显式信任键（云端 broker 拓扑），既有语义不变。
  const server = http.createServer();
  const wss = attachWebSocket(server);
  await listenOnEphemeralPort(server);
  const token = issueSignalJoinToken({ privateKey, issuer, roomId, instanceId, clientId, connectionId, kid: keyId }).token;
  const joined = await browserJoinOutcome(server, { type: 'join', roomId, role: 'browser', joinToken: token, instanceId, clientId, connectionId });
  assert.equal(joined.joined, true, 'primary chat WebSocket attachment authorizes browser signaling joins');
  await closeWebSocketServer(wss);
  await new Promise((resolve) => server.close(resolve));

  // 场景 2：无 env 信任键 → 回退信任本机实例身份（issuer=instance:<id>，kid=指纹）。
  delete process.env.RAGENT_BROWSER_SIGNAL_ISSUER;
  delete process.env.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON;
  const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
  const identity = await loadOrCreateInstanceIdentity();
  const localToken = issueSignalJoinToken({
    privateKey: createPrivateKey(identity.privateKey),
    issuer: `instance:${identity.instanceId}`,
    roomId,
    instanceId: identity.instanceId,
    clientId,
    connectionId,
    kid: identity.keyFingerprint,
  }).token;
  const localServer = http.createServer();
  const localWss = attachWebSocket(localServer);
  await listenOnEphemeralPort(localServer);
  const localJoined = await browserJoinOutcome(localServer, { type: 'join', roomId, role: 'browser', joinToken: localToken, instanceId: identity.instanceId, clientId, connectionId });
  assert.equal(localJoined.joined, true, 'local instance identity fallback authorizes self-issued browser joins');
  // 防重放：同一 token 第二次 join 必须以 1008 拒绝。
  const replayed = await browserJoinOutcome(localServer, { type: 'join', roomId, role: 'browser', joinToken: localToken, instanceId: identity.instanceId, clientId, connectionId });
  assert.equal(replayed.joined, false, 'replayed local-identity join must be rejected');
  assert.equal(replayed.closeCode, 1008, 'replayed local-identity join must close with unauthorized');
  await closeWebSocketServer(localWss);
  await new Promise((resolve) => localServer.close(resolve));

  console.log('test-browser-chat-ws-signaling: env + local-identity /signal authorization ok');
} finally {
  if (previousEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = previousEnv.HOME;
  if (previousEnv.RAGENT_CONFIG_DIR === undefined) delete process.env.RAGENT_CONFIG_DIR; else process.env.RAGENT_CONFIG_DIR = previousEnv.RAGENT_CONFIG_DIR;
  if (previousEnv.RAGENT_MEMORY_DIR === undefined) delete process.env.RAGENT_MEMORY_DIR; else process.env.RAGENT_MEMORY_DIR = previousEnv.RAGENT_MEMORY_DIR;
  if (previousEnv.RAGENT_BROWSER_SIGNAL_ISSUER === undefined) delete process.env.RAGENT_BROWSER_SIGNAL_ISSUER; else process.env.RAGENT_BROWSER_SIGNAL_ISSUER = previousEnv.RAGENT_BROWSER_SIGNAL_ISSUER;
  if (previousEnv.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON === undefined) delete process.env.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON; else process.env.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON = previousEnv.RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON;
  rmSync(tempHome, { recursive: true, force: true });
}

// chat/ws imports the full router, whose module-level workers are intentionally
// long-lived in the service process. This standalone test has already closed
// its own sockets and must not inherit those service handles.
process.exit(0);
