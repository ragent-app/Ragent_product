#!/usr/bin/env node
// Trusted-device handshake 验证（已配对设备签名 → 一次性设备访问凭证）：
//  - handshake（公开：配对设备 ID + 时间戳新鲜 + 验签 → 5 分钟一次性 token）
//  - 防御：签名无效/未配对/时间戳过期/token 复用/伪造 token
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-handshake-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'work');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const configDir = process.env.RAGENT_CONFIG_DIR;
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

// 模拟设备 B 的密钥对（配对时自动上报，握手签名用）。
const deviceKey = generateKeyPairSync('ed25519');
const publicKeyPem = deviceKey.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const deviceId = 'device-b-1234';
const OWNER_ACCOUNT_ID = 'acct_owner_123';

const {
  buildHandshakeMessage,
  issueDeviceHandshakeToken,
  consumeDeviceHandshakeToken,
  HANDSHAKE_TTL_MS,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'device-handshake.mjs')).href);
const { handleDeviceHandshakeRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-device-handshake-routes.mjs')).href);

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function makeBodyReq(body, extraHeaders = {}) {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: { host: 'ragent.example.test', ...extraHeaders },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function signMessage(message, keyPair = deviceKey) {
  return sign(null, Buffer.from(message, 'utf8'), keyPair.privateKey).toString('base64url');
}

async function handshake({ pairedDeviceId = deviceId, timestamp = String(Date.now()), keyPair = deviceKey, extraBody = {}, pathname = '/api/device-handshake' } = {}) {
  const message = buildHandshakeMessage({ deviceId: pairedDeviceId, timestamp });
  const signature = signMessage(message, keyPair);
  const res = makeRes();
  await handleDeviceHandshakeRoutes({
    req: makeBodyReq({ deviceId: pairedDeviceId, timestamp, signature, ...extraBody }),
    res, pathname, writeJson,
  });
  return res;
}

const accountBindingPath = join(configDir, 'owner-account-binding.json');
const trustedDevicesPath = join(configDir, 'trusted-devices.json');

// ---------- handshake ----------

{
  // 尚未绑定 owner 账户时，配对设备不能获得设备访问凭证。
  const timestamp = String(Date.now());
  const signature = signMessage(buildHandshakeMessage({ deviceId, timestamp }));
  const res = makeRes();
  await handleDeviceHandshakeRoutes({
    req: makeBodyReq({ deviceId, timestamp, signature }),
    res, pathname: '/api/device-handshake', writeJson,
  });
  check('handshake 未绑定 owner 账户 → 403', res.statusCode === 403);
}

// 现实中这两项都由配对/Accounts 绑定流程落盘；测试直接建立受控 fixture，
// 以确认设备握手没有任何手填公钥入口。
writeFileSync(accountBindingPath, JSON.stringify({ accountId: OWNER_ACCOUNT_ID, provider: 'google', boundAt: new Date().toISOString() }), 'utf8');
writeFileSync(trustedDevicesPath, JSON.stringify({
  version: 1,
  instanceId: 'rli_source',
  devices: [{
    id: deviceId,
    deviceName: 'Test device B',
    platform: 'test',
    devicePublicKey: publicKeyPem,
    authVersion: 2,
    keyAlgorithm: 'ed25519',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revokedAt: '',
  }],
  invitations: [], challenges: [], authTokens: [],
}), 'utf8');

{
  // body 时间戳与签名消息必须是同一个值
  const timestamp = String(Date.now());
  const signature = signMessage(buildHandshakeMessage({ deviceId, timestamp }));
  const res = makeRes();
  await handleDeviceHandshakeRoutes({
    req: makeBodyReq({ deviceId, timestamp, signature }),
    res, pathname: '/api/device-handshake', writeJson,
  });
  check('已配对设备 handshake 正常 → 200 + token', res.statusCode === 200);
  const payload = JSON.parse(res.body);
  check('handshake 返回 token 与过期时间',
    /^[0-9a-f]{48}$/.test(payload.token) && Date.parse(payload.expiresAt) - Date.now() <= HANDSHAKE_TTL_MS);
}

{
  const res = await handshake({ pathname: '/api/sync/handshake' });
  check('旧握手路径仅作为入口切换兼容别名保留', res.statusCode === 200);
}

for (const [method, pathname] of [
  ['GET', '/api/sync/catalog'],
  ['POST', '/api/sync/export'],
  ['POST', '/api/sync/import'],
  ['POST', '/api/sync/register-device'],
]) {
  const res = makeRes();
  const handled = await handleDeviceHandshakeRoutes({
    req: { method, headers: { host: 'ragent.example.test' } },
    res, pathname, writeJson,
  });
  check(`${pathname} 已移除`, handled === false);
}

{
  const res = await handshake({ extraBody: { sub: 'other-account-sub', instanceId: 'user-supplied-id' } });
  check('handshake 不接受客户端账号或 instanceId 作为鉴权输入', res.statusCode === 200);
}

{
  const res = await handshake({ timestamp: String(Date.now() - 10 * 60 * 1000) });
  check('handshake 时间戳过期 → 401', res.statusCode === 401);
}

{
  const res = await handshake({ pairedDeviceId: 'rdev_not_paired' });
  check('handshake 未配对设备 → 409', res.statusCode === 409);
}

{
  const attackerKey = generateKeyPairSync('ed25519');
  const res = await handshake({ keyPair: attackerKey });
  check('handshake 伪造签名 → 401', res.statusCode === 401);
}

// ---------- lib 层凭证生命周期 ----------

{
  const issued = await issueDeviceHandshakeToken({ deviceId, ownerId: OWNER_ACCOUNT_ID, ownerKind: 'account' });
  const consumed = await consumeDeviceHandshakeToken(issued.token);
  check('lib token 签发/消费', consumed?.deviceId === deviceId && consumed?.ownerId === OWNER_ACCOUNT_ID && consumed?.ownerKind === 'account');
  const again = await consumeDeviceHandshakeToken(issued.token);
  check('lib token 二次消费 → null', again === null);
  check('lib 非法 token → null', (await consumeDeviceHandshakeToken('garbage')) === null);
}

console.log(`test-device-handshake: ok (${passed} assertions)`);
rmSync(tempHome, { recursive: true, force: true });
