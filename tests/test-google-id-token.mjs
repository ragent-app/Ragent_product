#!/usr/bin/env node
// lib/google-id-token.mjs 单测：
//   - 签名/iss/aud/sub/exp/iat 校验
//   - requireNonce=false 时原生 token（带随机客户端 nonce）可放行（Android 场景）
//   - requireNonce=true 时仍强制 nonce 匹配（Accounts 浏览器流语义保留）
//   - JWKS 不可达 → owner_auth_account_invalid
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { pathToFileURL } from 'url';
import { join } from 'path';

const repoRoot = process.cwd();
const SERVER_CLIENT_ID = '541054013971-tm7ip89ett0mar1cfph6j9kakl27nadb.apps.googleusercontent.com';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'unit-test-key';
const jwkWithKid = { ...rsa.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const foreignRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken({ kid: tokenKid = kid, iss = 'https://accounts.google.com', aud = SERVER_CLIENT_ID, sub = 'sub-1', email = 'a@example.test', nonce, iat, exp, signingKey = rsa.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ typ: 'JWT', alg: 'RS256', kid: tokenKid });
  const claims = { iss, aud, sub, email, iat: iat ?? now - 60, exp: exp ?? now + 3600 };
  if (nonce !== undefined) claims.nonce = nonce;
  const payload = b64(claims);
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
}

function fetchOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const { createGoogleIdTokenVerifier, resolveGoogleNativeServerClientIds } = await import(pathToFileURL(join(repoRoot, 'lib', 'google-id-token.mjs')).href);

  check('native audience 使用显式 allowlist，并兼容旧变量', () => {
    assert.deepEqual(resolveGoogleNativeServerClientIds({
      RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS: 'server-a, server-b',
      RAGENT_ANDROID_GOOGLE_CLIENT_ID: 'legacy-only',
    }), ['server-a', 'server-b']);
    assert.deepEqual(resolveGoogleNativeServerClientIds({ RAGENT_ANDROID_GOOGLE_CLIENT_ID: 'legacy-only' }), ['legacy-only']);
    assert.deepEqual(resolveGoogleNativeServerClientIds({}), []);
  });

  const nativeVerify = createGoogleIdTokenVerifier({
    clientIds: [SERVER_CLIENT_ID],
    fetchImpl: async () => fetchOk({ keys: [jwkWithKid] }),
  });
  const strictVerify = createGoogleIdTokenVerifier({
    clientIds: [SERVER_CLIENT_ID],
    fetchImpl: async () => fetchOk({ keys: [jwkWithKid] }),
    requireNonce: true,
  });

  check('原生 token（带随机客户端 nonce）校验通过', async () => {
    const result = await nativeVerify({ idToken: makeToken({ nonce: 'android-random-nonce' }) });
    assert.equal(result.sub, 'sub-1');
    assert.equal(result.email, 'a@example.test');
  });

  check('原生 token（无 nonce）校验通过', async () => {
    const result = await nativeVerify({ idToken: makeToken() });
    assert.equal(result.sub, 'sub-1');
  });

  check('requireNonce 时不匹配的 nonce → owner_auth_token_invalid', async () => {
    await assert.rejects(strictVerify({ idToken: makeToken({ nonce: 'phone-nonce' }), nonce: 'other-nonce' }), (error) => {
      assert.equal(error.code, 'owner_auth_token_invalid');
      assert.equal(error.statusCode, 401);
      return true;
    });
  });

  check('requireNonce 时匹配的 nonce 通过', async () => {
    const result = await strictVerify({ idToken: makeToken({ nonce: 'broker-nonce' }), nonce: 'broker-nonce' });
    assert.equal(result.sub, 'sub-1');
  });

  check('aud 不含白名单 → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ aud: 'other.apps.googleusercontent.com' }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('iss 非法 → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ iss: 'https://evil.example' }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('已过期 → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ exp: Math.floor(Date.now() / 1000) - 60 }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('未来 iat 超 5 分钟 → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ iat: Math.floor(Date.now() / 1000) + 600 }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('缺 sub → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ sub: '' }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('签名不匹配（未知 kid）→ owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: makeToken({ signingKey: foreignRsa.privateKey }) }), (error) => error.code === 'owner_auth_token_invalid');
  });

  check('JWKS 不可达 → owner_auth_account_invalid(502)', async () => {
    const broken = createGoogleIdTokenVerifier({
      clientIds: [SERVER_CLIENT_ID],
      fetchImpl: async () => { throw new Error('network down'); },
    });
    await assert.rejects(broken({ idToken: makeToken() }), (error) => {
      assert.equal(error.code, 'owner_auth_account_invalid');
      assert.equal(error.statusCode, 502);
      return true;
    });
  });

  check('未配置 clientIds → google_login_not_configured(409)', async () => {
    const unconfigured = createGoogleIdTokenVerifier({});
    await assert.rejects(unconfigured({ idToken: makeToken() }), (error) => {
      assert.equal(error.code, 'google_login_not_configured');
      assert.equal(error.statusCode, 409);
      return true;
    });
  });

  check('非法结构 token → owner_auth_token_invalid', async () => {
    await assert.rejects(nativeVerify({ idToken: 'not-a-jwt' }), (error) => error.code === 'owner_auth_token_invalid');
  });

  console.log(`test-google-id-token: ${passed} assertions passed`);
} finally {}
