#!/usr/bin/env node
// POST /api/auth/google/token（Android 原生 ID token 端点）— Accounts 模式覆盖。
// 场景：鉴权 401/403、body 校验 400、token 校验 401/502、
//       accounts bind/login/binding-mismatch 写路径与 200 响应。
import assert from 'assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'ragent-google-owner-token-router-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.RAGENT_PUBLIC_BASE_URL = 'https://instance.example.test';
process.env.RAGENT_AUTH_SESSION_SECRET = 'test-auth-session-secret';
process.env.SECURE_COOKIES = '0';
delete process.env.RAGENT_INSTANCE_ROOT;

const configDir = process.env.RAGENT_CONFIG_DIR;
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'not-used' }));
const deviceKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const devicePublicKey = deviceKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_test',
  instanceSecret: 'ris_test',
  createdAt: new Date().toISOString(),
  invitations: [],
  challenges: [],
  authTokens: [],
  devices: [{
    id: 'dev-1',
    tokenHash: '',
    status: 'provisional',
    deviceName: 'Android Device',
    platform: 'android',
    devicePublicKey,
    authVersion: 3,
    keyAlgorithm: 'ed25519',
    createdAt: new Date().toISOString(),
    boundAt: '',
    lastSeenAt: new Date().toISOString(),
    temporaryExpiresAt: new Date(Date.now() + 120000).toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    revokedAt: '',
  }],
}));

const SERVER_CLIENT_ID = '541054013971-tm7ip89ett0mar1cfph6j9kakl27nadb.apps.googleusercontent.com';
process.env.RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS = SERVER_CLIENT_ID;

// --- 测试用 RSA 签名工具：签发可被 JWKS stub 验证的 Google ID token ---
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'android-test-key';
const jwkWithKid = { ...rsa.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const secondRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const accountsSigning = generateKeyPairSync('ed25519');
const accountsKid = 'accounts-native-test-key';
const accountsJwk = { ...accountsSigning.publicKey.export({ format: 'jwk' }), kid: accountsKid, alg: 'EdDSA', use: 'sig' };
const nativeCalls = [];
let rollbackFailing = false;
let wrongDeviceAssertion = false;
let authorityClaims = {};
const rollbackCalls = [];
const authorityCalls = [];

function signAccountsAssertion(claims) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid: accountsKid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), accountsSigning.privateKey).toString('base64url')}`;
}

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeIdToken({ sub = 'google-sub-1', email = 'owner@example.test', name = 'Owner', picture, aud = SERVER_CLIENT_ID, iat, exp, nonce } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ typ: 'JWT', alg: 'RS256', kid });
  const claims = {
    iss: 'https://accounts.google.com',
    aud,
    sub,
    email,
    email_verified: true,
    name,
    iat: iat ?? now - 60,
    exp: exp ?? now + 3600,
  };
  if (nonce !== undefined) claims.nonce = nonce;
  if (picture !== undefined) claims.picture = picture;
  const payload = b64(claims);
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')}`;
}

