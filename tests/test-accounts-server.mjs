#!/usr/bin/env node
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import http from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { HARNESS_VERSION_CONTRACTS } from '../lib/harness-version-catalog.mjs';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'agentoc-accounts-server-'));
const { createAccountsServer, createGoogleIdTokenVerifier } = await import(pathToFileURL(join(root, 'accounts/server.mjs')).href);
const identityModule = await import(pathToFileURL(join(root, 'lib/instance-identity.mjs')).href);
process.env.AGENTOC_CONFIG_DIR = join(dir, 'instance-config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
const identity = await identityModule.loadOrCreateInstanceIdentity({ filePath: join(dir, 'instance-identity.json') });

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

const app = await createAccountsServer({
  dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing-key.json'),
  harnessPolicyFile: join(dir, 'harness-policy.json'),
  publicBaseUrl: 'http://127.0.0.1:0/accounts', googleWebClientId: 'test.apps.googleusercontent.com',
  allowInsecurePublicBaseUrl: true,
  audit: (fields) => { auditEvents.push(fields); },
  verifyGoogleCredential: async ({ idToken, nonce }) => {
    assert.equal(idToken, 'test-google-id-token'); assert.match(nonce, /^nonce_/);
    return { providerSubject: 'google-subject-server' };
  },
});
const auditEvents = [];
const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  const handled = await app.handler(req, res, port);
  if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); }
});
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed += 1; console.log(`ok - ${name}`); };

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const builtinPolicy = await request(port, 'GET', '/accounts/v1/harness-policy');
  check('server exposes the builtin harness policy', builtinPolicy.status === 200
    && builtinPolicy.json?.schemaVersion === 2
    && builtinPolicy.json?.policies?.claude?.minimumVersion === HARNESS_VERSION_CONTRACTS.claude.minimumVersion);
  writeFileSync(join(dir, 'harness-policy.json'), JSON.stringify({
    claude: { minimumVersion: '999.0.0', targetVersion: '999.0.0' },
  }));
  const centralPolicy = await request(port, 'GET', '/accounts/v1/harness-policy');
  check('server reloads central harness policy without restart', centralPolicy.status === 200
    && centralPolicy.json?.policies?.claude?.minimumVersion === '999.0.0');
  const tx = 'otx_server_test';
  const returnUrl = `http://instance.test/api/auth/google/complete?tx=${tx}`;
  const issuedAt = new Date().toISOString();
  const proof = identityModule.signInstanceProof(identity, { transactionId: tx, purpose: 'login', returnUrl, issuedAt, audience: 'agentoc-owner-auth' });
  const started = await request(port, 'POST', '/accounts/v1/owner-auth/transactions', {
    transactionId: tx, purpose: 'login', returnUrl, instance: identityModule.publicInstanceIdentity(identity),
    issuedAt, audience: 'agentoc-owner-auth', signature: proof.signature,
  });
  check('server 挂载事务创建 route', started.status === 201 && started.json?.authUrl);
  const pageUrl = new URL(started.json.authUrl.replace('http://127.0.0.1:0', `http://127.0.0.1:${port}`));
  const page = await request(port, 'GET', `${pageUrl.pathname}${pageUrl.search}`);
  const cookies = page.headers['set-cookie'] || [];
  check('server 生成桌面 state 页面', page.status === 200 && cookies.length >= 2 && page.text.includes('ownerAuthContinue'));
  const phoneUrl = new URL(/id="ownerAuthContinue" href="([^"]+)"/.exec(page.text)[1]);
  const phone = await request(port, 'GET', `${phoneUrl.pathname}${phoneUrl.search}`);
  const phoneCookies = phone.headers['set-cookie'] || [];
  check('server 挂载手机 GIS 页面', phone.status === 200 && phoneCookies.length >= 2 && phone.text.includes('gsi/client'));
  const phoneCsrf = String(phoneCookies[1]).split(';')[0].split('=')[1];
  const phoneCredential = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${tx}/phone-google-credential`, { idToken: 'test-google-id-token' }, {
    cookie: phoneCookies.map((value) => value.split(';')[0]).join('; '), origin: 'http://127.0.0.1:0', 'x-agentoc-csrf': phoneCsrf,
  });
  check('server 完成手机 credential', phoneCredential.status === 200 && phoneCredential.json?.completeUrl);
  const desktopCookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const statusPath = `/accounts/v1/owner-auth/transactions/${tx}/desktop-status`;
  const status = await request(port, 'GET', statusPath, undefined, { cookie: desktopCookie });
  check('server 只向桌面报告完成', status.status === 200 && status.json?.status === 'completed' && status.json?.grant === undefined);
  const grantMatch = /const deliveryGrant = "([^"]+)"/.exec(page.text);
  const redeemIssuedAt = new Date().toISOString();
  const redeemProof = identityModule.signInstanceProof(identity, { transactionId: tx, purpose: 'login', returnUrl, issuedAt: redeemIssuedAt, audience: 'agentoc-owner-auth' });
  const redeemed = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${tx}/redeem`, { ...redeemProof, instance: identityModule.publicInstanceIdentity(identity), issuedAt: redeemIssuedAt, grant: grantMatch?.[1] });
  check('server 签发一次性 EdDSA assertion', redeemed.status === 200 && redeemed.json?.assertion?.split('.').length === 3);
  const jwks = await request(port, 'GET', '/.well-known/jwks.json');
  check('server 暴露 signing JWKS', jwks.status === 200 && jwks.json?.keys?.[0]?.alg === 'EdDSA');
  const turnBrokerJwks = await request(port, 'GET', '/.well-known/turn-broker-jwks.json');
  check('server 暴露独立 TURN broker signing JWKS', turnBrokerJwks.status === 200
    && turnBrokerJwks.json?.keys?.[0]?.alg === 'EdDSA'
    && turnBrokerJwks.json?.keys?.[0]?.kid
    && turnBrokerJwks.json?.keys?.[0]?.kid !== jwks.json?.keys?.[0]?.kid);

  const byEvent = (event) => auditEvents.filter((item) => item.event === event);
  check('审计记录事务创建/凭据完成/断言兑换', byEvent('transaction.created').length >= 1 && byEvent('credential.completed').length >= 1 && byEvent('assertion.redeemed').length >= 1);
  check('审计字段不含敏感凭据', JSON.stringify(auditEvents).includes('test-google-id-token') === false);

  const badRedeemIssuedAt = new Date().toISOString();
  const badRedeem = await request(port, 'POST', `/accounts/v1/owner-auth/transactions/${tx}/redeem`, {
    transactionId: tx, purpose: 'login', returnUrl,
    instance: identityModule.publicInstanceIdentity(identity),
    issuedAt: badRedeemIssuedAt, audience: 'agentoc-owner-auth',
    signature: identityModule.signInstanceProof(identity, { transactionId: tx, purpose: 'login', returnUrl, issuedAt: badRedeemIssuedAt, audience: 'agentoc-owner-auth' }).signature,
    grant: 'wrong-grant',
  });
  check('错误 grant 兑换被拒并记录安全审计', badRedeem.status === 410 && byEvent('security.rejected').some((item) => item.code === 'owner_auth_grant_invalid'));
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
  console.log(`test-accounts-server: ${passed} assertions passed`);

