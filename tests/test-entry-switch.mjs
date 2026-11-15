#!/usr/bin/env node
// 设备入口切换（介绍人机制）验证：
//  M1 A 侧：invite（owner-only 签发一次性 join-token，摘要落盘）+ introspect（Bearer 握手凭证消费）
//  M2 B 侧：consumeEntrySwitchJoin 全链路（握手→introspect→验介绍信）+ 入口 handler（302/失败跳登录）
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-entry-switch-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;
// 会话签发（B 端入口成功路径）依赖此密钥——必须在 import lib/auth.mjs 之前设置（模块级读取）
process.env.RAGENT_AUTH_SESSION_SECRET = 'test-secret-ragent-entry-switch';

const configDir = process.env.RAGENT_CONFIG_DIR;
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

// 设备 B 的实例身份（B 私钥签名，公钥在 A 的 trusted-devices 清单）
const bKey = generateKeyPairSync('ed25519');
const bPublicKeyPem = bKey.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const TARGET_DEVICE = 'rdev_test';
// 伪造密钥：用于「非登记私钥签名」负例（A 真实介绍信由本机 instance-signing-key 签）
const rogueKey = generateKeyPairSync('ed25519');
const OWNER_ID = 'acct_entry_switch_owner';

// A 侧预写：trusted-devices 清单（B 是 A 的已信任设备）+ 绑定
writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'desktop-a',
  devices: [{
    id: TARGET_DEVICE,
    deviceName: '设备B',
    devicePublicKey: bPublicKeyPem,
    authVersion: 2,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }, {
    // M3：入口地址登记测试专用（与 TARGET_DEVICE 分离，避免 pending token 409 干扰）
    id: 'rdev_entrytest',
    deviceName: '设备B（地址登记）',
    devicePublicKey: bPublicKeyPem,
    authVersion: 2,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }],
  invitations: [],
  challenges: [],
  authTokens: [],
}), 'utf8');
writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({
  accountId: OWNER_ID, provider: 'google', boundAt: new Date().toISOString(),
}), 'utf8');

const {
  issueEntryJoinToken,
  introspectEntryJoinToken,
  buildIntroMessage,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'entry-switch.mjs')).href);
const { consumeEntrySwitchJoin } = await import(pathToFileURL(join(repoRoot, 'lib', 'entry-switch-client.mjs')).href);
const { issueDeviceHandshakeToken } = await import(pathToFileURL(join(repoRoot, 'lib', 'device-handshake.mjs')).href);
const { verifyDeviceSignature } = await import(pathToFileURL(join(repoRoot, 'lib', 'device-handshake.mjs')).href);
const { handleEntrySwitchRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-entry-switch-routes.mjs')).href);
const { handleEntrySwitchJoin } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-entry-switch-join.mjs')).href);
const { getDevicePublicKey, registerDevicePublicKey } = await import(pathToFileURL(join(repoRoot, 'lib', 'device-public-key-registry.mjs')).href);
const { getInstancePublicKey, signWithInstanceKey } = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-keys.mjs')).href);
const { updateTrustedDeviceEntryUrl, listTrustedDevices } = await import(pathToFileURL(join(repoRoot, 'chat', 'trusted-devices.mjs')).href);
const { handleDevicePairingOwnerRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-device-pairing-routes.mjs')).href);
const loginTemplate = readFileSync(join(repoRoot, 'templates', 'login.html'), 'utf8');

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
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...headers }; },
    end(body = '') { this.body = body; },
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
    headers: { host: 'a.ragent.test', ...extraHeaders },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function makeGetReq(url, extraHeaders = {}) {
  return {
    method: 'GET',
    url,
    headers: { host: 'a.ragent.test', ...extraHeaders },
  };
}

// ---------- M1: invite（A 侧，owner-only） ----------

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: TARGET_DEVICE, targetUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/entry-switch/invite', authSession: null, writeJson,
  });
  check('invite 无 owner 会话 → 403', res.statusCode === 403);
}

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 缺 targetDeviceId → 400', res.statusCode === 400);
  const res2 = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: TARGET_DEVICE, targetUrl: 'ftp://b' }),
    res: res2, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 非法 targetUrl → 400', res2.statusCode === 400);
}

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: 'rdev_unknown', targetUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 目标不在清单 → 404', res.statusCode === 404);
}

