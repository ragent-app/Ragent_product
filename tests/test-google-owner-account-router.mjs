#!/usr/bin/env node
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'agentoc-google-owner-account-router-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.AGENTOC_PUBLIC_BASE_URL = 'https://instance.example.test';
process.env.AGENTOC_AUTH_SESSION_SECRET = 'test-auth-session-secret';
// Exercise the legacy callback route explicitly. Default bind is instance_poll.
process.env.AGENTOC_OWNER_AUTH_DELIVERY_MODE = 'browser_callback';
process.env.SECURE_COOKIES = '0';
delete process.env.AGENTOC_INSTANCE_ROOT;

const configDir = process.env.AGENTOC_CONFIG_DIR;
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'not-used' }));

const signing = generateKeyPairSync('ed25519');
const kid = 'accounts-router-test-key';
const publicJwk = { ...signing.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' };
const started = new Map();

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function makeAssertion(claims) {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid }));
  const payload = b64(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), signing.privateKey).toString('base64url')}`;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.pathname === '/v1/owner-auth/demo-status' && options.method === 'GET') return response(200, { status: 'configured' });
  if (target.pathname === '/v1/owner-auth/transactions' && options.method === 'POST') {
    const body = JSON.parse(options.body);
    started.set(body.transactionId, body);
    return response(201, {
      transactionId: body.transactionId,
      authUrl: `https://accounts.example.test/owner/google?tx=${body.transactionId}`,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
  }
  const redeem = /^\/v1\/owner-auth\/transactions\/([^/]+)\/redeem$/.exec(target.pathname);
  if (redeem && options.method === 'POST') {
    const body = JSON.parse(options.body);
    const record = started.get(decodeURIComponent(redeem[1]));
    if (!record || body.grant !== `grant_${record.transactionId}`) return response(410, { code: 'owner_auth_grant_invalid' });
    return response(200, { assertion: makeAssertion({
      iss: 'https://accounts.example.test', aud: record.instance.instanceId, sub: 'acct_owner_1',
      purpose: record.purpose, tx: record.transactionId, exp: Math.floor(Date.now() / 1000) + 60,
    }) });
  }
  if (target.pathname === '/.well-known/jwks.json') return response(200, { keys: [publicJwk] });
  const deviceList = /^\/v1\/owner-auth\/devices\/([^/]+)$/.exec(target.pathname);
  if (deviceList && options.method === 'POST') {
    const body = JSON.parse(options.body);
    assert.equal(body.accountId, decodeURIComponent(deviceList[1]));
    return response(200, {
      devices: [{
        deviceId: 'dev-1', alias: 'Pinggu', sub: body.accountId,
        boundAt: new Date().toISOString(), unboundAt: null,
        lastSeenAt: new Date().toISOString(), source: 'local',
      }],
    });
  }
  if (target.pathname.endsWith('/history') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    return response(200, { entries: [{ instanceId: 'dev-1', accountId: body.accountId, action: 'bind', occurredAt: new Date().toISOString() }] });
  }
  if (target.pathname.endsWith('/unbind') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    return response(200, { instanceId: 'dev-1', accountId: body.accountId, unboundAt: new Date().toISOString() });
  }
  return response(404, { code: 'not_found' });
};

const { handleGoogleOwnerAuthRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-google-owner-routes.mjs')).href);
const { getOwnerAccountBinding } = await import(pathToFileURL(join(repoRoot, 'lib', 'owner-account-auth.mjs')).href);

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; Object.assign(this.headers, headers); },
    end(body = '') { this.body = body; },
  };
}

