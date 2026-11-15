#!/usr/bin/env node
// B 批: DataChannel 确定性故障注入(丢包/高延迟), 通过 sidecar 的 env 钩子:
//   RAGENT_P2P_FAULT_DROP_FIRST_N=1  → 第一个请求被丢弃(客户端超时), 后续成功
//   RAGENT_P2P_FAULT_DELAY_MS=1500   → 请求成功但响应延迟 >= 1500ms
// 这些从客户端视角等价于 DataChannel 包丢失 / 高延迟(请求未答 / 迟到)。
import assert from 'assert/strict';
import { access, readFile } from 'fs/promises';
import http from 'http';
import { arch } from 'process';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P DataChannel fault-injection skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = resolveP2PHostBinary();
await access(binaryPath);
// 统一 RemoteApiGateway 策略要求非 bootstrap/health 请求携带设备 Bearer(格式校验)。
const DEVICE_TOKEN = `rdt_${'a'.repeat(64)}`;

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const resources = [];

function targetServer() {
  const target = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'x-ragent-p2p': 'yes' });
    response.end(JSON.stringify({ method: request.method, url: request.url }));
  });
  return target;
}

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  PASS: ${label}${extra ? ` :: ${extra}` : ''}`); }
  else { failed += 1; console.log(`  FAIL: ${label}${extra ? ` :: ${extra}` : ''}`); }
}

const browser = await chromium.launch({ headless: true });
resources.push(() => browser.close());

const clientSource = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));

async function runScenario({ faultEnv, script, label }) {
  const prev = {};
  for (const [k, v] of Object.entries(faultEnv)) { prev[k] = process.env[k]; process.env[k] = v; }
  const target = targetServer();
  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  let host = null;
  try {
    await listen(target);
    resources.push(() => close(target));
    await signaling.listen();
    resources.push(() => signaling.close());
    const signalingUrl = `http://127.0.0.1:${signaling.server.address().port}`;
    const secret = `rpi_fault_${label}`;
    const roomId = createP2PRoomId(secret);
    host = await runP2PHostAgent({
      signalingUrl,
      roomId,
      secret,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      binaryPath,
      localBaseUrl: `http://127.0.0.1:${target.address().port}`,
    });
    await host.ready;

    const web = http.createServer((request, response) => {
      if (request.url === '/ragent-p2p-client.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(clientSource);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Ragent P2P fault test</title>');
    });
    await listen(web);
    resources.push(() => close(web));

    const page = await browser.newPage();
    resources.push(() => page.close());
    await page.goto(`http://127.0.0.1:${web.address().port}/`);
    const result = await page.evaluate(script, { signalingUrl, roomId, secret, deviceToken: DEVICE_TOKEN });
    return result;
  } finally {
    if (host) { host.stop(); await host.done; }
    for (const [k] of Object.entries(faultEnv)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

try {
  // 1. 丢包: DROP_FIRST_N=1 → 第一请求超时, 第二请求成功。
  const drop = await runScenario({
    faultEnv: { RAGENT_P2P_FAULT_DROP_FIRST_N: '1' },
    label: 'drop',
    script: async ({ signalingUrl: url, roomId: room, secret: roomSecret, deviceToken }) => {
      const { RagentP2PClient } = await import('/ragent-p2p-client.js');
      const client = new RagentP2PClient({ signalingUrl: url, roomId: room, secret: roomSecret, iceServers: [], connectTimeoutMs: 10000, requestTimeoutMs: 3000 });
      await client.connect();
      let first;
      try {
        await client.request({ method: 'GET', path: '/probe', headers: { Authorization: `Bearer ${deviceToken}` } });
        first = 'ok';
      } catch (e) {
        first = `timeout:${e.message}`;
      }
      let second;
      try {
        const r = await client.request({ method: 'GET', path: '/probe', headers: { Authorization: `Bearer ${deviceToken}` } });
        second = `ok:${r.status}`;
      } catch (e) {
        second = `timeout:${e.message}`;
      }
      client.close();
      return { first, second };
    },
  });
  check('dropped request times out (packet loss)', drop.first.startsWith('timeout'), drop.first);
  check('subsequent request succeeds', drop.second === 'ok:200', drop.second);

  // 2. 高延迟: DELAY_MS=1500 → 请求成功但响应延迟 >= 1500ms。
  const slow = await runScenario({
    faultEnv: { RAGENT_P2P_FAULT_DELAY_MS: '1500' },
    label: 'delay',
    script: async ({ signalingUrl: url, roomId: room, secret: roomSecret, deviceToken }) => {
      const { RagentP2PClient } = await import('/ragent-p2p-client.js');
      const client = new RagentP2PClient({ signalingUrl: url, roomId: room, secret: roomSecret, iceServers: [], connectTimeoutMs: 10000, requestTimeoutMs: 10000 });
      await client.connect();
      const started = performance.now();
      const r = await client.request({ method: 'GET', path: '/probe', headers: { Authorization: `Bearer ${deviceToken}` } });
      const elapsed = performance.now() - started;
      client.close();
      return { status: r.status, elapsed };
    },
  });
  check('delayed response still succeeds', slow.status === 200, `status=${slow.status}`);
  check('latency actually applied', slow.elapsed >= 1200, `${Math.round(slow.elapsed)}ms`);
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
