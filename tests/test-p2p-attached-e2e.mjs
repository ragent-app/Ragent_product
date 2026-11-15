import assert from 'assert/strict';
import { access, readFile } from 'fs/promises';
import http from 'http';
import { arch } from 'process';

import WebSocket from 'ws';
import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

// 统一 RemoteApiGateway 策略要求非 bootstrap/health 请求携带设备 Bearer（格式校验；
// 真实鉴权在 upstream）。e2e 目标是 mock server，不校验 token，用格式合法 rdt_ 即可。
const DEVICE_TOKEN = `rdt_${'a'.repeat(64)}`;

// Attach 模式：signaling 与主服务同端口（模拟 chat-server 内嵌 /signal，
// Caddy catch-all 把公网 upgrade 转发到 7690 的场景）。验证 host agent 经
// 主服务同一端口完成 DataChannel 全链路，且非 /signal 的 upgrade 仍被销毁。
if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P attached signaling e2e skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = resolveP2PHostBinary();
await access(binaryPath);
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const resources = [];

try {
  // 模拟 chat-server 主 HTTP server：/healthz 正常响应 + 挂载 signaling upgrade。
  const chatLike = http.createServer((request, response) => {
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-ragent-attached': 'yes' });
      response.end(JSON.stringify({ ok: true, via: 'attached-signaling' }));
      return;
    }
    response.writeHead(404); response.end();
  });
  const p2pSignaling = createP2PSignaling();
  chatLike.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/signal') {
      p2pSignaling.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
  resources.push(async () => { p2pSignaling.close(); await close(chatLike); });
  const chatAddress = await listen(chatLike);
  const signalingUrl = `http://127.0.0.1:${chatAddress.port}`;

  // 非 /signal 的 upgrade 必须被销毁（ws.mjs 对 /ws 之外路径的既有行为）。
  const rejected = await new Promise((resolve) => {
    const probe = new WebSocket(`ws://127.0.0.1:${chatAddress.port}/ws`);
    probe.once('open', () => resolve(false));
    probe.once('error', () => resolve(true));
    probe.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });
  assert.equal(rejected, true, 'non-/signal upgrade must be rejected');

  const secret = 'rpi_attached_e2e_secret';
  const roomId = createP2PRoomId(secret);
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${chatAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  const clientSource = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
  const web = http.createServer((request, response) => {
    if (request.url === '/ragent-p2p-client.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(clientSource);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Ragent P2P attached test</title>');
  });
  resources.push(() => close(web));
  const webAddress = await listen(web);

  const browser = await chromium.launch({ headless: true });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webAddress.port}/`);
  const result = await page.evaluate(async ({ signalingUrl: url, roomId: room, secret: roomSecret, deviceToken }) => {
    const { RagentP2PClient } = await import('/ragent-p2p-client.js');
    const client = new RagentP2PClient({ signalingUrl: url, roomId: room, secret: roomSecret, iceServers: [], connectTimeoutMs: 10000, requestTimeoutMs: 10000 });
    await client.connect();
    const response = await client.request({ method: 'GET', path: '/healthz', headers: { Authorization: `Bearer ${deviceToken}` } });
    client.close();
    return { status: response.status, headers: response.headers, text: response.text };
  }, { signalingUrl, roomId, secret, deviceToken: DEVICE_TOKEN });
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Ragent-Attached'], 'yes');
  assert.deepEqual(JSON.parse(result.text), { ok: true, via: 'attached-signaling' });
  console.log('P2P attached-signaling browser-to-Pion e2e passed');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}
