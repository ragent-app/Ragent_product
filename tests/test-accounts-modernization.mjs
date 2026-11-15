#!/usr/bin/env node
// Accounts 服务现代化验收：健康检查、安全响应头、限流、日志 redact、
// fail-closed readyz、优雅关闭。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ragent-accounts-modernization-'));
const { startAccountsServer } = await import(pathToFileURL(join(root, 'accounts/server.mjs')).href);
const { createAccountsLogger } = await import(pathToFileURL(join(root, 'accounts/log.mjs')).href);
const identityModule = await import(pathToFileURL(join(root, 'lib/instance-identity.mjs')).href);
process.env.RAGENT_CONFIG_DIR = join(dir, 'instance-config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
const identity = await identityModule.loadOrCreateInstanceIdentity({ filePath: join(dir, 'instance-identity.json') });

function jsonRequest(port, method, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let passed = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  passed += 1;
  console.log(`ok - ${name}`);
};

// 1. 日志 redact：敏感字段绝不落盘
{
  const chunks = [];
  const capture = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createAccountsLogger({ level: 'info', stream: capture });
  logger.info({ idToken: 'tok-123', email: 'owner@example.com', grant: 'g-456', deliveryGrant: 'dg-789', accountJoinGrant: 'rajg-123', token: 'rac-123', path: '/owner/google' }, 'redact');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const out = chunks.join('');
  check('日志 redact 顶层敏感字段', !out.includes('tok-123') && !out.includes('owner@example.com') && !out.includes('g-456') && !out.includes('dg-789') && !out.includes('rajg-123') && !out.includes('rac-123'));
  check('日志 redact 输出占位符', out.includes('[redacted]'));
}

// 2. 服务级：健康检查、安全头、限流、fail-closed readyz
{
  const app = await startAccountsServer({
    dataFile: join(dir, 'accounts.json'),
    signingKeyFile: join(dir, 'signing-key.json'),
    publicBaseUrl: 'http://127.0.0.1:0/accounts',
    googleWebClientId: 'test.apps.googleusercontent.com',
    allowInsecurePublicBaseUrl: true,
    port: 0,
    rateLimit: { max: 2, postMax: 3 },
  });
  const port = app.server.address().port;

  const health = await jsonRequest(port, 'GET', '/healthz');
  check('GET /healthz 返回 200', health.status === 200);
  const ready = await jsonRequest(port, 'GET', '/readyz');
  check('GET /readyz 返回 ready（file store + 签名密钥）', ready.status === 200 && (await ready.json()).status === 'ready');

  const tx = 'otx_modern_1';
  const returnUrl = `http://instance.test/api/auth/google/complete?tx=${tx}`;
  const issuedAt = new Date().toISOString();
  const proof = identityModule.signInstanceProof(identity, { transactionId: tx, purpose: 'login', returnUrl, issuedAt, audience: 'ragent-owner-auth' });
  const started = await jsonRequest(port, 'POST', '/accounts/v1/owner-auth/transactions', {
    transactionId: tx,
    purpose: 'login',
    returnUrl,
    instance: identityModule.publicInstanceIdentity(identity),
    issuedAt,
    audience: 'ragent-owner-auth',
    signature: proof.signature,
  });
  check('事务创建 route 正常（POST 限流内）', started.status === 201);

  const startedBody = await started.json();
  const authUrl = new URL(startedBody.authUrl.replace('http://127.0.0.1:0', `http://127.0.0.1:${port}`));
  const page = await jsonRequest(port, 'GET', `${authUrl.pathname}?${authUrl.searchParams.toString()}`);
  const pageHeaders = page.headers;
  check('页面带 X-Content-Type-Options', pageHeaders.get('x-content-type-options') === 'nosniff');
  check('页面带 X-Frame-Options DENY', pageHeaders.get('x-frame-options') === 'DENY');
  check('页面带 Referrer-Policy no-referrer', pageHeaders.get('referrer-policy') === 'no-referrer');
  check('页面带 CSP 且无缓存', Boolean(pageHeaders.get('content-security-policy')) && pageHeaders.get('cache-control')?.includes('no-store'));

  const json = await jsonRequest(port, 'GET', `/.well-known/jwks.json`);
  check('JSON 响应带安全头', json.headers.get('x-content-type-options') === 'nosniff' && json.headers.get('x-frame-options') === 'DENY');

  const deviceIssuedAt = new Date().toISOString();
  const deviceProof = identityModule.signOwnerAuthDeviceProof(identity, {
    transactionId: 'op_dev_http_1', purpose: 'devices',
    issuedAt: deviceIssuedAt, audience: 'ragent-owner-auth-device',
  });
  const deviceList = await jsonRequest(port, 'POST', '/accounts/v1/owner-auth/devices/acct_google_http', {
    transactionId: 'op_dev_http_1', purpose: 'devices',
    instance: identityModule.publicInstanceIdentity(identity),
    issuedAt: deviceIssuedAt, audience: 'ragent-owner-auth-device',
    signature: deviceProof.signature,
  });
  check('设备清单 route 对未绑定实例返回 403 mismatch（HTTP 接线）', deviceList.status === 403);

  const unbindIssuedAt = new Date().toISOString();
  const unbindProof = identityModule.signOwnerAuthDeviceProof(identity, {
    transactionId: 'op_unbind_http_1', purpose: 'unbind',
    issuedAt: unbindIssuedAt, audience: 'ragent-owner-auth-device',
  });
  const unbindList = await jsonRequest(port, 'POST', '/accounts/v1/owner-auth/devices/acct_google_http/unbind', {
    transactionId: 'op_unbind_http_1', purpose: 'unbind',
    instance: identityModule.publicInstanceIdentity(identity),
    issuedAt: unbindIssuedAt, audience: 'ragent-owner-auth-device',
    signature: unbindProof.signature,
  });
  check('unbind route 对未绑定实例返回 404 binding missing（HTTP 接线）', unbindList.status === 404);

  const overflow = [];
  for (let index = 0; index < 4; index += 1) overflow.push((await jsonRequest(port, 'GET', '/nope')).status);
  check('GET 超过限流后返回 429', overflow.includes(429));

  const postOverflow = [];
  for (let index = 0; index < 4; index += 1) postOverflow.push((await jsonRequest(port, 'POST', '/nope', {})).status);
  check('POST 超过限流后返回 429', postOverflow.includes(429));

  await app.close();
}

// 3. fail-closed：store 不可用时 readyz 返回 503
{
  const brokenStore = {
    mutate: async (mutator) => mutator({ accounts: [], ownerAuthTransactions: [] }),
    ping: async () => {
      throw new Error('database unavailable');
    },
    close: async () => {},
  };
  const app = await startAccountsServer({
    store: brokenStore,
    signingKeyFile: join(dir, 'signing-key-2.json'),
    publicBaseUrl: 'http://127.0.0.1:0/accounts',
    googleWebClientId: 'test.apps.googleusercontent.com',
    allowInsecurePublicBaseUrl: true,
    port: 0,
  });
  const port = app.server.address().port;
  const ready = await jsonRequest(port, 'GET', '/readyz');
  check('数据库不可用时 readyz 返回 503（fail-closed）', ready.status === 503);
  await app.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-accounts-modernization: ${passed} assertions passed`);