// 用另一把密钥签发（JWKS 无对应 kid → 签名校验失败）
function makeForeignToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ typ: 'JWT', alg: 'RS256', kid: 'foreign-key' });
  const payload = b64({
    iss: 'https://accounts.google.com',
    aud: SERVER_CLIENT_ID,
    sub: 'google-sub-foreign',
    email: 'foreign@example.test',
    name: 'Foreign',
    iat: now - 60,
    exp: now + 3600,
  });
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), secondRsa.privateKey).toString('base64url')}`;
}

// --- 全局 fetch stub：默认服务 JWKS；可切换为网络故障 ---
let jwksFailing = false;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.href.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    if (jwksFailing) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ keys: [jwkWithKid] }) };
  }
  if (target.pathname === '/v1/owner-auth/native/complete') {
    const body = JSON.parse(options.body);
    nativeCalls.push(body);
    const tokenClaims = JSON.parse(Buffer.from(body.idToken.split('.')[1], 'base64url').toString('utf8'));
    const subject = tokenClaims.sub;
    if (subject !== 'google-sub-1') {
      return { ok: false, status: 403, json: async () => ({ code: 'owner_auth_binding_mismatch' }) };
    }
    return { ok: true, status: 200, json: async () => ({
      assertion: signAccountsAssertion({
        iss: 'https://accounts.example.test',
        aud: body.instance.instanceId,
        sub: `acct_google_${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`,
        purpose: 'native',
        tx: body.requestId,
        deviceId: wrongDeviceAssertion ? 'different-device' : body.device.deviceId,
        devicePublicKeyFingerprint: body.device.devicePublicKeyFingerprint,
        ...authorityClaims,
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
      deviceState: 'bound',
      deviceId: body.device.deviceId,
      lastSeenAt: new Date().toISOString(),
      action: 'bind',
      accountId: 'unsigned-response-account', bindingAuthorityRevision: '999999', nativeCompletionId: '999999',
    }) };
  }
  if (target.pathname === '/v1/owner-auth/native/rollback') {
    rollbackCalls.push(JSON.parse(options.body));
    if (rollbackFailing) return { ok: true, status: 200, json: async () => ({ rolledBack: false, reason: 'superseded' }) };
    return { ok: true, status: 200, json: async () => ({ rolledBack: true }) };
  }
  if (target.pathname === '/v1/owner-auth/instances/authority') {
    const body = JSON.parse(options.body); authorityCalls.push(body);
    const { buildBindingAuthorityProofMessage } = await import('../lib/instance-proof-protocol.mjs');
    assert(verify(null, Buffer.from(buildBindingAuthorityProofMessage({ ...body, instanceId: body.instance.instanceId,
      keyFingerprint: body.instance.keyFingerprint })), body.instance.publicKey, Buffer.from(body.signature, 'base64url')));
    const at = Math.floor(Date.now() / 1000);
    return { ok: true, status: 200, json: async () => ({ assertion: signAccountsAssertion({
      iss: 'https://accounts.example.test', aud: body.instance.instanceId, sub: body.accountId,
      purpose: 'binding_authority', authorityProtocol: 1, tx: body.requestId, nonce: body.nonce,
      instanceKeyFingerprint: body.instance.keyFingerprint, bindingAuthorityRevision: '7', bindingAuthorityState: 'active', iat: at, exp: at + 30,
    }), expiresAt: '2099-01-01T00:00:00.000Z', bindingAuthorityState: 'revoked', bindingAuthorityRevision: '99999' }) };
  }
  if (target.pathname === '/.well-known/jwks.json') {
    return { ok: true, status: 200, json: async () => ({ keys: [accountsJwk] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { handleGoogleOwnerAuthRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-google-owner-routes.mjs')).href);
const {
  getOwnerAccountBinding,
  deriveGoogleOwnerAccountId,
  recoverOwnerAccountNativePending,
  OWNER_ACCOUNT_NATIVE_JOURNAL_FILE,
  completeOwnerAccountNativeAuth,
  rollbackOwnerAccountNativeAuth,
  getOwnerAccountNativeJournal,
  queryOwnerAccountBindingAuthority,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'owner-account-auth.mjs')).href);

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

function makeReq({ method = 'POST', body, headers = {} } = {}) {
  if (body === undefined) return { method, headers };
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function parseJson(res) {
  return JSON.parse(res.body);
}

function ownerSession() {
  return { role: 'owner', principalKind: 'trusted_device', deviceId: 'dev-1', scope: 'device-access' };
}

async function submit(body, authSession, headers = {}) {
  const res = makeRes();
  await handleGoogleOwnerAuthRoutes({ req: makeReq({ body, headers }), res, pathname: '/api/auth/google/token', authSession, writeJson });
  return { status: res.statusCode, json: parseJson(res) };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  // ---------- 鉴权 ----------
  let result = await submit({ idToken: makeIdToken() }, null);
  check('未认证 → 401 owner_auth_not_owner', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_not_owner');
  });

  result = await submit({ idToken: makeIdToken() }, { role: 'visitor' });
  check('非 owner（visitor）→ 403 owner_auth_not_owner', () => {
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'owner_auth_not_owner');
  });

  // ---------- body 校验 ----------
  result = await submit({}, ownerSession());
  check('缺 idToken → 400 owner_auth_request_invalid', () => {
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'owner_auth_request_invalid');
  });

  result = await submit({ idToken: 123 }, ownerSession());
  check('idToken 非字符串 → 400 owner_auth_request_invalid', () => {
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'owner_auth_request_invalid');
  });

  result = await submit({ idToken: makeIdToken(), alias: 'x'.repeat(65) }, ownerSession());
  check('alias > 64 字符 → 400 owner_auth_request_invalid', () => {
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'owner_auth_request_invalid');
  });

  // ---------- Google JWKS 不可达 → 502 ----------
  jwksFailing = true;
  result = await submit({ idToken: makeIdToken() }, ownerSession());
  check('JWKS 不可达 → 502 owner_auth_account_invalid', () => {
    assert.equal(result.status, 502);
    assert.equal(result.json.code, 'owner_auth_account_invalid');
  });
  jwksFailing = false;

  // ---------- token 校验失败 → 401 ----------
  result = await submit({ idToken: makeForeignToken() }, ownerSession());
  check('签名不匹配（未知 kid）→ 401 owner_auth_token_invalid', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_token_invalid');
  });

  result = await submit({ idToken: makeIdToken({ aud: 'some-web-client.apps.googleusercontent.com' }) }, ownerSession());
  check('aud 不是 Web/server client_id → 401 owner_auth_token_invalid', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_token_invalid');
  });

  result = await submit({ idToken: makeIdToken({ exp: Math.floor(Date.now() / 1000) - 60 }) }, ownerSession());
  check('已过期 token → 401 owner_auth_token_invalid', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_token_invalid');
  });

  result = await submit({ idToken: makeIdToken({ iat: Math.floor(Date.now() / 1000) + 600 }) }, ownerSession());
  check('未来 iat 超 5 分钟 → 401 owner_auth_token_invalid', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_token_invalid');
  });

  // ---------- accounts 模式 bind / login / mismatch ----------
  result = await submit({
    idToken: makeIdToken({ picture: 'https://lh3.googleusercontent.com/photo-test' }),
    alias: 'Android Device',
    idempotencyKey: 'native-request-1',
  }, ownerSession());
  check('accounts 未绑定 → bind 成功 200 {ok,bound:true,mode:accounts}', () => {
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.bound, true);
    assert.equal(result.json.mode, 'accounts');
    assert.equal(result.json.deviceState, 'bound');
    assert.equal(result.json.deviceId, 'dev-1');
    assert.match(result.json.credential?.token || '', /^rda_[a-f0-9]{64}$/);
  });

  const binding = await getOwnerAccountBinding();
  check('accounts bind 写入 owner-account-binding.json（派生 accountId + deviceAlias）', () => {
    assert.equal(binding.accountId, deriveGoogleOwnerAccountId('google-sub-1'));
    assert.equal(binding.provider, 'google');
    assert.equal(binding.deviceAlias, 'Android Device');
    assert.deepEqual(binding.accountProfile, {
      displayName: 'Owner',
      email: 'owner@example.test',
      photoUrl: 'https://lh3.googleusercontent.com/photo-test',
    });
    assert.ok(binding.boundAt);
    assert.equal(binding.accountId, `acct_google_${createHash('sha256').update('google-sub-1').digest('hex').slice(0, 32)}`);
    const raw = JSON.parse(readFileSync(join(configDir, 'owner-account-binding.json'), 'utf8'));
    assert.equal(raw.accountId, binding.accountId);
    // 不泄露 Google 邮箱/姓名/token
    assert.equal(raw.email, undefined);
    assert.equal(raw.name, undefined);
    assert.equal(raw.sub, undefined);
  });

  // ---------- P2 journal recovery ----------
  const recoveredAccountId = deriveGoogleOwnerAccountId('google-sub-1');
  writeFileSync(join(configDir, 'owner-account-binding.json'), '{}');
  const trustedStateAfterBind = JSON.parse(readFileSync(join(configDir, 'trusted-devices.json'), 'utf8'));
  const recoveredDevice = trustedStateAfterBind.devices.find((entry) => entry.id === 'dev-1');
  recoveredDevice.status = 'provisional';
  recoveredDevice.accountId = '';
  recoveredDevice.boundAt = '';
  recoveredDevice.temporaryExpiresAt = new Date(Date.now() + 120000).toISOString();
  recoveredDevice.expiresAt = recoveredDevice.temporaryExpiresAt;
  trustedStateAfterBind.authTokens = [];
  writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify(trustedStateAfterBind));
  writeFileSync(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, JSON.stringify({
    version: 1,
    requestId: 'native-recovery-1',
    deviceId: 'dev-1',
    accountId: recoveredAccountId,
    deviceAlias: 'Android Device',
    action: 'bind',
    phase: 'local_binding_persisted',
    updatedAt: new Date().toISOString(),
  }));
  const recovered = await recoverOwnerAccountNativePending();
  check('P2 journal recovery locally promotes provisional device without Google retry', () => {
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.phase, 'credential_issued');
    const state = JSON.parse(readFileSync(join(configDir, 'trusted-devices.json'), 'utf8'));
    const device = state.devices.find((entry) => entry.id === 'dev-1');
    assert.equal(device.status, 'bound');
    assert.equal(device.accountId, recoveredAccountId);
    assert.equal(state.authTokens.length, 1);
    assert.equal(state.authTokens[0].kind, 'bound');
    assert.equal(JSON.parse(readFileSync(join(configDir, 'owner-account-binding.json'), 'utf8')).accountId, recoveredAccountId);
    if (process.platform !== 'win32') assert.equal(statSync(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE).mode & 0o777, 0o600);
    assert.equal(nativeCalls.length, 1);
  });

  result = await submit({ idToken: makeIdToken(), idempotencyKey: 'native-request-2' }, ownerSession());
  check('accounts 已绑定且同 sub → login 幂等收敛 200', () => {
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.bound, true);
    assert.equal(result.json.mode, 'accounts');
    assert.equal(result.json.deviceState, 'bound');
    assert.equal(result.json.deviceId, 'dev-1');
    assert.match(result.json.credential?.token || '', /^rda_[a-f0-9]{64}$/);
  });

  check('Accounts native 收敛调用只带非敏感设备字段', () => {
    assert.equal(nativeCalls.length, 2);
    assert.equal(nativeCalls[0].device.deviceId, 'dev-1');
    assert.equal(nativeCalls[0].device.alias, 'Android Device');
    assert.equal(nativeCalls[0].email, undefined);
    assert.equal(nativeCalls[0].name, undefined);
  });

  result = await submit({ idToken: makeIdToken({ sub: 'google-sub-other' }), idempotencyKey: 'native-request-3' }, ownerSession());
  check('accounts 已绑定但 sub 不同 → 403 owner_auth_binding_mismatch', () => {
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'owner_auth_binding_mismatch');
  });

  // ---------- G-11 幂等键统一 ----------
  result = await submit({ idToken: makeIdToken() }, ownerSession());
  check('accounts 模式缺幂等键 → 400 owner_auth_request_invalid（禁止服务端自动生成）', () => {
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'owner_auth_request_invalid');
  });

  result = await submit({ idToken: makeIdToken(), idempotencyKey: 'header-body-key-01' }, ownerSession(), { 'idempotency-key': 'different-id-key-01' });
  check('Header/body 幂等键不一致 → 400 owner_auth_idempotency_conflict', () => {
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'owner_auth_idempotency_conflict');
  });

  result = await submit({ idToken: makeIdToken() }, ownerSession(), { 'idempotency-key': 'header-only-key-1' });
  check('仅 Header 幂等键 → accounts bind 成功 200', () => {
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.bound, true);
    assert.equal(result.json.mode, 'accounts');
  });

  // ---------- G-10 assertion 绑定 deviceId ----------
  wrongDeviceAssertion = true;
  result = await submit({ idToken: makeIdToken(), idempotencyKey: 'native-wrong-device' }, ownerSession());
  check('Accounts assertion 设备不匹配 → 502 owner_auth_assertion_invalid', () => {
    assert.equal(result.status, 502);
    assert.equal(result.json.code, 'owner_auth_assertion_invalid');
  });
  wrongDeviceAssertion = false;

  // ---------- trusted-device Bearer 鉴权 ----------
  // router.mjs 在 google-owner 分派点（requireAuth 之前）不解析 Bearer，token 端点需自行补齐；
  // 这里用真实 rdt_ 凭据 + 无预置 authSession 模拟 Android 客户端实际调用路径。
  const trustedToken = `rdt_${'c'.repeat(64)}`;
  writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
    version: 1,
    instanceId: 'rli_test',
    instanceSecret: 'ris_test',
    createdAt: new Date().toISOString(),
    invitations: [],
    challenges: [],
    authTokens: [],
    devices: [{
      id: 'rdev_1',
      tokenHash: createHash('sha256').update(trustedToken).digest('hex'),
      deviceName: 'Test Android',
      platform: 'android',
      devicePublicKey,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, {
      id: 'missing-device',
      tokenHash: '',
      status: 'bound',
      accountId: 'acct_other',
      deviceName: 'Existing device',
      platform: 'android',
      devicePublicKey,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: '',
    }, {
      id: 'missing-device-2',
      tokenHash: '',
      status: 'bound',
      accountId: 'acct_other',
      deviceName: 'Existing device 2',
      platform: 'android',
      devicePublicKey,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: '',
    }],
  }));

  result = await submit(
    { idToken: makeIdToken(), idempotencyKey: 'native-bearer-01' },
    null,
    { authorization: `Bearer ${trustedToken}` },
  );
  check('trusted-device Bearer（无预置 authSession）→ 200 登录收敛', () => {
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.bound, true);
    assert.equal(result.json.mode, 'accounts');
    assert.equal(result.json.deviceState, 'bound');
    assert.equal(result.json.deviceId, 'rdev_1');
    assert.match(result.json.credential?.token || '', /^rda_[a-f0-9]{64}$/);
  });

  result = await submit(
    { idToken: makeIdToken() },
    null,
    { authorization: 'Bearer rdt_unknown' },
  );
  check('未知 Bearer → 401 owner_auth_not_owner', () => {
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'owner_auth_not_owner');
  });

  writeFileSync(join(configDir, 'owner-account-binding.json'), '{}');
  result = await submit(
    { idToken: makeIdToken(), idempotencyKey: 'native-local-failure-01' },
    { role: 'owner', principalKind: 'trusted_device', deviceId: 'missing-device', scope: 'device-access' },
  );
  check('Accounts 成功但本地设备提升失败 → 补偿中央状态并返回可区分失败', () => {
    assert.equal(result.status, 502);
    assert.equal(result.json.code, 'owner_auth_convergence_failed');
    assert.equal(JSON.parse(readFileSync(join(configDir, 'owner-account-binding.json'), 'utf8')).accountId, undefined);
    assert.equal(JSON.parse(readFileSync(join(configDir, 'owner-account-native-pending.json'), 'utf8')).requestId, undefined);
  });

  rollbackFailing = true;
  result = await submit(
    { idToken: makeIdToken(), idempotencyKey: 'native-local-failure-02' },
    { role: 'owner', principalKind: 'trusted_device', deviceId: 'missing-device-2', scope: 'device-access' },
  );
  check('中央补偿失败 → 保留 pending marker 并返回 503 retryable', () => {
    assert.equal(result.status, 503);
    assert.equal(result.json.code, 'owner_auth_convergence_pending');
    assert.equal(JSON.parse(readFileSync(join(configDir, 'owner-account-native-pending.json'), 'utf8')).requestId, 'native-local-failure-02');
  });

  authorityClaims = {};
  const legacy = await completeOwnerAccountNativeAuth({ idToken: makeIdToken(), deviceId: 'rdev_1', requestId: 'native-legacy-client' });
  check('legacy signed assertions do not adopt unsigned authority response fields', () => {
    assert.equal(legacy.accountId, recoveredAccountId); assert.equal(legacy.bindingAuthorityRevision, undefined);
    assert.equal(legacy.nativeCompletionId, undefined);
  });
  authorityClaims = { bindingAuthorityRevision: '7', nativeCompletionId: '101' };
  const versioned = await completeOwnerAccountNativeAuth({ idToken: makeIdToken(), deviceId: 'rdev_1', requestId: 'native-versioned-client' });
  check('verified native assertion alone supplies account/revision/completion identity', () => {
    assert.equal(versioned.accountId, recoveredAccountId);
    assert.equal(versioned.bindingAuthorityRevision, '7'); assert.equal(versioned.nativeCompletionId, '101');
  });
  const journal = await getOwnerAccountNativeJournal();
  check('native convergence journal retains the verified rollback identity', () => {
    assert.equal(journal.bindingAuthorityRevision, '7'); assert.equal(journal.nativeCompletionId, '101');
  });
  rollbackFailing = false;
  await rollbackOwnerAccountNativeAuth({ requestId: 'native-versioned-client', deviceId: 'rdev_1',
    accountId: versioned.accountId, bindingAuthorityRevision: versioned.bindingAuthorityRevision, nativeCompletionId: versioned.nativeCompletionId });
  const rollback = rollbackCalls.at(-1);
  const { buildNativeOwnerAuthRollbackMessage } = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-proof-protocol.mjs')).href);
  const messageFields = { ...rollback, instanceId: rollback.instance.instanceId, deviceId: rollback.device.deviceId,
    devicePublicKeyFingerprint: rollback.device.devicePublicKeyFingerprint };
  check('native rollback proof binds account, revision and distinct completion in its own audience', () => {
    assert.equal(rollback.audience, 'ragent-owner-auth-native-rollback');
    assert.equal(rollback.expectedRevision, '7'); assert.equal(rollback.expectedCompletionId, '101');
    assert.equal(rollback.accountId, recoveredAccountId); assert.equal(rollback.idToken, undefined);
    assert(verify(null, Buffer.from(buildNativeOwnerAuthRollbackMessage(messageFields)), rollback.instance.publicKey,
      Buffer.from(rollback.signature, 'base64url')));
    assert.equal(verify(null, Buffer.from(buildNativeOwnerAuthRollbackMessage({ ...messageFields, expectedCompletionId: '102' })),
      rollback.instance.publicKey, Buffer.from(rollback.signature, 'base64url')), false);
  });
  for (const invalid of [{ bindingAuthorityRevision: '0007', nativeCompletionId: '101' },
    { bindingAuthorityRevision: 7, nativeCompletionId: '101' },
    { bindingAuthorityRevision: '9223372036854775808', nativeCompletionId: '101' },
    { bindingAuthorityRevision: '7' }, { nativeCompletionId: '101' }]) {
    authorityClaims = invalid;
    await assert.rejects(completeOwnerAccountNativeAuth({ idToken: makeIdToken(), deviceId: 'rdev_1', requestId: 'native-invalid-authority' }),
      { code: 'owner_auth_assertion_invalid' });
  }
  check('invalid signed authority counters cannot replace the prior verified journal', () => {
    const retained = JSON.parse(readFileSync(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, 'utf8'));
    assert.equal(retained.requestId, 'native-versioned-client'); assert.equal(retained.nativeCompletionId, '101');
  });
  authorityClaims = {};
  await assert.rejects(completeOwnerAccountNativeAuth({ idToken: makeIdToken(), deviceId: 'rdev_1', requestId: 'native-no-protocol-downgrade' }),
    { code: 'owner_auth_authority_upgrade_required' });
  const authorityQueryStarted = Date.now();
  const currentAuthority = await queryOwnerAccountBindingAuthority({ accountId: recoveredAccountId });
  check('PC signs a fresh nonce-bound status request and trusts only its bounded signed response', () => {
    assert.equal(authorityCalls.length, 1); assert.equal(authorityCalls[0].accountId, recoveredAccountId);
    assert.match(authorityCalls[0].nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(currentAuthority.state, 'active'); assert.equal(currentAuthority.revision, '7');
    assert(currentAuthority.expiresAt <= authorityQueryStarted + 30_100);
  });
  await assert.rejects(queryOwnerAccountBindingAuthority({ accountId: 'other-local-account' }), { code: 'owner_auth_not_bound' });
  console.log(`test-google-owner-token-router: ${passed} assertions passed`);
} finally {
  const { closeAuthSessionStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href);
  closeAuthSessionStore();
  rmSync(home, { recursive: true, force: true });
}
