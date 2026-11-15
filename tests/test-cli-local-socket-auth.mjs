#!/usr/bin/env node
// 本机 CLI 身份通道（unix socket）端到端验证：
// 1) TCP 网络请求 /api/cli/auth 必须 404（网络不可达）
// 2) unix socket 签发 owner 会话，cookie 可用于 owner-only 路由
// 3) socket 文件权限必须 0600
// 4) cli.js api 子进程经 socket 免密调用 owner 路由成功
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function randomPort() {
  return 38000 + Math.floor(Math.random() * 4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function tcpRequest(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function socketRequest(socketPath, method, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, headers: extraHeaders },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeTempInstance() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-cli-socket-'));
  const configDir = join(home, '.config', 'ragent');
  mkdirSync(configDir, { recursive: true });
  // chat-server 启动要求 auth.json 存在（auth 模块顶层加载）
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ username: 'test', passwordHash: 'scrypt$1$1$1$00$00' }),
    'utf8',
  );
  return { home, configDir };
}

async function startServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_AUTH_SESSION_SECRET: 'test-cli-socket-secret',
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const cliSocketPath = join(configDir, 'ragent-cli.sock');
  await waitFor(async () => {
    try {
      const res = await tcpRequest(port, 'GET', '/healthz');
      return res.status === 200 && child.exitCode === null;
    } catch {
      return false;
    }
  }, 'server startup');
  await waitFor(async () => {
    try {
      const res = await socketRequest(cliSocketPath, 'POST', '/api/cli/auth');
      return res.status === 201;
    } catch {
      return false;
    }
  }, 'cli socket ready');
  return { child, cliSocketPath, getStderr: () => stderr };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function runCliApi({ env, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.js', 'api', ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const { home, configDir } = makeTempInstance();
  const port = randomPort();
  const server = await startServer({ home, configDir, port });
  const { cliSocketPath } = server;
  let failed = false;
  try {
    // 1) 网络请求不可达
    const net = await tcpRequest(port, 'POST', '/api/cli/auth');
    assert.equal(net.status, 404, 'TCP /api/cli/auth must be 404 (network unreachable)');

    // 2) socket 文件权限 0600
    const mode = statSync(cliSocketPath).mode & 0o777;
    assert.equal(mode, 0o600, `cli socket mode must be 0600, got ${mode.toString(8)}`);

    // 3) socket 签发 owner 会话
    const sres = await socketRequest(cliSocketPath, 'POST', '/api/cli/auth');
    assert.equal(sres.status, 201, 'socket /api/cli/auth must be 201');
    const setCookieHeader = sres.headers['set-cookie'];
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader || '');
    const cookie = raw.split(';')[0].trim();
    assert.ok(cookie.startsWith('session_token='), `cookie expected session_token=, got ${cookie.split('=')[0]}`);

    // 4) cookie 可访问 owner-only 路由（/api/models）
    const ownerRes = await tcpRequest(port, 'GET', '/api/models', null, { Cookie: cookie });
    assert.equal(ownerRes.status, 200, 'owner cookie must access /api/models');
    const anonRes = await tcpRequest(port, 'GET', '/api/models');
    assert.ok(anonRes.status === 401 || anonRes.status === 403, `anonymous /api/models must be rejected, got ${anonRes.status}`);

    // 5) cli.js api 子进程经 socket 免密调用 owner 路由
    const cli = await runCliApi({
      env: {
        RAGENT_CONFIG_DIR: configDir,
        RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
        HOME: home,
        RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
        RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      },
      args: ['GET', '/api/models', '--base-url', `http://127.0.0.1:${port}`],
    });
    assert.equal(cli.code, 0, `cli api should exit 0, stderr=${cli.stderr}`);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.ok(Array.isArray(parsed) || parsed && typeof parsed === 'object', 'cli api should return JSON payload');
    console.log(`test-cli-local-socket-auth: ok (5 assertions, port ${port})`);
  } catch (error) {
    failed = true;
    console.error(`test-cli-local-socket-auth: FAILED`);
    console.error(error && error.stack || error);
    console.error('--- server stderr ---');
    console.error(server.getStderr());
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

await main();
