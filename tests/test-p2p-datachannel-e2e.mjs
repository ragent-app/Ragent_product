import assert from 'assert/strict';
import { createHash } from 'crypto';
import { access, readFile } from 'fs/promises';
import http from 'http';
import { arch } from 'process';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

// 统一 RemoteApiGateway 策略（lib/connectivity-policy-engine.mjs）要求所有非
// bootstrap/health 的请求携带设备 Bearer token（仅格式校验；真实鉴权在 upstream）。
// e2e 目标是本地 mock server，不校验 token，所以用一个格式合法的 rdt_ token 即可。
const DEVICE_TOKEN = `rdt_${'a'.repeat(64)}`;

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P DataChannel e2e skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = process.env.AGENTOC_P2P_TEST_BINARY || resolveP2PHostBinary();
await access(binaryPath);
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const resources = [];

try {
  const target = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'application/json', 'x-agentoc-p2p': 'yes' });
      response.end(JSON.stringify({ method: request.method, url: request.url,
        body: request.url === '/stream-probe' || request.url.startsWith('/api/assets/') ? undefined : body.toString('utf8'),
        bodyBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
    });
  });
  resources.push(() => close(target));
  const targetAddress = await listen(target);

  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  resources.push(() => signaling.close());
  const signalingAddress = await signaling.listen();
  const signalingUrl = `http://127.0.0.1:${signalingAddress.port}`;
  const secret = 'rpi_datachannel_e2e_secret';
  const roomId = createP2PRoomId(secret);
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  const clientSource = await readFile(new URL('../static/p2p/agentoc-p2p-client.js', import.meta.url));
  const web = http.createServer((request, response) => {
    if (request.url === '/agentoc-p2p-client.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(clientSource);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>AgentoC P2P test</title>');
  });
  resources.push(() => close(web));
  const webAddress = await listen(web);

  const browser = await chromium.launch({ headless: true,
    ...(process.env.AGENTOC_P2P_TEST_CHROMIUM ? { executablePath: process.env.AGENTOC_P2P_TEST_CHROMIUM } : {}) });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const result = await page.evaluate(async ({ signalingUrl: url, roomId: room, secret: roomSecret, deviceToken }) => {
    const { AgentoCP2PClient } = await import('/agentoc-p2p-client.js');
    const client = new AgentoCP2PClient({ signalingUrl: url, roomId: room, secret: roomSecret, iceServers: [], connectTimeoutMs: 10000, requestTimeoutMs: 10000 });
    await client.connect();
    const response = await client.request({ method: 'POST', path: '/probe?q=1', body: 'hello-p2p', headers: { Authorization: `Bearer ${deviceToken}` } });
    const streamBody = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 37) % 251);
    const streamDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', streamBody));
    const sha256 = [...streamDigest].map((value) => value.toString(16).padStart(2, '0')).join('');
    const streamId = crypto.randomUUID();
    const streamResponse = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.pending.delete(streamId); reject(new Error('P2P streamed request timed out')); }, 20000);
      client.pending.set(streamId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    const headers = { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/octet-stream' };
    client.channel.send(JSON.stringify({ type: 'http_request_stream_v2_init', id: streamId, method: 'POST',
      path: '/stream-probe', headers, totalBytes: streamBody.byteLength, sha256 }));
    const chunkBytes = 24 * 1024;
    let chunks = 0;
    for (let offset = 0; offset < streamBody.length; offset += chunkBytes) {
      const chunk = streamBody.subarray(offset, Math.min(offset + chunkBytes, streamBody.length));
      let binary = '';
      for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
      client.channel.send(JSON.stringify({ type: 'http_request_stream_v2_chunk', id: streamId,
        index: chunks++, dataBase64: btoa(binary) }));
    }
    client.channel.send(JSON.stringify({ type: 'http_request_stream_v2_end', id: streamId,
      chunkCount: chunks, totalBytes: streamBody.byteLength, sha256 }));
    const streamed = await streamResponse;
    const binaryId = crypto.randomUUID();
    const binaryResponse = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.pending.delete(binaryId); reject(new Error('P2P binary request timed out')); }, 20000);
      client.pending.set(binaryId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    client.channel.send(JSON.stringify({ type: 'http_request_stream_v2_init', id: binaryId, method: 'PATCH',
      path: '/api/assets/fasset_0123456789abcdef01234567/upload', headers, totalBytes: streamBody.byteLength, sha256 }));
    const encodedId = new TextEncoder().encode(binaryId);
    chunks = 0;
    for (let offset = 0; offset < streamBody.length; offset += chunkBytes) {
      const chunk = streamBody.subarray(offset, Math.min(offset + chunkBytes, streamBody.length));
      const frame = new Uint8Array(5 + encodedId.length + 4 + chunk.length);
      frame.set([65, 71, 66, 51, encodedId.length]);
      frame.set(encodedId, 5);
      new DataView(frame.buffer).setUint32(5 + encodedId.length, chunks++);
      frame.set(chunk, 9 + encodedId.length);
      client.channel.send(frame);
    }
    client.channel.send(JSON.stringify({ type: 'http_request_stream_v2_end', id: binaryId,
      chunkCount: chunks, totalBytes: streamBody.byteLength, sha256 }));
    const binaryStreamed = await binaryResponse;
    client.close();
    return { status: response.status, headers: response.headers, text: response.text,
      streamedStatus: streamed.status, streamedText: new TextDecoder().decode(Uint8Array.from(atob(streamed.bodyBase64), (char) => char.charCodeAt(0))),
      binaryStatus: binaryStreamed.status, binaryText: new TextDecoder().decode(Uint8Array.from(atob(binaryStreamed.bodyBase64), (char) => char.charCodeAt(0))),
      streamExpectedBytes: streamBody.byteLength, streamExpectedSha256: sha256 };
  }, { signalingUrl, roomId, secret, deviceToken: DEVICE_TOKEN });
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Agentoc-P2p'], 'yes');
  assert.deepEqual(JSON.parse(result.text), { method: 'POST', url: '/probe?q=1', body: 'hello-p2p',
    bodyBytes: 9, sha256: createHash('sha256').update('hello-p2p').digest('hex') });
  assert.equal(result.streamedStatus, 200);
  assert.deepEqual(JSON.parse(result.streamedText), { method: 'POST', url: '/stream-probe',
    bodyBytes: result.streamExpectedBytes, sha256: result.streamExpectedSha256 });
  assert.equal(result.binaryStatus, 200);
  assert.deepEqual(JSON.parse(result.binaryText), { method: 'PATCH', url: '/api/assets/fasset_0123456789abcdef01234567/upload',
    bodyBytes: result.streamExpectedBytes, sha256: result.streamExpectedSha256 });
  console.log('P2P browser-to-Pion DataChannel e2e passed');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}
