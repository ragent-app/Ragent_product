import assert from 'assert/strict';
import { access, readFile } from 'fs/promises';
import http from 'http';
import { arch } from 'process';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

// 复现：会话事件页响应（~135KB）经 P2P DataChannel 单帧回传时是否损坏/丢失。
// 对照组：小响应。观察点：请求是否超时、响应 JSON 是否完整、耗时。
const DEVICE_TOKEN = `rdt_${'a'.repeat(64)}`;

function buildEventsPayload(targetBytes) {
  const events = [];
  let size = 100;
  let index = 0;
  while (size < targetBytes) {
    const text = `event-${index}-` + 'x'.repeat(120);
    events.push({ type: 'message', id: `evt_${String(index).padStart(6, '0')}`, content: text });
    size += text.length + 80;
    index += 1;
  }
  return JSON.stringify({ events, latestSeq: index, runActivity: null });
}

const PAYLOADS = {
  small: buildEventsPayload(4 * 1024),
  medium: buildEventsPayload(64 * 1024),
  large: buildEventsPayload(135 * 1024),
  huge: buildEventsPayload(700 * 1024),
};

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P large-response e2e skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = process.env.RAGENT_P2P_HOST_BINARY || resolveP2PHostBinary();
await access(binaryPath);
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => server.close();
const resources = [];

try {
  const target = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://x').searchParams.get('payload') || 'small';
    const body = PAYLOADS[name] ?? PAYLOADS.small;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  resources.push(() => close(target));
  const targetAddress = await listen(target);

  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  resources.push(() => signaling.close());
  const signalingAddress = await signaling.listen();
  const signalingUrl = `http://127.0.0.1:${signalingAddress.port}`;
  const secret = 'large_response_repro_secret';
  const roomId = createP2PRoomId(secret);
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  const clientSource = await readFile(process.env.RAGENT_P2P_CLIENT_SOURCE || new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
  const web = http.createServer((request, response) => {
    if (request.url === '/ragent-p2p-client.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(clientSource);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Ragent P2P large response test</title>');
  });
  resources.push(() => close(web));
  const webAddress = await listen(web);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.RAGENT_CHROME_PATH || undefined });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const results = await page.evaluate(async ({ signalingUrl: url, roomId: room, secret: roomSecret, deviceToken, cases }) => {
    const { RagentP2PClient } = await import('/ragent-p2p-client.js');
    const client = new RagentP2PClient({ signalingUrl: url, roomId: room, secret: roomSecret, iceServers: [], connectTimeoutMs: 10000, requestTimeoutMs: 15000 });
    await client.connect();
    const outcome = {};
    for (const [name, path] of Object.entries(cases)) {
      const started = performance.now();
      try {
        const response = await client.request({ method: 'GET', path, headers: { Authorization: `Bearer ${deviceToken}` } });
        let valid = false;
        let eventCount = 0;
        try {
          const parsed = JSON.parse(response.text);
          valid = Array.isArray(parsed.events);
          eventCount = parsed.events.length;
        } catch { valid = false; }
        outcome[name] = {
          ok: true,
          ms: Math.round(performance.now() - started),
          status: response.status,
          bytes: response.text.length,
          head: response.text.slice(0, 120),
          valid,
          eventCount,
        };
      } catch (error) {
        outcome[name] = { ok: false, ms: Math.round(performance.now() - started), error: String(error?.message || error) };
      }
    }
    client.close();
    return outcome;
  }, {
    signalingUrl,
    roomId,
    secret,
    deviceToken: DEVICE_TOKEN,
    cases: { small: '/events?payload=small', medium: '/events?payload=medium', large: '/events?payload=large', huge: '/events?payload=huge' },
  });

  for (const [name, outcome] of Object.entries(results)) {
    console.log(name, JSON.stringify(outcome), `expectedBytes=${PAYLOADS[name].length}`);
  }
  assert.equal(results.small.ok, true, 'small response should succeed');
  assert.equal(results.small.valid, true);
  assert.equal(results.large.ok, true, `large response should not fail: ${JSON.stringify(results.large)}`);
  assert.equal(results.large.valid, true, 'large response body must be intact JSON');
  assert.equal(results.large.bytes, PAYLOADS.large.length, 'large response byte count must match');
  if (process.env.RAGENT_P2P_EXPECT_LEGACY_LIMIT === '1') {
    assert.equal(results.huge.ok, true, 'legacy clients should receive an explicit response');
    assert.equal(results.huge.status, 413, 'legacy oversized response should fail promptly');
  } else {
    assert.equal(results.huge.ok, true, `streamed response should not fail: ${JSON.stringify(results.huge)}`);
    assert.equal(results.huge.valid, true, 'streamed response body must be intact JSON');
    assert.equal(results.huge.bytes, PAYLOADS.huge.length, 'streamed response byte count must match');
  }
  console.log('P2P large-response e2e passed');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}