function makeReq({ method = 'POST', body, cookie = '', headers = {}, url = '' } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (body === undefined) return { method, headers: requestHeaders, ...(url ? { url } : {}) };
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = requestHeaders;
  if (url) stream.url = url;
  return stream;
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function parseJson(res) {
  return JSON.parse(res.body);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const demoDenied = makeRes();
  await handleGoogleOwnerAuthRoutes({ req: makeReq({ method: 'GET' }), res: demoDenied, pathname: '/api/auth/demo/status', authSession: null, writeJson });
  assert.equal(demoDenied.statusCode, 403);
  const demoStatus = makeRes();
  await handleGoogleOwnerAuthRoutes({ req: makeReq({ method: 'GET' }), res: demoStatus, pathname: '/api/auth/demo/status', authSession: { role: 'owner' }, writeJson });
  assert.deepEqual(parseJson(demoStatus), { status: 'configured' });
  const status = makeRes();
  await handleGoogleOwnerAuthRoutes({ req: makeReq({ method: 'GET' }), res: status, pathname: '/api/auth/google/status', authSession: null, writeJson });
  await check('status 在无本机 OAuth client 时仍以 Accounts broker 启用', async () => {
    assert.deepEqual(parseJson(status), {
      enabled: true,
      bound: false,
      mode: 'accounts',
      contractVersion: 2,
      capabilities: {
        nativeGoogleAuth: false,
        provisionalPairing: true,
        temporaryDeviceAccess: false,
        accountJoin: true,
      },
    });
  });

  const bindStartRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ body: { alias: 'Pinggu\ncomputer' } }), res: bindStartRes, pathname: '/api/auth/google/bind', authSession: { role: 'owner' }, writeJson,
  });
  const bindStart = parseJson(bindStartRes);
  const bindCookie = String(bindStartRes.headers['Set-Cookie']).split(';')[0];
  await check('bind 走 Accounts 而不是本机 client 并写入短时 state cookie', async () => {
    assert.equal(bindStartRes.statusCode, 200);
    assert.equal(bindStart.mode, 'accounts');
    assert.match(bindStart.authUrl, /^https:\/\/accounts\.example\.test\/owner\/google\?tx=/);
    assert.match(bindCookie, /^agentoc_owner_account_state=/);
    assert.equal(started.get(bindStart.transactionId).alias, 'Pinggu computer');
    const transactions = JSON.parse(readFileSync(join(configDir, 'owner-account-transactions.json'), 'utf8'));
    assert.ok(transactions.entries[bindStart.transactionId], JSON.stringify({ transactions, transactionId: bindStart.transactionId }));
  });

  const redirectBindRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({
      method: 'GET',
      url: '/api/auth/google/bind/redirect?alias=Browser%20laptop',
      headers: { host: 'thelab.example.test', 'x-forwarded-host': 'thelab.example.test', 'x-forwarded-proto': 'https' },
    }),
    res: redirectBindRes,
    pathname: '/api/auth/google/bind/redirect',
    authSession: { role: 'owner' },
    writeJson,
  });
  await check('浏览器绑定跳转先设置主站 state cookie 再进入 Accounts', async () => {
    assert.equal(redirectBindRes.statusCode, 302);
    assert.match(redirectBindRes.headers.Location, /^https:\/\/accounts\.example\.test\/owner\/google\?tx=/);
    assert.match(redirectBindRes.headers['Set-Cookie'], /; Path=\//);
    const redirectTx = new URL(redirectBindRes.headers.Location).searchParams.get('tx');
    assert.equal(started.get(redirectTx).returnUrl, 'https://thelab.example.test/api/auth/google/complete?tx=' + encodeURIComponent(redirectTx));
    assert.equal(started.get(redirectTx).alias, 'Browser laptop');
    const transactions = JSON.parse(readFileSync(join(configDir, 'owner-account-transactions.json'), 'utf8'));
    assert.equal(transactions.entries[redirectTx].alias, 'Browser laptop');
  });

  const demoRedirectRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET', url: '/api/auth/google/bind/redirect?flow=demo', headers: { host: 'thelab.example.test' } }),
    res: demoRedirectRes, pathname: '/api/auth/google/bind/redirect', authSession: { role: 'owner' }, writeJson,
  });
  await check('test account entry opens the existing identity transaction at the demo form', async () => {
    assert.equal(demoRedirectRes.statusCode, 302);
    const destination = new URL(demoRedirectRes.headers.Location);
    assert.equal(destination.host, 'accounts.example.test');
    assert.equal(destination.searchParams.get('flow'), 'demo');
    assert.match(demoRedirectRes.headers['Set-Cookie'], /; Path=\//);
  });

  const aliasBindRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({
      body: { alias: 'thelab' },
      headers: { host: 'thelab.example.test', 'x-forwarded-host': 'thelab.example.test', 'x-forwarded-proto': 'https' },
    }),
    res: aliasBindRes,
    pathname: '/api/auth/google/bind',
    authSession: { role: 'owner' },
    writeJson,
  });
  const aliasBind = parseJson(aliasBindRes);
  await check('别名 HTTPS 入口的回调地址与 state cookie 保持同源', async () => {
    assert.equal(aliasBindRes.statusCode, 200);
    assert.equal(started.get(aliasBind.transactionId).returnUrl, `https://thelab.example.test/api/auth/google/complete?tx=${encodeURIComponent(aliasBind.transactionId)}`);
  });

  const bindComplete = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET', cookie: bindCookie }), res: bindComplete,
    pathname: `/api/auth/google/complete?tx=${encodeURIComponent(bindStart.transactionId)}&grant=grant_${encodeURIComponent(bindStart.transactionId)}`,
    authSession: { role: 'owner' }, writeJson,
  });
  await check('bind callback 兑换断言并只落本地 accountId', async () => {
    assert.equal(bindComplete.statusCode, 302);
    assert.equal(bindComplete.headers.Location, '/?google=bound');
    assert.equal((await getOwnerAccountBinding()).accountId, 'acct_owner_1');
  });

  const bindingPath = join(configDir, 'owner-account-binding.json');
  const bindingWithProfile = JSON.parse(readFileSync(bindingPath, 'utf8'));
  bindingWithProfile.accountProfile = {
    displayName: 'Owner Example',
    email: 'owner@example.test',
    photoUrl: 'https://lh3.googleusercontent.com/photo-test',
  };
  writeFileSync(bindingPath, JSON.stringify(bindingWithProfile));
  const signedInStatus = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET' }), res: signedInStatus,
    pathname: '/api/auth/google/status', authSession: { role: 'owner' }, writeJson,
  });
  await check('已认证 status 返回 Google 账号资料', async () => {
    assert.deepEqual(parseJson(signedInStatus).accountProfile, bindingWithProfile.accountProfile);
  });
  const publicBoundStatus = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET' }), res: publicBoundStatus,
    pathname: '/api/auth/google/status', authSession: null, writeJson,
  });
  await check('未认证 status 不泄露 Google 账号资料', async () => {
    assert.equal(parseJson(publicBoundStatus).accountProfile, undefined);
  });

  const loginStartRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq(), res: loginStartRes, pathname: '/api/auth/google/login', authSession: null, writeJson,
  });
  const loginStart = parseJson(loginStartRes);
  const loginCookie = String(loginStartRes.headers['Set-Cookie']).split(';')[0];
  const loginComplete = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET', cookie: loginCookie }), res: loginComplete,
    pathname: `/api/auth/google/complete?tx=${encodeURIComponent(loginStart.transactionId)}&grant=grant_${encodeURIComponent(loginStart.transactionId)}`,
    authSession: null, writeJson,
  });
  await check('login callback 校验本地绑定后签发 owner session', async () => {
    assert.equal(loginComplete.statusCode, 302);
    assert.equal(loginComplete.headers.Location, '/');
    assert.ok(Array.isArray(loginComplete.headers['Set-Cookie']));
    assert.match(loginComplete.headers['Set-Cookie'][0], /^session_token=/);
  });

  // ---------- 设备管理路由（accounts 模式） ----------
  const devicesRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET' }), res: devicesRes, pathname: '/api/auth/google/devices', authSession: { role: 'owner' }, writeJson,
  });
  await check('devices 在 accounts 模式返回服务端设备清单', async () => {
    assert.equal(devicesRes.statusCode, 200);
    const body = parseJson(devicesRes);
    assert.equal(body.mode, 'accounts');
    assert.equal(body.devices[0].sub, 'acct_owner_1');
    assert.equal(body.devices[0].source, 'local');
  });

  const historyRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET' }), res: historyRes, pathname: '/api/auth/google/binding-history', authSession: { role: 'owner' }, writeJson,
  });
  await check('binding-history 在 accounts 模式返回服务端历史', async () => {
    assert.equal(historyRes.statusCode, 200);
    const body = parseJson(historyRes);
    assert.equal(body.mode, 'accounts');
    assert.equal(body.entries[0].action, 'bind');
  });

  const deniedRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'GET' }), res: deniedRes, pathname: '/api/auth/google/devices', authSession: null, writeJson,
  });
  await check('devices 非 owner 会话返回 403', async () => {
    assert.equal(deniedRes.statusCode, 403);
  });

  const unbindRes = makeRes();
  await handleGoogleOwnerAuthRoutes({
    req: makeReq({ method: 'POST' }), res: unbindRes, pathname: '/api/auth/google/unbind', authSession: { role: 'owner' }, writeJson,
  });
  await check('unbind 在 accounts 模式撤销绑定并清空本机文件', async () => {
    assert.equal(unbindRes.statusCode, 200);
    const body = parseJson(unbindRes);
    assert.equal(body.mode, 'accounts');
    assert.ok(body.unboundAt);
    assert.equal(await getOwnerAccountBinding(), null);
  });

  console.log(`test-google-owner-account-router: ${passed} assertions passed`);
} finally {
  const { closeAuthSessionStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href);
  closeAuthSessionStore();
  rmSync(home, { recursive: true, force: true });
}