const firstInvite = await (async () => {
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: TARGET_DEVICE, targetUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 正常 → 200 + jumpUrl', res.statusCode === 200);
  const payload = JSON.parse(res.body);
  const url = new URL(payload.jumpUrl);
  check('jumpUrl 带 join/from/introspect/device 参数',
    /^[0-9a-f]{48}$/.test(url.searchParams.get('join'))
    && url.searchParams.get('from') === 'desktop-a'
    && url.searchParams.get('introspect') === 'http://a.ragent.test'
    && url.searchParams.get('device') === TARGET_DEVICE
    && Date.parse(payload.expiresAt) > Date.now());
  // 摘要落盘：明文 token 不出现在文件
  const raw = readFileSync(join(configDir, 'entry-switch-joins.json'), 'utf8');
  check('join-token 只存摘要（明文不落盘）', !raw.includes(url.searchParams.get('join')));
  check('audit invited 写入', raw.includes('"event": "invited"'));
  return { joinToken: url.searchParams.get('join') };
})();

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: TARGET_DEVICE, targetUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 同目标重复 → 409', res.statusCode === 409);
}

// ---------- M1: introspect（Bearer 握手凭证消费） ----------

async function bearerFor(deviceId) {
  const { token } = await issueDeviceHandshakeToken({ deviceId, ownerId: OWNER_ID, ownerKind: 'account' });
  return token;
}

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: firstInvite.joinToken }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 无 Bearer → 403', res.statusCode === 403);
}

{
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: 'deadbeef'.repeat(6) }, { authorization: `Bearer ${await bearerFor(TARGET_DEVICE)}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 伪造 join-token → 401', res.statusCode === 401);
}

{
  // 目标设备绑定：用另一台设备的凭证消费 → 401 + attempts 递增
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: firstInvite.joinToken }, { authorization: `Bearer ${await bearerFor('rdev_attacker')}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 目标设备不匹配 → 401', res.statusCode === 401);
}

{
  // 正常消费：B 的凭证 → 介绍信（本机私钥签名，B 可用登记公钥验）
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: firstInvite.joinToken }, { authorization: `Bearer ${await bearerFor(TARGET_DEVICE)}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 正常 → 200 介绍信', res.statusCode === 200);
  const intro = JSON.parse(res.body);
  check('介绍信字段完整',
    intro.ok === true && intro.ownerId === OWNER_ID
    && intro.sourceInstance === 'desktop-a'
    && intro.targetDevice === TARGET_DEVICE
    && /^[0-9a-f]{32}$/.test(intro.introNonce)
    && typeof intro.introSig === 'string'
    && intro.sourcePublicKey.includes('BEGIN PUBLIC KEY'));
  const message = buildIntroMessage({ sourceInstance: intro.sourceInstance, introNonce: intro.introNonce });
  check('介绍信验签通过（A 实例密钥公钥）',
    verifyDeviceSignature({ message, signature: intro.introSig, publicKeyPem: await getInstancePublicKey() }));
}

{
  // 一次性：复用 → 410
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: firstInvite.joinToken }, { authorization: `Bearer ${await bearerFor(TARGET_DEVICE)}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 已用 token → 410', res.statusCode === 410);
}

