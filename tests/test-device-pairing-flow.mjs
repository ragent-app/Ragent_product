#!/usr/bin/env node
import assert from 'assert/strict';
import { createHmac, randomBytes, scryptSync } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-session';
const ownerToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// 测试进程也会 import auth.mjs（loadAuthSessions 在模块加载时执行），先注入 secret 避免噪音警告
process.env.RAGENT_AUTH_SESSION_SECRET = sessionSecret;
// e43264c 起会话键为 HMAC(secret, cookie值) 的 s+hex 摘要，不再接受明文 cookie 键
const hashedOwnerSession = `s${createHmac('sha256', sessionSecret).update('test-session').digest('hex')}`;
const hashedVisitorSession = `s${createHmac('sha256', sessionSecret).update('visitor-session').digest('hex')}`;
const passwordSalt = randomBytes(16);
const passwordHash = `scrypt$16384$8$1$${passwordSalt.toString('hex')}$${scryptSync('test-password-123', passwordSalt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`;

function randomPort() {
  return 41000 + Math.floor(Math.random() * 2000);
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

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    };
    if (!Object.prototype.hasOwnProperty.call(headers, 'Cookie')) {
      requestHeaders.Cookie = ownerCookie;
    } else if (requestHeaders.Cookie === undefined) {
      delete requestHeaders.Cookie;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function setupTempInstance() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-device-pairing-'));
  const configDir = join(home, 'config');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    username: 'andy',
    passwordHash,
  }, null, 2));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [hashedOwnerSession]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    [hashedVisitorSession]: { expiry: Date.now() + 60 * 60 * 1000, role: 'visitor', visitorId: 'visitor-test' },
  }, null, 2));
  writeFileSync(join(configDir, 'tools.json'), '[]\n');
  const qrCommand = join(binDir, 'qrcode-terminal');
  writeFileSync(qrCommand, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write('[[QR]]' + input.trim() + '\\n'));
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
      PATH: `${binDir}:${process.env.PATH}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_AUTH_SESSION_SECRET: sessionSecret,
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
      return (await request(port, 'GET', '/api/auth/me')).status === 200;
    } catch {
      return false;
    }
  }, 'pairing test server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'pairing test server shutdown');
}

const instance = await setupTempInstance();
const port = randomPort();
let server = null;

try {
  server = await startServer({ ...instance, port });

  const unauthenticated = await request(
    port,
    'POST',
    '/api/device-pairing/invitations',
    { endpoint: 'https://control.example.test' },
    { Cookie: undefined },
  );
  assert.equal(unauthenticated.status, 401, 'creating an invitation should require owner authentication');

  const visitorAttempt = await request(
    port,
    'POST',
    '/api/device-pairing/invitations',
    { endpoint: 'https://control.example.test' },
    { Cookie: 'visitor_session_token=visitor-session' },
  );
  assert.equal(visitorAttempt.status, 403, 'visitor sessions must not manage trusted-device pairing');

  const created = await request(port, 'POST', '/api/device-pairing/invitations', {
    endpoint: 'http://192.168.1.20:7690',
    signalingEndpoint: 'https://signal.example.test',
    ttlMs: 120000,
  });
  assert.equal(created.status, 201, created.text);
  const invitation = created.json?.invitation;
  assert.match(invitation?.token || '', /^rpi_[A-Za-z0-9_-]{32}$/);
  assert.match(invitation?.shortCode || '', /^[A-F0-9]{8}$/);
  assert.match(invitation?.pairingUri || '', /^ragent:\/\/pair\?/);
  assert.ok(invitation.pairingUri.includes(encodeURIComponent(invitation.token)));
  const pairingUri = new URL(invitation.pairingUri);
  assert.equal(pairingUri.searchParams.get('i'), invitation.instanceId, 'v3 QR uses compact instance field');
  assert.equal(invitation.endpoint, '', 'v3 invitation is endpoint-less');
  assert.equal(pairingUri.searchParams.has('e'), false, 'v3 QR omits the endpoint field');
  assert.equal(pairingUri.searchParams.get('t'), invitation.token, 'v3 QR uses compact one-time token field');
  assert.equal(pairingUri.searchParams.get('x'), invitation.expiresAt, 'v3 QR uses compact expiry field');
  assert.equal(pairingUri.searchParams.get('p'), invitation.instance.publicKey, 'v3 QR carries the target public identity');
  assert.equal(pairingUri.searchParams.get('f'), invitation.instance.keyFingerprint, 'v3 QR carries the target key fingerprint');
  assert.equal(pairingUri.searchParams.has('instance'), false, 'v3 QR omits long field names to preserve module size');
  assert.equal(pairingUri.searchParams.has('transport'), false, 'QR carries only the account-claim handoff, not bootstrap transport metadata');
  assert.equal(pairingUri.searchParams.has('signal'), false, 'QR must not include the P2P signaling endpoint');
  assert.equal(pairingUri.searchParams.has('room'), false, 'QR must not include a P2P room id');
  const persistedBeforeClaim = readFileSync(join(instance.configDir, 'trusted-devices.json'), 'utf8');
  assert.equal(persistedBeforeClaim.includes(invitation.token), false, 'plaintext invitation token must not be persisted');
  assert.equal(persistedBeforeClaim.includes(invitation.shortCode), false, 'plaintext short code must not be persisted');

  const legacyRedeem = await request(port, 'POST', '/api/device-pairing/redeem', {
    token: invitation.token,
    deviceName: 'Test Android',
    platform: 'android',
    devicePublicKey: 'test-ed25519-public-key',
  }, { Cookie: undefined });
  assert.equal(legacyRedeem.status, 401, 'legacy redeem must remain unavailable');

  const shortCodeInvitationRes = await request(port, 'POST', '/api/device-pairing/invitations', {
    endpoint: 'https://control.example.test',
  });
  assert.equal(shortCodeInvitationRes.status, 201, shortCodeInvitationRes.text);
  const shortCodeInvitation = shortCodeInvitationRes.json.invitation;
  const shortCodeRedeem = await request(port, 'POST', '/api/device-pairing/redeem', {
    shortCode: shortCodeInvitation.shortCode.toLowerCase(),
    deviceName: 'Short Code Android',
    platform: 'android',
    devicePublicKey: 'short-code-public-key',
  }, { Cookie: undefined });
  assert.equal(shortCodeRedeem.status, 401, 'short-code redeem must remain unavailable');

  console.log('test-device-pairing-flow: ok');
} finally {
  await stopServer(server);
  rmSync(instance.home, { recursive: true, force: true });
}
