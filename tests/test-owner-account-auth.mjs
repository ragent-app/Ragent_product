#!/usr/bin/env node
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'agentoc-owner-account-auth-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.AGENTOC_PUBLIC_BASE_URL = 'https://instance.example.test';
process.env.SECURE_COOKIES = '0';
delete process.env.AGENTOC_INSTANCE_ROOT;

const {
  getOwnerAccountBinding,
  getOwnerAccountBrokerStatus,
  getDemoSignInStatus,
  getOwnerAccountBindingHistory,
  listOwnerAccountDevices,
  publishOwnerAccountEndpoint,
  startOwnerAccountAuth,
  completeOwnerAccountAuth,
  unbindOwnerAccount,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'owner-account-auth.mjs')).href);

const signing = generateKeyPairSync('ed25519');
assert.equal(await getDemoSignInStatus({ fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'configured' }) }) }), 'configured');
assert.equal(await getDemoSignInStatus({ fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'unconfigured' }) }) }), 'unconfigured');
assert.equal(await getDemoSignInStatus({ fetchImpl: async () => ({ ok: false }) }), 'unavailable');
assert.equal(await getDemoSignInStatus({ fetchImpl: async () => { throw new Error('offline'); } }), 'unavailable');
const kid = 'accounts-test-key';
const publicJwk = { ...signing.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' };
let now = Date.parse('2026-08-09T12:00:00.000Z');
const brokerTransactions = new Map();
const deviceOps = [];

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signAssertion(claims) {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid }));
  const payload = base64Url(JSON.stringify(claims));
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message, 'utf8'), signing.privateKey).toString('base64url')}`;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function mockFetch(url, options = {}) {
  const target = new URL(url);
  if (target.pathname === '/v1/owner-auth/transactions' && options.method === 'POST') {
    const body = JSON.parse(options.body);
    brokerTransactions.set(body.transactionId, body);
    return response(201, {
      transactionId: body.transactionId,
      authUrl: `https://accounts.example.test/owner/bind?tx=${encodeURIComponent(body.transactionId)}`,
      expiresAt: new Date(now + 300000).toISOString(),
    });
  }
  const redeem = /^\/v1\/owner-auth\/transactions\/([^/]+)\/redeem$/.exec(target.pathname);
  if (redeem && options.method === 'POST') {
    const body = JSON.parse(options.body);
    const created = brokerTransactions.get(decodeURIComponent(redeem[1]));
    if (!created || body.grant !== `grant_${created.transactionId}`) return response(410, { code: 'owner_auth_grant_invalid' });
    return response(200, {
      assertion: signAssertion({
        iss: 'https://accounts.example.test',
        aud: created.instance.instanceId,
        sub: 'acct_owner_1',
        ...(created.purpose === 'bind' ? { provider: 'demo' } : {}),
        purpose: created.purpose,
        tx: created.transactionId,
        exp: Math.floor(now / 1000) + 60,
      }),
    });
  }
  if (target.pathname === '/.well-known/jwks.json') return response(200, { keys: [publicJwk] });
  const deviceList = /^\/v1\/owner-auth\/devices\/([^/]+)$/.exec(target.pathname);
  if (deviceList && options.method === 'POST') {
    const body = JSON.parse(options.body);
    deviceOps.push({ path: target.pathname, ...body });
    return response(200, {
      devices: [{
        deviceId: 'dev-1', alias: 'Pinggu', sub: deviceList[1],
        boundAt: new Date(now).toISOString(), unboundAt: null,
        lastSeenAt: new Date(now).toISOString(), source: 'local',
      }],
    });
  }
  if (target.pathname.endsWith('/history') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    deviceOps.push({ path: target.pathname, ...body });
    return response(200, { entries: [{ instanceId: 'dev-1', action: 'bind', occurredAt: new Date(now).toISOString() }] });
  }
  if (target.pathname.endsWith('/unbind') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    deviceOps.push({ path: target.pathname, ...body });
    return response(200, { instanceId: 'dev-1', accountId: body.accountId, unboundAt: new Date(now).toISOString() });
  }
  if (target.pathname.endsWith('/endpoint') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    deviceOps.push({ path: target.pathname, ...body });
    return response(200, {
      instanceId: 'dev-1',
      accountId: body.accountId,
      publicEndpoint: body.publicEndpoint,
      updatedAt: new Date(now).toISOString(),
      changed: true,
    });
  }
  if (target.pathname.endsWith('/identity') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    deviceOps.push({ path: target.pathname, ...body });
    return response(200, {
      instanceId: 'dev-1',
      accountId: body.accountId,
      instancePublicKey: body.instance.publicKey,
      instanceKeyFingerprint: body.instance.keyFingerprint,
      updatedAt: new Date(now).toISOString(),
      changed: true,
    });
  }
  return response(404, { code: 'not_found' });
}

