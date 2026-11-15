import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

const builtBinaryPath = process.env.RAGENT_PHASE0_P2P_BINARY
  ? ''
  : join(tmpdir(), `ragent-p2p-host-reconnect-${process.pid}.exe`);
if (builtBinaryPath) {
  execFileSync('go', ['build', '-o', builtBinaryPath, './cmd/ragent-p2p-host'], {
    cwd: new URL('../p2p/', import.meta.url),
    stdio: 'ignore',
  });
}
const binaryPath = process.env.RAGENT_PHASE0_P2P_BINARY || builtBinaryPath || resolveP2PHostBinary();
await access(binaryPath);

const resources = [];
try {
  const target = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/connectivity-health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404); response.end();
  });
  resources.push(() => close(target));
  const targetAddress = await listen(target);

  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  resources.push(() => signaling.close());
  const signalingAddress = await signaling.listen();
  const signalingUrl = `http://127.0.0.1:${signalingAddress.port}`;
  const secret = 'p2p-mobile-reconnect-test-secret';
  const roomId = createP2PRoomId(secret);

  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    binaryPath,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  const clientSource = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
  const web = http.createServer((request, response) => {
    if (request.url === '/client.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(clientSource);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>P2P reconnect test</title>');
  });
  resources.push(() => close(web));
  const webAddress = await listen(web);

  const browser = await chromium.launch({ headless: true });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const result = await page.evaluate(async ({ signalingUrl, roomId, secret }) => {
    const { RagentP2PClient } = await import('/client.js');
    const connectAndProbe = async () => {
      const client = new RagentP2PClient({
        signalingUrl,
        roomId,
        secret,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        connectTimeoutMs: 15_000,
      });
      await client.connect();
      const response = await client.request({ method: 'GET', path: '/connectivity-health' });
      client.close();
      return response.status;
    };
    const first = await connectAndProbe();
    // Mirror an Android force-close: the second client is a brand-new browser
    // role and therefore creates a new offer/ICE ufrag in the same room.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await connectAndProbe();
    return { first, second };
  }, { signalingUrl, roomId, secret });
  assert.deepEqual(result, { first: 200, second: 200 });
  console.log('test-p2p-host-mobile-reconnect: host accepts a fresh mobile offer after close');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
  if (builtBinaryPath) await unlink(builtBinaryPath).catch(() => {});
}
