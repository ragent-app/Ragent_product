#!/usr/bin/env node
// 前端 P2P 接入防回归：chat 页面必须加载 chat/p2p.js（带 nonce、位于 init.js 之前），
// P2P 凭据（p2pRoomId/signalingUrl/配对 URI）不得进入渲染后的页面 HTML，
// /p2p/ 与 /chat/p2p.js 静态资源可服务且带 immutable 缓存头。
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-session';
const ownerToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// e43264c 起会话键为 s+HMAC(secret, token)：未配置 secret 时 sessionHashToken
// 返回空串，预置的 owner 会话被静默丢弃 → /api/auth/me 401 → 启动探活超时。
const sessionSecret = 'test-session-secret-p2p-frontend-bootstrap';
process.env.RAGENT_AUTH_SESSION_SECRET = sessionSecret;

// 系统临时端口段与出站连接重叠，固定范围随机端口会 EADDRINUSE（flake）；
// 改为向内核申请空闲端口。
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

async function waitFor(predicate, description, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function rawRequest(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function setupTempInstance() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-p2p-frontend-'));
  const configDir = join(home, 'config');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ token: ownerToken }, null, 2));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [`s${createHmac('sha256', sessionSecret).update('test-session').digest('hex')}`]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }, null, 2));
  writeFileSync(join(configDir, 'tools.json'), '[]\n');
  const qrCommand = join(binDir, 'qrcode-terminal');
  writeFileSync(qrCommand, `#!/usr/bin/env node
process.stdin.on('end', () => process.stdout.write('[[QR]]qrcode\\n'));
`);
  chmodSync(qrCommand, 0o755);
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, port, binDir }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_REPLY_SELF_CHECK: 'off',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_ASSET_STORAGE_REGION: '',
      RAGENT_ASSET_STORAGE_ACCESS_KEY_ID: '',
      RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitFor(async () => {
    try {
      return (await rawRequest(port, 'GET', '/api/auth/me', { Cookie: ownerCookie })).status === 200;
    } catch {
      return false;
    }
  }, 'frontend bootstrap test server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'frontend bootstrap test server shutdown');
}

const instance = setupTempInstance();
let server = null;

(async () => {
  try {
    const port = await allocatePort();
    server = await startServer({ ...instance, port });

    // 1. chat 页面加载 p2p.js：带 nonce、位于 init.js 之前
    const page = await rawRequest(port, 'GET', '/', { Cookie: ownerCookie });
    assert.equal(page.status, 200, 'chat page should render');
    const html = page.text;
    assert.match(html, /<script src="chat\/p2p\.js\?v=[^"]+" nonce="[^"]+"><\/script>/, 'chat page must load chat/p2p.js with nonce');
    assert.ok(html.indexOf('chat/p2p.js') < html.indexOf('chat/init.js'), 'chat/p2p.js must load before chat/init.js');

    // 2. P2P 凭据不得泄漏进页面 HTML
    for (const needle of ['p2pRoomId', 'signalingUrl', 'ragent://pair']) {
      assert.ok(!html.includes(needle), `rendered chat page must not contain ${needle}`);
    }

    // 3. 静态资源可服务 + immutable 缓存头
    const clientAsset = await rawRequest(port, 'GET', '/p2p/ragent-p2p-client.js?v=test', { Cookie: ownerCookie });
    assert.equal(clientAsset.status, 200, 'P2P client module should be served');
    assert.equal(clientAsset.headers['cache-control'], 'public, max-age=31536000, immutable', 'versioned P2P client must be immutable-cached');
    const adapterAsset = await rawRequest(port, 'GET', '/chat/p2p.js?v=test', { Cookie: ownerCookie });
    assert.equal(adapterAsset.status, 200, 'p2p adapter script should be served');
    assert.equal(adapterAsset.headers['cache-control'], 'public, max-age=31536000, immutable', 'versioned p2p adapter must be immutable-cached');

    // 4. 当前连接入口位于跨设备 workspace；旧的 settings 直连按钮已退役
    // （P2P credentials remain fetched only after the authenticated flow starts）
    assert.ok(html.includes('id="crossDeviceOverlay"'), 'chat page must include the cross-device workspace');
    assert.ok(html.includes('id="crossDeviceTabDevices"'), 'cross-device workspace must expose the devices view');
    assert.ok(html.includes('id="crossDeviceRegisterView"'), 'cross-device workspace must expose the device registration view');

    console.log('test-p2p-frontend-bootstrap: ok');
  } finally {
    try {
      await stopServer(server);
    } finally {
      rmSync(instance.home, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
