import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { startP2PHostForDevice, requestP2PHostHandoff, getP2PHostHandoffPlan,
  commitP2PHostHandoff, stopAllP2PHosts } from '../lib/p2p-host-registry.mjs';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
const close = server => new Promise(resolve => server.close(resolve));
const secret = 'native-signed-handoff-fixture', roomId = createP2PRoomId(secret), deviceId = 'native-signed-fixture';
const token = `rda_${'a'.repeat(64)}`; let commits = 0;
const target = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  let status = 200, payload = { ok: true };
  if (req.url === '/handoff/request') {
    const accepted = requestP2PHostHandoff(deviceId, { from: 'old-lease', signedExpiry: Date.now() + 60_000 });
    status = accepted ? 202 : 409; payload = { accepted };
  } else if (req.url === '/handoff/plan') {
    payload = getP2PHostHandoffPlan(deviceId, body.handoffId); status = payload ? 200 : 409;
  } else if (req.url === '/api/device-auth/turn/handoff/commit') {
    const committed = await commitP2PHostHandoff(deviceId, body.handoffId); status = committed ? 200 : 409; payload = { committed };
  }
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
});
const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
const source = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
const web = http.createServer((req, res) => {
  if (req.url === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(source); }
  else res.end('<!doctype html>');
});
let browser;
try {
  const targetAddress = await listen(target), signalAddress = await signaling.listen(), webAddress = await listen(web);
  const signalingUrl = `http://127.0.0.1:${signalAddress.port}`;
  const credentials = { iceServers: [{ urls: 'turn:fixture.invalid', username: 'fixture', credential: 'fixture' }],
    expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const started = await startP2PHostForDevice(deviceId, { p2pAccess: { roomId, secret }, signalingUrl,
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`, ...credentials, activeConnectionId: 'old-lease',
    prepareHandoff: async () => ({ ...credentials, connectionId: 'new-lease', contract: { turn: { connectionId: 'new-lease' } } }),
    commitHandoff: async () => { commits++; }, releaseHandoff: async () => {},
    runHostAgent: options => runP2PHostAgent({ ...options,
      ...(process.env.RAGENT_TEST_P2P_HOST_BINARY ? { binaryPath: process.env.RAGENT_TEST_P2P_HOST_BINARY } : {}),
      iceServers: [], relayOnly: false }) });
  assert.equal(started.started, true);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const result = await page.evaluate(async ({ signalingUrl, roomId, secret, token }) => {
    const { RagentP2PClient } = await import('/client.js');
    const options = { signalingUrl, roomId, secret, iceServers: [], connectTimeoutMs: 10_000, requestTimeoutMs: 4_000 };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const old = new RagentP2PClient(options); await old.connect();
    const notice = new Promise(resolve => old.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.envelope?.payload?.type === 'carrier_handoff_requested') resolve(message.envelope.payload.handoffId);
    }));
    const requested = await old.request({ method: 'POST', path: '/handoff/request', headers, body: '{}' });
    const handoffId = await Promise.race([notice, new Promise((_, reject) => setTimeout(() => reject(Error('notice timed out')), 12_000))]);
    const plan = await old.request({ method: 'POST', path: '/handoff/plan', headers, body: JSON.stringify({ handoffId }) });
    old.socket.close(1000, 'handoff');
    const oldBefore = await old.request({ method: 'GET', path: '/health', headers });
    const next = new RagentP2PClient(options), send = next.sendSignal.bind(next);
    next.sendSignal = payload => send(payload.type === 'offer' ? { ...payload, handoffId } : payload);
    await next.connect();
    const probe = await next.request({ method: 'GET', path: '/api/auth/me', headers });
    const commit = await next.request({ method: 'POST', path: '/api/device-auth/turn/handoff/commit', headers, body: JSON.stringify({ handoffId }) });
    const oldAfter = await old.request({ method: 'GET', path: '/health', headers });
    const nextAfter = await next.request({ method: 'GET', path: '/health', headers });
    old.close(); next.close();
    return { requested: requested.status, lease: JSON.parse(plan.text).turn.connectionId, probe: probe.status,
      commit: commit.status, oldBefore: oldBefore.status, oldAfter: oldAfter.status, nextAfter: nextAfter.status };
  }, { signalingUrl, roomId, secret, token });
  assert.deepEqual(result, { requested: 202, lease: 'new-lease', probe: 200, commit: 200, oldBefore: 200, oldAfter: 200, nextAfter: 200 });
  assert.equal(commits, 1);
  console.log('PASS native Windows WebRTC signed handoff keeps the old channel usable through standby commit');
} finally { await stopAllP2PHosts(); await browser?.close(); await signaling.close(); await Promise.all([close(target), close(web)]); }
