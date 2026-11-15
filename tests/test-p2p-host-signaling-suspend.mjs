import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { createP2PRoomId, signP2PSignal, verifyP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
const close = server => new Promise(resolve => server.close(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = 'synthetic-suspend-signaling-secret';
const roomId = createP2PRoomId(secret);
const target = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
const source = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
const web = http.createServer((req, res) => {
  if (req.url === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(source); }
  else res.end('<!doctype html>');
});
let agent, browser, standby, mobile;
try {
  const targetAddress = await listen(target);
  const signalAddress = await signaling.listen();
  const webAddress = await listen(web);
  const signalingUrl = `http://127.0.0.1:${signalAddress.port}`;
  agent = await runP2PHostAgent({ signalingUrl, roomId, secret,
    handoffId: 'a'.repeat(32),
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    ...(process.env.RAGENT_TEST_P2P_HOST_BINARY ? { binaryPath: process.env.RAGENT_TEST_P2P_HOST_BINARY } : {}) });
  await agent.ready;
  await agent.joined;
  mobile = new WebSocket(`ws://127.0.0.1:${signalAddress.port}/signal`);
  await new Promise((resolve, reject) => { mobile.once('open', resolve); mobile.once('error', reject); });
  mobile.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
  await new Promise(resolve => mobile.once('message', resolve));
  const handoffSignal = new Promise(resolve => mobile.once('message', raw => resolve(JSON.parse(raw))));
  assert.equal(agent.requestCarrierHandoff(18_000), true);
  const handoff = await handoffSignal;
  assert.equal(verifyP2PSignal(handoff.envelope, { roomId, secret }), true);
  assert.deepEqual(handoff.envelope.payload, { type: 'carrier_handoff_requested', version: 1, timeoutMs: 18_000, handoffId: 'a'.repeat(32) });
  mobile.close();
  await new Promise(resolve => mobile.once('close', resolve));
  agent.activateHandoff();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const status = () => page.evaluate(async () => (await window.testClient.request({ method: 'GET', path: '/connectivity-health' })).status);
  await page.evaluate(async options => {
    const { RagentP2PClient } = await import('/client.js');
    window.testClient = new RagentP2PClient({ ...options, iceServers: [], connectTimeoutMs: 12_000, requestTimeoutMs: 3_000 });
    await window.testClient.connect();
  }, { signalingUrl, roomId, secret });
  assert.equal(await status(), 200);
  // A delayed offer from a rolled-back generation must never replace this
  // working peer, even if its room MAC is valid.
  mobile = new WebSocket(`ws://127.0.0.1:${signalAddress.port}/signal`);
  await new Promise((resolve, reject) => { mobile.once('open', resolve); mobile.once('error', reject); });
  mobile.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
  await new Promise(resolve => mobile.once('message', resolve));
  const staleOffer = signP2PSignal({ roomId, secret, seq: 1,
    payload: { type: 'offer', sdp: 'stale', handoffId: 'b'.repeat(32) } });
  mobile.send(JSON.stringify({ type: 'signal', roomId, envelope: staleOffer }));
  await delay(250);
  assert.equal(await status(), 200, 'stale handoff offers must not close the existing channel');
  mobile.close();
  await new Promise(resolve => mobile.once('close', resolve));
  agent.suspendSignaling();
  await delay(250);
  standby = new WebSocket(`ws://127.0.0.1:${signalAddress.port}/signal`);
  await new Promise((resolve, reject) => { standby.once('open', resolve); standby.once('error', reject); });
  standby.send(JSON.stringify({ type: 'join', roomId, role: 'host' }));
  await new Promise(resolve => standby.once('message', resolve));
  await delay(2_300);
  assert.equal(standby.readyState, WebSocket.OPEN, 'suspended host must not evict the standby on reconnect');
  assert.equal(await status(), 200, 'existing channel must remain usable without host signaling');
  assert.equal(agent.child.exitCode, null, 'suspension must not stop the sidecar');
  standby.close();
  await new Promise(resolve => standby.once('close', resolve));
  agent.resumeSignaling();
  await delay(250);
  assert.equal(await status(), 200, 'resuming signaling must preserve the existing channel');
  await page.evaluate(() => window.testClient.close());
  console.log('P2P host signaling suspension preserves real DataChannel requests');
} finally {
  standby?.terminate();
  mobile?.terminate();
  agent?.stop();
  await browser?.close();
  await signaling.close();
  await Promise.all([close(target), close(web)]);
}