async function legacyAccountsFetch(url, options = {}) {
  const body = options.body ? JSON.parse(options.body) : {};
  const target = new URL(url);
  if (/^\/v1\/owner-auth\/devices\/[^/]+/.test(target.pathname)
    && options.method === 'POST' && body.audience === 'agentoc-owner-auth-device') {
    return response(400, { code: 'owner_auth_request_invalid' });
  }
  return mockFetch(url, options);
}

function reqWithStateCookie(start) {
  return { headers: { cookie: start.stateCookie.split(';')[0] } };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  await check('broker 配置状态不依赖本机 OAuth client 文件', async () => {
    assert.deepEqual(getOwnerAccountBrokerStatus(), {
      enabled: true,
      configured: true,
      mode: 'accounts',
      accountsUrl: 'https://accounts.example.test',
    });
  });

  const defaultBindStart = await startOwnerAccountAuth({ purpose: 'bind', alias: 'Default poll bind', fetchImpl: mockFetch, clock: () => now });
  await check('bind 默认使用 instance_poll，即使配置了公网地址', async () => {
    assert.equal(defaultBindStart.deliveryMode, 'instance_poll');
    assert.equal(defaultBindStart.stateCookie, undefined);
    const request = brokerTransactions.get(defaultBindStart.transactionId);
    assert.equal(request.deliveryMode, 'instance_poll');
    assert.equal(request.returnUrl, undefined);
    assert.equal(request.alias, 'Default poll bind');
  });

  const bindStart = await startOwnerAccountAuth({ purpose: 'bind', alias: 'Pinggu', deliveryMode: 'browser_callback', fetchImpl: mockFetch, clock: () => now });
  await check('实例创建签名 bind 事务并只接受 Accounts 域 authUrl', async () => {
    assert.match(bindStart.transactionId, /^otx_/);
    assert.match(bindStart.authUrl, /^https:\/\/accounts\.example\.test\/owner\/bind\?tx=/);
    assert.match(bindStart.stateCookie, /^agentoc_owner_account_state=/);
    assert.match(bindStart.stateCookie, /; Path=\//);
    assert.doesNotMatch(bindStart.stateCookie, /; Path=\/api\/auth\/google\/complete/);
    assert.equal(brokerTransactions.get(bindStart.transactionId).returnUrl, `https://instance.example.test/api/auth/google/complete?tx=${encodeURIComponent(bindStart.transactionId)}`);
    assert.equal(brokerTransactions.get(bindStart.transactionId).alias, 'Pinggu');
  });

  const bound = await completeOwnerAccountAuth({
    req: reqWithStateCookie(bindStart),
    transactionId: bindStart.transactionId,
    grant: `grant_${bindStart.transactionId}`,
    authSession: { role: 'owner' },
    fetchImpl: mockFetch,
    clock: () => now,
  });
  await check('bind 仅在本机 owner 会话下写入 accountId 绑定', async () => {
    assert.deepEqual(bound, { purpose: 'bind', accountId: 'acct_owner_1' });
    assert.deepEqual(await getOwnerAccountBinding(), {
      accountId: 'acct_owner_1',
      provider: 'demo',
      boundAt: new Date(now).toISOString(),
      deviceAlias: 'Pinggu',
      plan: 'free',
      limits: { phones: 1, computers: 1 },
    });
  });

  await check('bind 后用实例签名把 canonical endpoint 发布到 Accounts', async () => {
    const op = deviceOps.find((item) => item.path.endsWith('/endpoint'));
    assert.ok(op);
    assert.equal(op.purpose, 'publish-endpoint');
    assert.equal(op.publicEndpoint, 'https://instance.example.test');
    assert.equal(op.audience, 'agentoc-owner-auth-device');
    assert.ok(op.signature);
  });

  const explicitEndpoint = await publishOwnerAccountEndpoint({
    publicBaseUrl: 'https://instance.example.test',
    fetchImpl: mockFetch,
    clock: () => now,
  });
  await check('已绑定实例可幂等重复发布 endpoint', async () => {
    assert.equal(explicitEndpoint.published, true);
    assert.equal(explicitEndpoint.publicEndpoint, 'https://instance.example.test');
  });

  const identityPublished = await publishOwnerAccountEndpoint({ publicBaseUrl: '', fetchImpl: mockFetch, clock: () => now });
  await check('无 endpoint 时仍可发布实例 rendezvous 身份', async () => {
    assert.equal(identityPublished.published, false);
    assert.equal(identityPublished.identityPublished, true);
    const op = deviceOps.at(-1);
    assert.equal(op.purpose, 'publish-identity');
    assert.match(op.path, /\/identity$/);
    assert.equal(op.publicEndpoint, undefined);
    assert.ok(op.signature);
  });

  const loginStart = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
  const loggedIn = await completeOwnerAccountAuth({
    req: reqWithStateCookie(loginStart),
    transactionId: loginStart.transactionId,
    grant: `grant_${loginStart.transactionId}`,
    authSession: null,
    fetchImpl: mockFetch,
    clock: () => now,
  });
  await check('login 只接受已绑定的 accountId', async () => {
    assert.deepEqual(loggedIn, { purpose: 'login', accountId: 'acct_owner_1' });
  });

  const replayStart = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
  await check('错误 state cookie 在访问 broker 前被拒绝', async () => {
    await assert.rejects(() => completeOwnerAccountAuth({
      req: { headers: { cookie: 'agentoc_owner_account_state=wrong.state' } },
      transactionId: replayStart.transactionId,
      grant: `grant_${replayStart.transactionId}`,
      fetchImpl: mockFetch,
      clock: () => now,
    }), { code: 'owner_auth_state_invalid' });
  });

  await check('bind 回调在 owner 会话失效后被拒绝', async () => {
    const start = await startOwnerAccountAuth({ purpose: 'bind', deliveryMode: 'browser_callback', fetchImpl: mockFetch, clock: () => now });
    await assert.rejects(() => completeOwnerAccountAuth({
      req: reqWithStateCookie(start),
      transactionId: start.transactionId,
      grant: `grant_${start.transactionId}`,
      authSession: null,
      fetchImpl: mockFetch,
      clock: () => now,
    }), { code: 'owner_auth_owner_required' });
  });

  // ---------- 设备管理：devices / history / unbind ----------
  const legacyDeviceList = await listOwnerAccountDevices({ fetchImpl: legacyAccountsFetch, clock: () => now });
  await check('旧 Accounts 服务拒绝新 audience 时回退旧 device proof', async () => {
    assert.equal(legacyDeviceList.devices.length, 1);
    const op = deviceOps.at(-1);
    assert.equal(op.audience, 'agentoc-owner-auth');
    assert.ok(op.returnUrl);
    assert.match(op.returnUrl, /^https:\/\/instance\.example\.test\/api\/auth\/google\/complete\?tx=/);
  });

  const deviceList = await listOwnerAccountDevices({ fetchImpl: mockFetch, clock: () => now });
  await check('listOwnerAccountDevices 用 devices proof 走设备端点', async () => {
    assert.equal(deviceList.devices.length, 1);
    assert.equal(deviceList.devices[0].source, 'local');
    const op = deviceOps.at(-1);
    assert.equal(op.purpose, 'devices');
    assert.equal(op.accountId, 'acct_owner_1');
    assert.match(op.path, /^\/v1\/owner-auth\/devices\/acct_owner_1$/);
    assert.ok(op.signature);
    assert.ok(op.issuedAt);
    assert.equal(op.audience, 'agentoc-owner-auth-device');
    assert.equal(op.returnUrl, undefined);
  });

  const history = await getOwnerAccountBindingHistory({ fetchImpl: mockFetch, clock: () => now });
  await check('getOwnerAccountBindingHistory 用 history proof 走历史端点', async () => {
    assert.equal(history.entries[0].action, 'bind');
    const op = deviceOps.at(-1);
    assert.equal(op.purpose, 'history');
    assert.match(op.path, /^\/v1\/owner-auth\/devices\/acct_owner_1\/history$/);
  });

  const unbound = await unbindOwnerAccount({ fetchImpl: mockFetch, clock: () => now });
  await check('unbindOwnerAccount 用 unbind proof 并清空本机绑定', async () => {
    assert.ok(unbound.unboundAt);
    const op = deviceOps.at(-1);
    assert.equal(op.purpose, 'unbind');
    assert.match(op.path, /^\/v1\/owner-auth\/devices\/acct_owner_1\/unbind$/);
    assert.equal(await getOwnerAccountBinding(), null);
  });

  await check('未绑定实例的设备操作直接拒绝', async () => {
    await assert.rejects(() => listOwnerAccountDevices({ fetchImpl: mockFetch, clock: () => now }), { code: 'owner_auth_not_bound' });
  });

  console.log(`test-owner-account-auth: ${passed} assertions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