// ---------- 每 IP 限流上限解析 ----------
{
  const { resolveAccountsRateLimits } = await import(pathToFileURL(join(root, 'accounts/server.mjs')).href);
  check('默认限流 GET 60 / POST 60（实例常驻轮询不再撞 20/min 上限）', () => {
    const limits = resolveAccountsRateLimits({ env: {} });
    assert.deepEqual(limits, { getMax: 60, postMax: 60, authorityMax: 600 });
  });
  check('环境变量可覆盖限流上限', () => {
    const limits = resolveAccountsRateLimits({ env: { AGENTOC_ACCOUNTS_RATE_LIMIT_GET_MAX: '90', AGENTOC_ACCOUNTS_RATE_LIMIT_POST_MAX: '30' } });
    assert.deepEqual(limits, { getMax: 90, postMax: 30, authorityMax: 600 });
  });
  check('显式 options 优先于环境变量，非法值回退默认', () => {
    assert.deepEqual(
      resolveAccountsRateLimits({ options: { max: 120, postMax: 45 }, env: { AGENTOC_ACCOUNTS_RATE_LIMIT_POST_MAX: '30' } }),
      { getMax: 120, postMax: 45, authorityMax: 600 },
    );
    assert.deepEqual(resolveAccountsRateLimits({ env: { AGENTOC_ACCOUNTS_RATE_LIMIT_POST_MAX: '-5' } }), { getMax: 60, postMax: 60, authorityMax: 600 });
    assert.deepEqual(resolveAccountsRateLimits({ env: { AGENTOC_ACCOUNTS_RATE_LIMIT_POST_MAX: '12.9' } }), { getMax: 60, postMax: 12, authorityMax: 600 });
    assert.equal(resolveAccountsRateLimits({ env: { AGENTOC_ACCOUNTS_RATE_LIMIT_AUTHORITY_MAX: '900' } }).authorityMax, 900);
    assert.equal(resolveAccountsRateLimits({ options: { authorityMax: 12 }, env: { AGENTOC_ACCOUNTS_RATE_LIMIT_AUTHORITY_MAX: '900' } }).authorityMax, 12);
  });
  console.log(`test-accounts-rate-limits: ok`);
}

