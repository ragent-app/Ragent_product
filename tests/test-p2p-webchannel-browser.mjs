#!/usr/bin/env node
// 浏览器全链路：真实 chat-server（配对路由拉起 host sidecar）+ 本地信令 + Chromium。
// 页面创建配对邀请 → RagentP2P.connect 建立 DataChannel → 拦截并 abort 全部 HTTP /api/**
// 请求后 fetchJsonOrRedirect('/api/sessions') 仍成功 —— 证明 JSON 数据面已切到 P2P 通道。
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { arch } from 'process';

import { chromium } from '@playwright/test';

import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log('test-p2p-webchannel-browser skipped on unsupported architecture');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// e43264c 起会话键为 HMAC(secret, cookie值) 的 s+hex 摘要；chat-server 需要同名
// RAGENT_AUTH_SESSION_SECRET 才能持久化并识别会话。
const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const hashedTestSession = `s${createHmac('sha256', sessionSecret).update('test-session').digest('hex')}`;

// 系统临时端口段与出站连接重叠，固定范围随机端口会撞上活跃出站连接
// 而 EADDRINUSE（flake）。向内核申请空闲端口。
async function allocatePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function rawRequest(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function setupTempInstance() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-p2p-webchannel-'));
  const configDir = join(home, 'config');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ token: ownerToken }, null, 2));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [hashedTestSession]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }, null, 2));
  writeFileSync(join(configDir, 'tools.json'), '[]\n');
  const qrCommand = join(binDir, 'qrcode-terminal');
  writeFileSync(qrCommand, `#!/usr/bin/env node
process.stdin.on('end', () => process.stdout.write('[[QR]]qrcode\\n'));
`);
  chmodSync(qrCommand, 0o755);
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, port, binDir, signalingUrl }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_AUTH_SESSION_SECRET: sessionSecret,
      RAGENT_REPLY_SELF_CHECK: 'off',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_ASSET_STORAGE_REGION: '',
      RAGENT_ASSET_STORAGE_ACCESS_KEY_ID: '',
      RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
      RAGENT_P2P_SIGNALING_URL: signalingUrl,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', () => {});
  await Promise.race([
    waitFor(async () => {
      try {
        return (await rawRequest(port, 'GET', '/api/auth/me', { Cookie: 'session_token=test-session' })).status === 200;
      } catch {
        return false;
      }
    }, 'webchannel test server startup', 15000),
    new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`server exited early with code ${code}`)))),
  ]);
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'webchannel test server shutdown');
}

// 分配端口到子进程 listen 之间存在极小抢占窗口，保留重试兜底。
async function startServerWithRetry(opts, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await allocatePort();
    try {
      const child = await startServer({ ...opts, port });
      return { child, port };
    } catch {
      // 换端口重试
    }
  }
  throw new Error('failed to start webchannel test server after retries');
}

const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
const instance = setupTempInstance();
let server = null;
let browser = null;

(async () => {
  try {
    await signaling.listen();
    const signalingPort = signaling.server.address().port;
    const started = await startServerWithRetry({ ...instance, signalingUrl: `http://127.0.0.1:${signalingPort}` });
    server = started.child;
    const port = started.port;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'session_token', value: 'test-session', domain: '127.0.0.1', path: '/' },
    ]);
    const page = await context.newPage();
    page.on('pageerror', (error) => { console.error('PAGE ERROR:', error?.message || error); });
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('PAGE CONSOLE:', message.text());
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.RagentP2P !== 'undefined' && typeof fetchJsonOrRedirect === 'function', null, { timeout: 15000 });

    // 页面内：创建配对邀请 → P2P 建连 → ready
    const p2pState = await page.evaluate(async () => {
      const response = await fetch('/api/device-pairing/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json();
      const invitation = data?.invitation;
      const p2p = invitation?.connectivity?.p2p;
      if (!invitation?.p2pRoomId || !invitation?.token || !p2p?.signalingEndpoint) {
        return { ok: false, error: 'missing p2p credentials', status: response.status };
      }
      await window.RagentP2P.connect({
        signalingUrl: p2p.signalingEndpoint,
        roomId: invitation.p2pRoomId,
        secret: invitation.token,
      });
      return { ok: window.RagentP2P.ready, status: window.RagentP2P.status };
    });
    assert.equal(p2pState.ok, true, `P2P should be ready in browser, got ${JSON.stringify(p2pState)}`);

    // 拦截并 abort 全部 HTTP /api/** 请求 —— 之后 JSON 请求只能走 DataChannel
    await page.route('**/api/**', (route) => route.abort());

    const sessions = await page.evaluate(async () => {
      return await fetchJsonOrRedirect('/api/sessions');
    });
    assert.ok(Array.isArray(sessions?.sessions), `sessions over P2P should have a list, got ${typeof sessions}: ${JSON.stringify(sessions).slice(0, 200)}`);

    // 断线前再验证一次（POST 语义经 P2P）
    const pairInfo = await page.evaluate(async () => {
      return await fetchJsonOrRedirect('/api/device-pairing/devices');
    });
    assert.ok(typeof pairInfo?.devices === 'object' || Array.isArray(pairInfo?.devices), 'devices list over P2P should be a list');

    console.log('test-p2p-webchannel-browser: ok');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    await signaling.close();
    rmSync(instance.home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