{
  // 过期：改文件 expiresAt → 410
  const issued = await issueEntryJoinToken({ targetDeviceId: TARGET_DEVICE, ownerId: OWNER_ID });
  const storePath = join(configDir, 'entry-switch-joins.json');
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const hash = (await import('crypto')).createHash('sha256').update(issued.joinToken).digest('hex');
  store.tokens[hash].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(storePath, JSON.stringify(store), 'utf8');
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: issued.joinToken }, { authorization: `Bearer ${await bearerFor(TARGET_DEVICE)}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('introspect 过期 token → 410', res.statusCode === 410);
}

{
  // attempts 锁定：前 5 次失败 attempts 0→5，第 6 次起 429
  const issued = await issueEntryJoinToken({ targetDeviceId: TARGET_DEVICE, ownerId: OWNER_ID });
  let locked = 0;
  for (let i = 0; i < 7; i += 1) {
    const res = makeRes();
    await handleEntrySwitchRoutes({
      req: makeBodyReq({ joinToken: issued.joinToken }, { authorization: `Bearer ${await bearerFor('rdev_attacker')}` }),
      res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
    });
    if (res.statusCode === 429) locked += 1;
  }
  check('attempts>=5 锁定 → 429', locked >= 1 && locked <= 2);
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ joinToken: issued.joinToken }, { authorization: `Bearer ${await bearerFor(TARGET_DEVICE)}` }),
    res, pathname: '/api/entry-switch/introspect', authSession: null, writeJson,
  });
  check('锁定后正确凭证也拒绝 → 429', res.statusCode === 429);
}

// ---------- M2: B 侧客户端 consumeEntrySwitchJoin ----------

// 模拟 A 侧（另一个实例）：mock fetch 响应 handshake/introspect。
// 介绍信由 A 实例真实密钥签名（signWithInstanceKey=本机 instance-signing-key 私钥），
// 对应真实场景「A 在 B 登记的 publicKey = A 实例密钥公钥」。
function makeMockSourceInstance({ introSigner = signWithInstanceKey, instanceId = 'desktop-a', ownerId = OWNER_ID } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/device-handshake')) {
      return { ok: true, status: 200, json: async () => ({ token: `mock-bearer-${calls.length}` }) };
    }
    if (String(url).endsWith('/api/entry-switch/introspect')) {
      const introNonce = 'deadbeef'.repeat(4);
      const message = buildIntroMessage({ sourceInstance: instanceId, introNonce });
      const introSig = await introSigner(message);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, ownerId, sourceInstance: instanceId, targetDevice: TARGET_DEVICE, introNonce, introSig, sourcePublicKey: await getInstancePublicKey() }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  return { fetchImpl, calls };
}

// B 侧登记 A：登记值 = A 实例密钥公钥（信任锚）
await registerDevicePublicKey({ deviceId: 'desktop-a', publicKey: await getInstancePublicKey(), ownerId: OWNER_ID });

{
  const source = makeMockSourceInstance();
  const result = await consumeEntrySwitchJoin({
    joinToken: firstInvite.joinToken,
    from: 'desktop-a',
    introspectUrl: 'https://a.ragent.test',
    deviceId: TARGET_DEVICE,
    ownerId: OWNER_ID,
    publicKeyForFrom: await getDevicePublicKey('desktop-a'),
    fetchImpl: source.fetchImpl,
  });
  check('M2 全链路：握手→introspect→验介绍信', result.ownerId === OWNER_ID && result.sourceInstance === 'desktop-a');
  const handshakeBody = JSON.parse(source.calls[0].options.body);
  check('B 侧握手 body 为 B 设备签名',
    handshakeBody.deviceId === TARGET_DEVICE && !('sub' in handshakeBody) && !('instanceId' in handshakeBody)
    && typeof handshakeBody.signature === 'string' && handshakeBody.timestamp);
  const introspectCall = source.calls.find((c) => String(c.url).endsWith('/introspect'));
  check('introspect 带 Bearer 握手凭证', introspectCall.options.headers.Authorization === 'Bearer mock-bearer-1');
  check('introspect body 传 join-token', JSON.parse(introspectCall.options.body).joinToken === firstInvite.joinToken);
}

{
  // 伪造介绍信：签名密钥不是登记公钥对应的（rogueKey 私钥）→ 验签失败
  const rogueSigner = async (message) => sign(null, Buffer.from(message, 'utf8'), rogueKey.privateKey).toString('base64url');
  const source = makeMockSourceInstance({ introSigner: rogueSigner });
  let failed = false;
  try {
    await consumeEntrySwitchJoin({
      joinToken: firstInvite.joinToken, from: 'desktop-a', introspectUrl: 'https://a.ragent.test',
      deviceId: TARGET_DEVICE, ownerId: OWNER_ID, publicKeyForFrom: await getDevicePublicKey('desktop-a'),
      fetchImpl: source.fetchImpl,
    });
  } catch (error) {
    failed = error.code === 'INTRO_SIGNATURE_INVALID';
  }
  check('伪造介绍信（非登记私钥）→ 拒绝', failed);
}

{
  // 响应 sourceInstance 与 from 不一致 → 拒绝
  const source = makeMockSourceInstance({ instanceId: 'desktop-evil' });
  let failed = false;
  try {
    await consumeEntrySwitchJoin({
      joinToken: firstInvite.joinToken, from: 'desktop-a', introspectUrl: 'https://a.ragent.test',
      deviceId: TARGET_DEVICE, ownerId: OWNER_ID, publicKeyForFrom: await getDevicePublicKey('desktop-a'),
      fetchImpl: source.fetchImpl,
    });
  } catch (error) {
    failed = error.code === 'INTROSPECT_FAILED';
  }
check('sourceInstance 与 from 不一致 → 拒绝', failed);
}

{
  // 介绍信的 Accounts owner 必须与 B 本机绑定一致，不能因“已配对”越权登录。
  const source = makeMockSourceInstance({ ownerId: 'acct_other_owner' });
  let failed = false;
  try {
    await consumeEntrySwitchJoin({
      joinToken: firstInvite.joinToken, from: 'desktop-a', introspectUrl: 'https://a.ragent.test',
      deviceId: TARGET_DEVICE, ownerId: OWNER_ID, publicKeyForFrom: await getDevicePublicKey('desktop-a'),
      fetchImpl: source.fetchImpl,
    });
  } catch (error) {
    failed = error.code === 'OWNER_ACCOUNT_MISMATCH';
  }
  check('介绍信 ownerId 不匹配 → 拒绝', failed);
}

{
  // 本机清单没有 A 的公钥（未互信）→ 拒绝
  let failed = false;
  try {
    await consumeEntrySwitchJoin({
      joinToken: firstInvite.joinToken, from: 'desktop-unknown', introspectUrl: 'https://a.ragent.test',
      deviceId: TARGET_DEVICE, ownerId: OWNER_ID, publicKeyForFrom: null,
      fetchImpl: async (url) => (
        String(url).endsWith('/api/device-handshake')
          ? { ok: true, status: 200, json: async () => ({ token: 'mock-bearer-x' }) }
          : { ok: true, status: 200, json: async () => ({ ok: true, ownerId: OWNER_ID, introNonce: 'x', introSig: 'y', sourceInstance: 'desktop-unknown' }) }
      ),
    });
  } catch (error) {
    failed = error.code === 'SOURCE_NOT_REGISTERED';
  }
  check('A 未在 B 登记公钥 → 拒绝', failed);
}

// ---------- M2: B 端入口 handler ----------

{
  // 无 join 参数 → 不拦截
  const res = makeRes();
  const handled = await handleEntrySwitchJoin({
    req: { headers: {} }, res, parsedUrl: { pathname: '/', query: {} },
  });
  check('无 join 参数 → 不处理', handled === false && res.statusCode === 200);
}

{
  // B 未绑定 → 302 登录页
  writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({}), 'utf8');
  const res = makeRes();
  const handled = await handleEntrySwitchJoin({
    req: { headers: {} }, res,
    parsedUrl: { pathname: '/', query: { join: firstInvite.joinToken, from: 'desktop-a', device: TARGET_DEVICE, introspect: 'https://a.ragent.test' } },
  });
  check('B 未绑定 → 302 登录页', handled === true && res.statusCode === 302 && res.headers.Location === '/login?error=join_invalid');
  // 恢复绑定
  writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({ accountId: OWNER_ID, provider: 'google', boundAt: new Date().toISOString() }), 'utf8');
}

{
  // 成功路径：mock globalThis.fetch（A 侧响应），B 签发会话并 302
  const source = makeMockSourceInstance();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = source.fetchImpl;
  try {
    const res = makeRes();
    const handled = await handleEntrySwitchJoin({
      req: { headers: {} }, res,
      parsedUrl: { pathname: '/', query: { join: firstInvite.joinToken, from: 'desktop-a', device: TARGET_DEVICE, introspect: 'https://a.ragent.test' } },
    });
    check('B 端入口成功 → 302 首页 + Set-Cookie', handled === true && res.statusCode === 302
      && res.headers.Location === '/' && String(res.headers['Set-Cookie']).includes('session_token='));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------- M3: 设备入口地址登记（entryUrl）+ invite 回落 ----------

{
  // 入口健康探测：owner-only，缺失/未知设备分别返回明确结果。
  const forbidden = makeRes();
  await handleEntrySwitchRoutes({
    req: makeGetReq('/api/entry-switch/health?deviceId=rdev_entrytest'),
    res: forbidden, pathname: '/api/entry-switch/health', authSession: null, writeJson,
  });
  check('health 非 owner → 403', forbidden.statusCode === 403);

  const missingId = makeRes();
  await handleEntrySwitchRoutes({
    req: makeGetReq('/api/entry-switch/health'),
    res: missingId, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
  });
  check('health 缺 deviceId → 400', missingId.statusCode === 400);

  const unknown = makeRes();
  await handleEntrySwitchRoutes({
    req: makeGetReq('/api/entry-switch/health?deviceId=rdev_missing'),
    res: unknown, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
  });
  check('health 未知设备 → 404', unknown.statusCode === 404);

  const noEntry = makeRes();
  await handleEntrySwitchRoutes({
    req: makeGetReq('/api/entry-switch/health?deviceId=rdev_entrytest'),
    res: noEntry, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
  });
  const noEntryPayload = JSON.parse(noEntry.body);
  check('health 未登记入口 → 200 + entry_url_missing',
    noEntry.statusCode === 200 && noEntryPayload.reachable === false && noEntryPayload.reason === 'entry_url_missing');
}

{
  // lib 层：非法协议 400 / 未知设备 404 / 设置 / 清单可见
  let rejected = false;
  try {
    await updateTrustedDeviceEntryUrl('rdev_entrytest', 'ftp://b.ragent.test');
  } catch (error) {
    rejected = error.statusCode === 400;
  }
  check('entryUrl 非法协议 → 400', rejected);
  let notFound = false;
  try {
    await updateTrustedDeviceEntryUrl('rdev_missing', 'https://b.ragent.test');
  } catch (error) {
    notFound = error.statusCode === 404;
  }
  check('entryUrl 未知设备 → 404', notFound);
  const set = await updateTrustedDeviceEntryUrl('rdev_entrytest', 'https://b.ragent.test');
  check('entryUrl 设置成功', set.entryUrl === 'https://b.ragent.test');
  const listed = await listTrustedDevices();
  check('设备清单带 entryUrl',
    listed.devices.find((d) => d.id === 'rdev_entrytest')?.entryUrl === 'https://b.ragent.test');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { status: 401 };
  };
  try {
    const reachable = makeRes();
    await handleEntrySwitchRoutes({
      req: makeGetReq('/api/entry-switch/health?deviceId=rdev_entrytest'),
      res: reachable, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
    });
    const payload = JSON.parse(reachable.body);
    check('health HTTP 应答（含 401）→ reachable',
      reachable.statusCode === 200 && payload.reachable === true && payload.statusCode === 401
      && calls[0]?.url === 'https://b.ragent.test/' && calls[0]?.options?.method === 'HEAD');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const failedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const unreachable = makeRes();
    await handleEntrySwitchRoutes({
      req: makeGetReq('/api/entry-switch/health?deviceId=rdev_entrytest'),
      res: unreachable, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
    });
    const payload = JSON.parse(unreachable.body);
    check('health 网络失败 → 200 + unreachable',
      unreachable.statusCode === 200 && payload.reachable === false && payload.reason === 'unreachable');
  } finally {
    globalThis.fetch = failedFetch;
  }
}

{
  // 健康探测必须保留带路径的隧道入口，不能把请求改写到 origin 根路径。
  await updateTrustedDeviceEntryUrl('rdev_entrytest', 'https://b.ragent.test/ragent');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { status: 200 };
  };
  try {
    const response = makeRes();
    await handleEntrySwitchRoutes({
      req: makeGetReq('/api/entry-switch/health?deviceId=rdev_entrytest'),
      res: response, pathname: '/api/entry-switch/health', authSession: { role: 'owner' }, writeJson,
    });
    check('health 保留隧道路径', calls[0]?.url === 'https://b.ragent.test/ragent');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  // HTTP 层：trusted_device 主体 → 403 / 未知设备 → 404
  const unauthenticated = makeRes();
  await handleDevicePairingOwnerRoutes({
    req: makeBodyReq({ entryUrl: 'https://b.ragent.test' }),
    res: unauthenticated, pathname: '/api/device-pairing/devices/rdev_entrytest/entry-url',
    authSession: null, writeJson,
  });
  check('entry-url 非 owner → 403', unauthenticated.statusCode === 403
    && JSON.parse(unauthenticated.body).error === 'Owner access required');
  const res = makeRes();
  await handleDevicePairingOwnerRoutes({
    req: makeBodyReq({ entryUrl: 'https://b.ragent.test' }),
    res, pathname: '/api/device-pairing/devices/rdev_entrytest/entry-url',
    authSession: { role: 'owner', principalKind: 'trusted_device' }, writeJson,
  });
  check('entry-url trusted_device 主体 → 403', res.statusCode === 403);
  const res2 = makeRes();
  await handleDevicePairingOwnerRoutes({
    req: makeBodyReq({ entryUrl: 'https://b.ragent.test' }),
    res: res2, pathname: '/api/device-pairing/devices/rdev_nope/entry-url',
    authSession: { role: 'owner' }, writeJson,
  });
  check('entry-url 未知设备 → 404', res2.statusCode === 404);
  const res3 = makeRes();
  await handleDevicePairingOwnerRoutes({
    req: makeBodyReq({ entryUrl: 'ftp://b.ragent.test' }),
    res: res3, pathname: '/api/device-pairing/devices/rdev_entrytest/entry-url',
    authSession: { role: 'owner' }, writeJson,
  });
  check('entry-url 非法协议 → 400', res3.statusCode === 400);
  const res4 = makeRes();
  await handleDevicePairingOwnerRoutes({
    req: makeBodyReq({ entryUrl: 'https://b2.ragent.test' }),
    res: res4, pathname: '/api/device-pairing/devices/rdev_entrytest/entry-url',
    authSession: { role: 'owner' }, writeJson,
  });
  check('entry-url 路由设置 → 200', res4.statusCode === 200
    && JSON.parse(res4.body).device.entryUrl === 'https://b2.ragent.test');
}

{
  // 登记后：invite 不传 targetUrl → 回落已登记 entryUrl
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: 'rdev_entrytest' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('invite 回落已登记 entryUrl → 200',
    res.statusCode === 200 && new URL(JSON.parse(res.body).jumpUrl).origin === 'https://b2.ragent.test');
}

{
  // 清除登记后：invite 无 targetUrl → 400
  const cleared = await updateTrustedDeviceEntryUrl('rdev_entrytest', '');
  check('entryUrl 清除成功', cleared.entryUrl === undefined || cleared.entryUrl === '');
  const res = makeRes();
  await handleEntrySwitchRoutes({
    req: makeBodyReq({ targetDeviceId: 'rdev_entrytest' }),
    res, pathname: '/api/entry-switch/invite', authSession: { role: 'owner' }, writeJson,
  });
  check('清除后 invite 无 targetUrl → 400', res.statusCode === 400);
}

check('join 失效登录页包含明确错误提示', loginTemplate.includes('id="join-error"')
  && loginTemplate.includes("get('error') === 'join_invalid'")
  && loginTemplate.includes('login.joinInvalid'));

console.log(`test-entry-switch: ok (${passed} assertions)`);
rmSync(tempHome, { recursive: true, force: true });
