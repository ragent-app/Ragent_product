#!/usr/bin/env node
// Accounts 签名密钥环验收：创建/旧格式迁移/轮换/JWKS 宽限期/主 key 签发。
import assert from 'assert/strict';
import { createPublicKey, verify as verifySig } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ragent-accounts-keys-'));
const { createJwksHandler, KEY_RETIRED_GRACE_MS, loadOrCreateSigningKeyRing, rotateSigningKey, saveSigningKeyRing, signAssertionFactory } =
  await import(pathToFileURL(join(root, 'accounts/keys.mjs')).href);

let now = Date.parse('2026-08-10T00:00:00.000Z');
const clock = () => now;

function makeRes() {
  const out = { statusCode: 0, headers: {}, body: '' };
  out.writeHead = (statusCode, headers = {}) => { out.statusCode = statusCode; Object.assign(out.headers, headers); };
  out.end = (body = '') => { out.body = body; };
  return out;
}

function fetchJwks(handler) {
  const res = makeRes();
  handler({}, res);
  return JSON.parse(res.body).keys;
}

function verifyAssertion(token, keys) {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const jwk = keys.find((item) => item.kid === header.kid);
  assert.ok(jwk, `jwks missing kid ${header.kid}`);
  return verifySig(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const keyFile = join(dir, 'signing-key.json');
  const ring = await loadOrCreateSigningKeyRing(keyFile, { clock });
  await check('首次加载创建含单个主 key 的 ring 并落盘', async () => {
    assert.ok(ring.primaryKid);
    assert.equal(Object.keys(ring.keys).length, 1);
    assert.equal(ring.keys[ring.primaryKid].retiredAt, '');
    assert.ok(readFileSync(keyFile, 'utf8').includes('primaryKid'));
  });

  await check('重新加载保持同一 kid（持久化）', async () => {
    const reloaded = await loadOrCreateSigningKeyRing(keyFile, { clock });
    assert.equal(reloaded.primaryKid, ring.primaryKid);
  });

  await check('主 key 签发 assertion 且 JWKS 校验通过', async () => {
    const assertion = await signAssertionFactory(ring)({ sub: 'acct_1', exp: Math.floor(now / 1000) + 60 });
    assert.equal(verifyAssertion(assertion, fetchJwks(createJwksHandler(ring, { clock }))), true);
  });

  const legacyFile = join(dir, 'legacy-key.json');
  const pair = (await import('node:crypto')).generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const legacyRecord = {
    kid: `accounts-legacy`,
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicJwk,
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(legacyFile, JSON.stringify(legacyRecord));
  await check('旧单 key 格式自动迁移为 ring 并写回', async () => {
    const migrated = await loadOrCreateSigningKeyRing(legacyFile, { clock });
    assert.equal(migrated.primaryKid, 'accounts-legacy');
    assert.equal(migrated.keys['accounts-legacy'].kid, 'accounts-legacy');
    assert.ok(readFileSync(legacyFile, 'utf8').includes('primaryKid'));
  });

  const oldKid = ring.primaryKid;
  const rotated = await saveSigningKeyRing(keyFile, rotateSigningKey(ring, { clock }), { clock });
  await check('轮换后新主 key 生效、旧 key 标记退役', async () => {
    assert.notEqual(rotated.primaryKid, oldKid);
    assert.equal(rotated.keys[oldKid].retiredAt, new Date(now).toISOString());
    assert.ok(rotated.keys[rotated.primaryKid].retiredAt === '');
  });

  await check('宽限期内 JWKS 同时暴露新旧 key 且断言可校验', async () => {
    const keys = fetchJwks(createJwksHandler(rotated, { clock }));
    assert.deepEqual(new Set(keys.map((key) => key.kid)), new Set([oldKid, rotated.primaryKid]));
    assert.equal(keys[0].kid, rotated.primaryKid, '主 key 应排最前');
    const oldAssertion = await signAssertionFactory(ring)({ sub: 'acct_1', exp: Math.floor(now / 1000) + 60 });
    assert.equal(verifyAssertion(oldAssertion, keys), true);
    const newAssertion = await signAssertionFactory(rotated)({ sub: 'acct_1', exp: Math.floor(now / 1000) + 60 });
    assert.equal(verifyAssertion(newAssertion, keys), true);
  });

  now += KEY_RETIRED_GRACE_MS + 60 * 1000;
  await check('超过宽限期后旧 key 从 JWKS 移除', async () => {
    const keys = fetchJwks(createJwksHandler(rotated, { clock }));
    assert.deepEqual(keys.map((key) => key.kid), [rotated.primaryKid]);
  });

  const pruned = rotateSigningKey(rotated, { clock });
  await check('再次轮换时清理超过宽限期的退役 key', async () => {
    assert.ok(!pruned.keys[oldKid], '旧 key 应被清理');
    assert.ok(pruned.keys[rotated.primaryKid].retiredAt, '上一任主 key 退役保留');
  });

  console.log(`test-accounts-keys: ${passed} assertions passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
