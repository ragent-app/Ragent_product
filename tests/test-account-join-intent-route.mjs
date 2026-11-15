#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const home = mkdtempSync(join(tmpdir(), 'ragent-account-join-route-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.RAGENT_PUBLIC_BASE_URL = 'https://instance.example.test';
process.env.RAGENT_ACCOUNT_JOIN_ENABLED = '0';
delete process.env.RAGENT_INSTANCE_ROOT;
mkdirSync(process.env.RAGENT_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.RAGENT_CONFIG_DIR, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused' }));
writeFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_route_test',
  instanceSecret: 'secret',
  createdAt: new Date().toISOString(),
  invitations: [],
  devices: [],
  challenges: [],
  authTokens: [],
}));

const { handleDevicePairingPublicRoutes } = await import('../chat/router-device-pairing-routes.mjs');
const { handleOwnerAuthRoutes } = await import('../accounts/owner-auth-routes.mjs');
const { buildAccountJoinIntentMessage } = await import('../lib/device-auth-protocol.mjs');
const { createTrustedDeviceInvitation } = await import('../chat/trusted-devices.mjs');

const accountsSigning = generateKeyPairSync('ed25519');
const accountsKid = 'accounts-join-test';
const accountsJwk = { ...accountsSigning.publicKey.export({ format: 'jwk' }), kid: accountsKid, alg: 'EdDSA', use: 'sig' };
function signAssertion(claims) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid: accountsKid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${cryptoSign(null, Buffer.from(message), accountsSigning.privateKey).toString('base64url')}`;
}

let observedGrantOnlyCompletion = false;
let observedCreateComputerAlias = '';

globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.pathname === '/v1/owner-auth/account-intents') {
    const body = JSON.parse(options.body);
    observedCreateComputerAlias = body.computerAlias || '';
    return { ok: true, status: 201, json: async () => ({
      intentId: body.intentId,
      instanceId: body.instance.instanceId,
      deviceId: body.device.deviceId,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }) };
  }
  if (/^\/v1\/owner-auth\/account-intents\/[^/]+\/complete$/.test(target.pathname)) {
    const body = JSON.parse(options.body);
    if (body.accountJoinGrant) {
      assert.equal(body.idToken, undefined);
      observedGrantOnlyCompletion = true;
    }
    const requestId = options.headers['Idempotency-Key'];
    return { ok: true, status: 200, json: async () => ({
      assertion: signAssertion({
        iss: 'https://accounts.example.test',
        aud: body.instance.instanceId,
        sub: 'acct_google_owner',
        purpose: 'account_join',
        tx: requestId,
        intentId: target.pathname.split('/').at(-2),
        deviceId: body.device.deviceId,
        devicePublicKeyFingerprint: body.device.devicePublicKeyFingerprint,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
      deviceState: 'bound',
      deviceId: body.device.deviceId,
    }) };
  }
  if (target.pathname === '/.well-known/jwks.json') {
    return { ok: true, status: 200, json: async () => ({ keys: [accountsJwk] }) };
  }
  return { ok: false, status: 404, json: async () => ({ code: 'not_found' }) };
};

function request(body, headers = {}) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = 'POST';
  stream.headers = headers;
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}
function response() {
  return {
    statusCode: 200,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body = '') { this.body = body; },
  };
}
function writeJson(res, statusCode, value) {
  res.writeHead(statusCode);
  res.end(JSON.stringify(value));
}

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

try {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ devicePublicKey: publicKey }),
    res,
    pathname: '/api/device-pairing/account-intents',
    writeJson,
  });
  check('account join capability disabled returns account_join_disabled', () => {
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'account_join_disabled');
  });

  process.env.RAGENT_ACCOUNT_JOIN_ENABLED = '1';
  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ devicePublicKey: publicKey, deviceName: 'Pixel route' }),
    res,
    pathname: '/api/device-pairing/account-intents',
    writeJson,
  });
  check('an unbound computer rejects QR-free account joining', () => {
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'account_claim_required');
  });

  const invitation = await createTrustedDeviceInvitation({ endpoint: 'https://instance.example.test', protocolVersion: 3 });
  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ devicePublicKey: publicKey, deviceName: 'Pixel route', computerAlias: 'Living\nroom PC', accountClaimToken: invitation.token }),
    res,
    pathname: '/api/device-pairing/account-intents',
    writeJson,
  });
  const created = JSON.parse(res.body).intent;
  check('a fresh scanned account-claim code creates an intent without a bearer credential', () => {
    assert.equal(res.statusCode, 201);
    assert.match(created.intentId, /^rji_/);
    assert.match(created.deviceId, /^rdev_/);
    assert.equal(created.computerAlias, 'Living room PC');
    assert.equal(observedCreateComputerAlias, 'Living room PC');
    assert.equal(created.credential, undefined);
  });

  const signature = cryptoSign('sha256', Buffer.from(buildAccountJoinIntentMessage({
    instanceId: created.instanceId,
    intentId: created.intentId,
    deviceId: created.deviceId,
    devicePublicKeyFingerprint: created.devicePublicKeyFingerprint,
    nonce: created.nonce,
    issuedAt: created.issuedAt,
    audience: 'ragent-account-join',
  })), key.privateKey).toString('base64');
  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ idToken: 'google-id-token', nonce: created.nonce, deviceSignature: signature }, { 'idempotency-key': 'join-route-request-01' }),
    res,
    pathname: `/api/device-pairing/account-intents/${encodeURIComponent(created.intentId)}/complete`,
    writeJson,
  });
  const completed = JSON.parse(res.body);
  check('account join completion returns bound device credential', () => {
    assert.equal(res.statusCode, 200);
    assert.equal(completed.bound, true);
    assert.equal(completed.deviceId, created.deviceId);
    assert.match(completed.credential?.token || '', /^rda_[a-f0-9]{64}$/);
    const state = JSON.parse(readFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), 'utf8'));
    assert.equal(state.devices[0].status, 'bound');
    const binding = JSON.parse(readFileSync(join(process.env.RAGENT_CONFIG_DIR, 'owner-account-binding.json'), 'utf8'));
    assert.equal(binding.accountId, 'acct_google_owner');
    assert.equal(binding.provider, 'account-session');
    assert.equal(state.invitations[0].usedAt.length > 0, true, 'QR must be consumed when the claim binds');
    assert.equal(state.invitations[0].deviceId, created.deviceId);
    assert.equal(state.accountJoinIntents[0].computerAlias, 'Living room PC');
  });

  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ idToken: 'google-id-token', nonce: created.nonce, deviceSignature: signature }, { 'idempotency-key': 'join-route-request-01' }),
    res,
    pathname: `/api/device-pairing/account-intents/${encodeURIComponent(created.intentId)}/complete`,
    writeJson,
  });
  check('same account join request is replay-safe and does not create a second device', () => {
    assert.equal(res.statusCode, 200);
    const replayed = JSON.parse(res.body);
    assert(replayed.credential.token === completed.credential.token, 'HTTP retry must return the original credential');
    assert(replayed.credential.expiresAt === completed.credential.expiresAt, 'HTTP retry must preserve the original expiry');
    const state = JSON.parse(readFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), 'utf8'));
    assert.equal(state.devices.length, 1);
    assert.equal(state.accountJoinIntents[0].completionRequestId, 'join-route-request-01');
  });

  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ accountJoinGrant: 'rajg_route_grant_only', nonce: created.nonce, deviceSignature: signature }, { 'idempotency-key': 'join-route-request-01' }),
    res,
    pathname: `/api/device-pairing/account-intents/${encodeURIComponent(created.intentId)}/complete`,
    writeJson,
  });
  check('target completion accepts grant-only v2 input and never forwards rac_ as idToken', () => {
    assert.equal(res.statusCode, 200);
    assert.equal(observedGrantOnlyCompletion, true);
    assert(JSON.parse(res.body).credential.token === completed.credential.token, 'Grant-only retry must preserve the original credential');
  });

  const replacementKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const statePath = join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json');
  const stateWithReplacement = JSON.parse(readFileSync(statePath, 'utf8'));
  stateWithReplacement.devices[0].devicePublicKey = replacementKey.publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(statePath, JSON.stringify(stateWithReplacement));
  res = response();
  await handleDevicePairingPublicRoutes({
    req: request({ idToken: 'google-id-token', nonce: created.nonce, deviceSignature: signature }, { 'idempotency-key': 'join-route-request-01' }),
    res,
    pathname: `/api/device-pairing/account-intents/${encodeURIComponent(created.intentId)}/complete`,
    writeJson,
  });
  check('a completed intent cannot replay a stale device key', () => {
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'owner_auth_device_mismatch');
  });

  res = response();
  await handleOwnerAuthRoutes({
    req: request({ intentId: 'central-intent-1' }),
    res,
    pathname: '/v1/owner-auth/account-intents',
    broker: {
      async createAccountJoinIntent() {
        return { intentId: 'central-intent-1', instanceId: 'instance-1', deviceId: 'device-1' };
      },
    },
    publicBaseUrl: 'https://accounts.example.test',
    googleWebClientId: '',
    writeJson,
  });
  check('account join central route 不依赖 Web Google client 配置', () => {
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).intentId, 'central-intent-1');
  });

  res = response();
  await handleOwnerAuthRoutes({
    req: request({ requestId: 'account-join-authorize-request-0001' }, { authorization: 'Bearer rac_route_test_012345678901234567890123456789' }),
    res,
    pathname: '/v1/owner-auth/account-intents/central-intent-1/authorize',
    broker: {
      async authorizeAccountJoinIntent(input, { credential }) {
        assert.equal(input.intentId, 'central-intent-1');
        assert.equal(input.requestId, 'account-join-authorize-request-0001');
        assert.equal(credential, 'rac_route_test_012345678901234567890123456789');
        return { accountJoinGrant: 'rajg_route_test', intentId: input.intentId };
      },
    },
    publicBaseUrl: 'https://accounts.example.test',
    googleWebClientId: '',
    writeJson,
  });
  check('account join authorize 只从 Authorization 读取 rac_，不交给目标电脑', () => {
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).accountJoinGrant, 'rajg_route_test');
  });

  res = response();
  await handleOwnerAuthRoutes({
    req: request({ requestId: 'account-session-route-request-0001' }),
    res,
    pathname: '/v1/owner-auth/native/session/challenge',
    broker: {
      async createAccountSessionChallenge(input) {
        assert.equal(input.requestId, 'account-session-route-request-0001');
        return { transactionId: 'oasc_route_test', nonce: 'nonce_route_test' };
      },
    },
    publicBaseUrl: 'https://accounts.example.test',
    googleWebClientId: '',
    writeJson,
  });
  check('账号 session v2 路由不依赖 Web Google client 配置', () => {
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).transactionId, 'oasc_route_test');
  });

  console.log(`test-account-join-intent-route: ${passed} assertions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