{
  const { accountsInstanceSyncRateBucket } = await import('../accounts/server.mjs');
  const bucket = (path, body = {}) => accountsInstanceSyncRateBucket(path, body, '/accounts');
  assert.equal(bucket('/accounts/v1/owner-auth/provider-sync/authorize'), 'instance-sync');
  assert.equal(bucket('/accounts/v1/owner-auth/sync/catalog/acct_123'), 'instance-sync');
  assert.equal(bucket('/accounts/v1/owner-auth/devices/acct_123', { purpose: 'devices' }), 'instance-sync');
  assert.equal(bucket('/accounts/v1/owner-auth/turn/connections/reserve'), 'instance-sync');
  assert.equal(bucket('/accounts/v1/owner-auth/devices/acct_123/unbind', { purpose: 'unbind' }), '');
  assert.equal(bucket('/accounts/v1/owner-auth/sync/catalog/acct_123/extra'), '');
  assert.equal(bucket('/accounts/v1/owner-auth/login'), '');
}

// ---------- Google ID token verifier 加固 ----------
{
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'google-test-key';
  const googleJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  let verifierClock = () => nowSeconds * 1000;
  const verifier = createGoogleIdTokenVerifier({
    clientId: 'test.apps.googleusercontent.com',
    clock: verifierClock,
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [googleJwk] }) }),
  });
  const signToken = (claims) => {
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')}`;
  };
  const baseClaims = { iss: 'https://accounts.google.com', aud: 'test.apps.googleusercontent.com', sub: 'google-sub-1', email: 'owner@example.com', iat: nowSeconds, exp: nowSeconds + 3600, nonce: 'nonce_abc' };
  let ok = 0;
  const expect = async (claims, message, shouldResolve = true) => {
    const outcome = await verifier({ idToken: signToken(claims), nonce: 'nonce_abc' }).then(
      () => true,
      () => false,
    );
    assert.equal(outcome, shouldResolve, message);
    ok += 1;
    console.log(`ok - ${message}`);
  };
  await expect(baseClaims, 'verifier 接受合法 Google ID token');
  await expect({ ...baseClaims, iat: nowSeconds + 600 }, 'verifier 拒绝未来签发的 token', false);
  await expect({ ...baseClaims, exp: nowSeconds - 60 }, 'verifier 拒绝过期 token', false);
  await expect({ ...baseClaims, exp: nowSeconds + 48 * 3600 }, 'verifier 拒绝超长有效期 token', false);
  await expect({ ...baseClaims, aud: 'other.apps.googleusercontent.com' }, 'verifier 拒绝错误 audience', false);
  await expect({ ...baseClaims, nonce: 'nonce_wrong' }, 'verifier 拒绝错误 nonce', false);
  await expect({ ...baseClaims, iss: 'https://evil.example' }, 'verifier 拒绝错误 issuer', false);
  console.log(`test-accounts-verifier: ${ok} assertions passed`);
}
