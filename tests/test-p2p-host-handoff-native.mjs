import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { startP2PHostForDevice, stopAllP2PHosts } from '../lib/p2p-host-registry.mjs';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
const close = server => new Promise(resolve => server.close(resolve));
const secret = 'synthetic-native-handoff-secret';
const roomId = createP2PRoomId(secret);
const token = `rda_${'a'.repeat(64)}`;
const target = http.createServer((req, res) => {
  res.writeHead(req.url === '/api/auth/me' && req.headers.authorization !== `Bearer ${token}` ? 401 : 200);
  res.end('ok');
});
const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
const source = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
const web = http.createServer((req, res) => {
  if (req.url === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(source); }
  else res.end('<!doctype html>');
});
let browser;
try {
  const targetAddress = await listen(target);
  const signalAddress = await signaling.listen();
  const webAddress = await listen(web);
  const signalingUrl = `http://127.0.0.1:${signalAddress.port}`;
  const credential = { iceServers: [{ urls: 'turn:example.invalid', username: 'synthetic', credential: 'synthetic' }],
    expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const started = await startP2PHostForDevice('native-handoff-fixture', {
    p2pAccess: { roomId, secret }, signalingUrl, localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    ...credential, expiresAt: new Date(Date.now() + 18_000).toISOString(), refreshHost: async () => credential,
    runHostAgent: options => runP2PHostAgent({ ...options,
      ...(process.env.RAGENT_TEST_P2P_HOST_BINARY ? { binaryPath: process.env.RAGENT_TEST_P2P_HOST_BINARY } : {}),
      // Local loopback exercises actual native WebRTC without contacting a TURN provider.
      iceServers: [], relayOnly: false }),
  });
  assert.equal(started.started, true);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const result = await page.evaluate(async ({ signalingUrl, roomId, secret, token }) => {
    const { RagentP2PClient } = await import('/client.js');
    const options = { signalingUrl, roomId, secret, iceServers: [], connectTimeoutMs: 10_000, requestTimeoutMs: 3_000 };
    const old = new RagentP2PClient(options);
    await old.connect();
    const before = (await old.request({ method: 'GET', path: '/connectivity-health' })).status;
    const notice = new Promise(resolve => old.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.envelope?.payload?.type === 'carrier_handoff_requested') resolve(message.envelope.payload.handoffId);
    }));
    const handoffId = await Promise.race([notice, new Promise((_, reject) => setTimeout(() => reject(new Error('handoff notice timed out')), 16_000))]);
    old.socket.close(1000, 'handoff');
    const stillUsable = (await old.request({ method: 'GET', path: '/connectivity-health' })).status;
    const next = new RagentP2PClient(options);
    const send = next.sendSignal.bind(next);
    next.sendSignal = payload => send(payload.type === 'offer' ? { ...payload, handoffId } : payload);
    await next.connect();
    const verified = (await next.request({ method: 'GET', path: '/api/auth/me', headers: { Authorization: `Bearer ${token}` } })).status;
    const oldAfterVerify = (await old.request({ method: 'GET', path: '/connectivity-health' })).status;
    const after = (await next.request({ method: 'GET', path: '/connectivity-health' })).status;
    old.close(); next.close();
    return { before, stillUsable, verified, oldAfterVerify, after };
  }, { signalingUrl, roomId, secret, token });
  assert.deepEqual(result, { before: 200, stillUsable: 200, verified: 200, oldAfterVerify: 200, after: 200 });
  console.log('Native P2P handoff keeps the old carrier usable until an authenticated replacement is ready');
} finally {
  await stopAllP2PHosts();
  await browser?.close();
  await signaling.close();
  await Promise.all([close(target), close(web)]);
}
