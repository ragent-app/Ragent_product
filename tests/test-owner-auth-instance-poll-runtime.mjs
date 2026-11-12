#!/usr/bin/env node
// 实例侧 instance_poll Runtime 契约测试（阶段 3）：
// 无公网 URL 的 bind/login、可恢复 poller、断言验证、安全状态查询、
// 不保存凭据检查、响应丢失重试不重复绑定。
import assert from 'assert/strict';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'agentoc-owner-auth-poll-runtime-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ACCOUNTS_ISSUER = 'https://accounts.example.test';
process.env.AGENTOC_AUTH_SESSION_SECRET = 'owner-auth-poll-runtime-session-secret';
// 关键：没有 AGENTOC_PUBLIC_BASE_URL —— 模拟无公网实例。
delete process.env.AGENTOC_PUBLIC_BASE_URL;
delete process.env.AGENTOC_INSTANCE_ROOT;
process.env.SECURE_COOKIES = '0';
mkdirSync(process.env.AGENTOC_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.AGENTOC_CONFIG_DIR, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'not-used' }));

const {
  startOwnerAccountAuth,
  attachOwnerAuthPoller,
  getOwnerAccountBinding,
  getOwnerAccountTransactionStatus,
  getActiveOwnerAuthPollerCount,
  pollOwnerAccountRendezvous,
  stopOwnerAuthPollers,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'owner-account-auth.mjs')).href);
const { runOwnerAuthPollTick } = await import(pathToFileURL(join(repoRoot, 'lib', 'owner-auth-instance-poller.mjs')).href);
const { handleGoogleOwnerAuthRoutes } = await import(pathToFileURL(join(repoRoot, 'chat', 'router-google-owner-routes.mjs')).href);
const { loadOrCreateInstanceIdentity, publicInstanceIdentity } = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-identity.mjs')).href);

const signing = generateKeyPairSync('ed25519');
const kid = 'accounts-poll-test-key';
const publicJwk = { ...signing.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' };
let now = Date.now();

function b64u(value) {
  return Buffer.from(value).toString('base64url');
}

function signAssertion(claims) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', kid }));
  const payload = b64u(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), signing.privateKey).toString('base64url')}`;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Accounts mock：事务完成状态由测试切换；记录收到的 instance-redeem 请求。
const created = new Map();
let accountsCompleted = false;
let accountStatus = 'pending';
const redeemRequests = [];
let dropResponseOnce = false;
let rendezvousInboxRequests = 0;
let rendezvousReady = false;
let rendezvousCompleteBody = null;
let rendezvousHostStart = null;
let transactionTtlMs = 300000;

const rendezvousRequestId = 'rendezvous_runtime_001';
const rendezvousIntent = {
  intentId: 'rji_runtime_001',
  instanceId: '',
  deviceId: 'rdev_runtime_001',
  devicePublicKeyFingerprint: 'a'.repeat(64),
  nonce: 'nonce_runtime_001',
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120000).toISOString(),
  publicEndpoint: '',
  requestId: rendezvousRequestId,
  accountClaimTokenHash: '',
};

async function mockFetch(url, options = {}) {
  const target = new URL(url);
  if (target.pathname === '/v1/owner-auth/rendezvous/inbox') {
    rendezvousInboxRequests += 1;
    if (rendezvousReady) {
      return response(200, {
        intent: rendezvousIntent,
        grant: { accountJoinGrant: 'raj_runtime_grant', deviceSignature: 'runtime-device-signature' },
      });
    }
    return response(200, { intent: null, grant: null });
  }
  if (/^\/v1\/owner-auth\/account-intents\/[^/]+\/complete$/.test(target.pathname)) {
    const record = created.get(rendezvousRequestId);
    return response(200, {
      assertion: signAssertion({
        iss: 'https://accounts.example.test',
        aud: record?.instance?.instanceId || rendezvousIntent.instanceId,
        sub: 'acct_owner_1',
        purpose: 'account_join',
        tx: rendezvousRequestId,
        intentId: rendezvousIntent.intentId,
        deviceId: rendezvousIntent.deviceId,
        devicePublicKeyFingerprint: rendezvousIntent.devicePublicKeyFingerprint,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 60,
      }),
      expiresAt: new Date(now + 60000).toISOString(),
    });
  }
  if (new RegExp(`/v1/owner-auth/rendezvous/${rendezvousRequestId}/complete$`).test(target.pathname)) {
    rendezvousCompleteBody = JSON.parse(options.body);
    return response(200, { requestId: rendezvousRequestId, status: 'completed' });
  }
  if (target.pathname === '/v1/owner-auth/transactions' && options.method === 'POST') {
    const body = JSON.parse(options.body);
    created.set(body.transactionId, body);
    assert.equal(body.deliveryMode, 'instance_poll');
    assert.equal(body.returnUrl, undefined);
    return response(201, {
      transactionId: body.transactionId,
      authUrl: `https://accounts.example.test/owner/google?tx=${encodeURIComponent(body.transactionId)}`,
      expiresAt: new Date(now + transactionTtlMs).toISOString(),
    });
  }
  const redeem = /^\/v1\/owner-auth\/transactions\/([^/]+)\/instance-redeem$/.exec(target.pathname);
  if (redeem && options.method === 'POST') {
    const body = JSON.parse(options.body);
    redeemRequests.push(body);
    if (dropResponseOnce) {
      dropResponseOnce = false;
      // 模拟响应丢失：Accounts 已处理，但实例没收到响应。
      accountsCompleted = true;
      accountStatus = 'completed';
      throw new TypeError('network response was lost');
    }
    if (!accountsCompleted) return response(200, { status: 'pending', expiresAt: new Date(now + 300000).toISOString(), retryAfterMs: 2000 });
    const record = created.get(decodeURIComponent(redeem[1]));
    return response(200, {
      status: 'completed',
      assertion: signAssertion({
        iss: 'https://accounts.example.test',
        aud: record.instance.instanceId,
        sub: 'acct_owner_1',
        ...(record.purpose === 'bind' ? { provider: 'demo' } : {}),
        purpose: record.purpose,
        tx: record.transactionId,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 60,
      }),
      expiresAt: new Date(now + 60000).toISOString(),
    });
  }
  if (target.pathname === '/.well-known/jwks.json') return response(200, { keys: [publicJwk] });
  return response(404, { code: 'not_found' });
}

globalThis.fetch = mockFetch;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; Object.assign(this.headers, headers); },
    end(body = '') { this.body = body; },
  };
}

function transactionFile() {
  return JSON.parse(readFileSync(join(process.env.AGENTOC_CONFIG_DIR, 'owner-account-transactions.json'), 'utf8'));
}

try {
  const idleRendezvous = await pollOwnerAccountRendezvous({
    fetchImpl: mockFetch,
    buildBootstrap: async () => ({
      turn: {
        iceServers: [{ urls: 'turn:turn.example.test', username: 'u', password: 'p' }],
        expiresAt: new Date(now + 60000).toISOString(),
      },
    }),
    clock: () => now,
  });
  await check('未绑定实例不访问 rendezvous inbox', async () => {
    assert.deepEqual(idleRendezvous, { handled: false, reason: 'not-bound' });
    assert.equal(rendezvousInboxRequests, 0);
  });

  const bindStart = await startOwnerAccountAuth({ purpose: 'bind', alias: 'Pinggu', fetchImpl: mockFetch, clock: () => now });
  await check('无公网 URL 时 bind 自动选择 instance_poll 且不带 stateCookie', async () => {
    assert.equal(bindStart.deliveryMode, 'instance_poll');
    assert.match(bindStart.transactionId, /^otx_/);
    assert.equal(bindStart.stateCookie, undefined);
    assert.match(bindStart.authUrl, /^https:\/\/accounts\.example\.test\/owner\/google\?tx=/);
    const sent = created.get(bindStart.transactionId);
    assert.equal(sent.deliveryMode, 'instance_poll');
    assert.equal(sent.returnUrl, undefined);
    assert.equal(sent.audience, 'agentoc-owner-auth-poll');
  });

  await check('本地事务只保存元数据，不含凭据', async () => {
    const record = transactionFile().entries[bindStart.transactionId];
    assert.equal(record.deliveryMode, 'instance_poll');
    assert.match(record.requestId, /^opll_/);
    assert.equal(record.pollState, 'polling');
    const serialized = JSON.stringify(record);
    assert.equal(/grant|assertion|idToken|Bearer/i.test(serialized), false);
  });

  const pendingStatus = await getOwnerAccountTransactionStatus(bindStart.transactionId);
  await check('安全状态查询初始为 pending 且无敏感字段', async () => {
    assert.deepEqual(pendingStatus, {
      status: 'pending',
      expiresAt: new Date(now + 300000).toISOString(),
      deliveryMode: 'instance_poll',
    });
    assert.equal(JSON.stringify(pendingStatus).includes('acct_owner_1'), false);
  });

  await check('pending 阶段轮询不改变本地 owner 状态', async () => {
    assert.equal(await getOwnerAccountBinding(), null);
    attachOwnerAuthPoller(bindStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
    await runOwnerAuthPollTick(bindStart.transactionId);
    assert.equal(await getOwnerAccountBinding(), null);
    assert.equal(transactionFile().entries[bindStart.transactionId].pollState, 'polling');
  });

  // 场景：Accounts 已完成但首次领取响应丢失 → 同 requestId 重试成功。
  dropResponseOnce = true;
  // 网络故障属于可恢复错误：poller 负责退避重试，不把暂时不可用状态
  // 暴露为一次 tick 的异常。
  await runOwnerAuthPollTick(bindStart.transactionId);
  await check('响应丢失后事务仍为 polling（等待重试）', async () => {
    assert.equal(transactionFile().entries[bindStart.transactionId].pollState, 'polling');
    assert.equal(await getOwnerAccountBinding(), null);
  });

  // 重新附加 poller 并手动 tick（重启恢复也走同一路径）。
  stopOwnerAuthPollers();
  attachOwnerAuthPoller(bindStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
  await runOwnerAuthPollTick(bindStart.transactionId);
  await check('重试后领取断言并完成本地绑定（收敛一次）', async () => {
    assert.equal(transactionFile().entries[bindStart.transactionId].pollState, 'completed');
    assert.deepEqual(await getOwnerAccountBinding(), {
      accountId: 'acct_owner_1', provider: 'demo', boundAt: new Date(now).toISOString(), deviceAlias: 'Pinggu',
      plan: 'free', limits: { phones: 1, computers: 1 },
    });
  });

  const instanceIdentity = await loadOrCreateInstanceIdentity();
  rendezvousIntent.instanceId = instanceIdentity.instanceId;
  rendezvousIntent.instance = publicInstanceIdentity(instanceIdentity);
  rendezvousReady = true;
  const deliveryBodies = [];
  const setupCalls = { inbox: 0, grant: 0, local: 0, bootstrap: 0, host: 0 };
  await pollOwnerAccountRendezvous({
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/rendezvous/inbox')) setupCalls.inbox++;
      if (/\/account-intents\/[^/]+\/complete$/.test(path)) setupCalls.grant++;
      if (/\/rendezvous\/[^/]+\/complete$/.test(path)) {
        deliveryBodies.push(options.body);
        if (deliveryBodies.length === 1) return {
          ...response(429, {}), headers: { get: () => '1' },
        };
      }
      return mockFetch(url, options);
    },
    completeLocal: async (input) => {
      setupCalls.local++;
      assert.equal(input.verifiedAccountCompletion, true);
      writeFileSync(join(process.env.AGENTOC_CONFIG_DIR, 'trusted-devices.json'), JSON.stringify({
        version: 1,
        instanceId: rendezvousIntent.instanceId,
        instanceSecret: 'runtime-p2p-instance-secret',
        invitations: [],
        devices: [{
          id: rendezvousIntent.deviceId,
          status: 'bound',
          enrollmentKind: 'account-join',
          accountId: 'acct_owner_1',
          devicePublicKey: 'runtime-device-public-key',
          deviceName: 'Runtime device',
          platform: 'android',
          revokedAt: '',
        }],
        challenges: [],
        authTokens: [],
        accountJoinIntents: [],
      }));
      return {
        credential: {
          token: 'rda_runtime_credential',
          expiresAt: new Date(now + 900000).toISOString(),
          scope: 'device-access',
        },
      };
    },
    buildBootstrap: async () => { setupCalls.bootstrap++; return ({
      turn: {
        iceServers: [{ urls: 'turn:turn.example.test', username: 'u', password: 'p' }],
        expiresAt: new Date(now + 60000).toISOString(),
      },
    }); },
    startP2PHost: async (options) => { setupCalls.host++; rendezvousHostStart = options; return { started: true }; },
    clock: () => now,
  });
  await check('final complete429 retries the same signed publication without repeating setup', async () => {
    assert.equal(deliveryBodies.length, 2);
    assert.equal(deliveryBodies[0], deliveryBodies[1]);
    assert.deepEqual(setupCalls, { inbox: 1, grant: 1, local: 1, bootstrap: 1, host: 1 });
  });
  await check('429 after grant redemption retries only safe verification and local authority steps', async () => {
    const previousCompletion = rendezvousCompleteBody;
    const counts = { grant: 0, jwks: 0, local: 0, p2p: 0, bootstrap: 0, final: 0 };
    await pollOwnerAccountRendezvous({
      clock: () => now,
      fetchImpl: async (url, options) => {
        const path = new URL(url).pathname;
        if (/\/account-intents\/[^/]+\/complete$/.test(path)) counts.grant++;
        if (path === '/.well-known/jwks.json' && ++counts.jwks === 1)
          return { ...response(429, {}), headers: { get: () => '1' } };
        if (/\/rendezvous\/[^/]+\/complete$/.test(path)) counts.final++;
        return mockFetch(url, options);
      },
      completeLocal: async () => {
        if (++counts.local === 1) throw Object.assign(new Error('rate limited'), {
          code: 'owner_auth_broker_rate_limited', statusCode: 429, retryAfterMs: 1000,
        });
        return { credential: { token: 'rda_fixture', expiresAt: new Date(now + 900000).toISOString(), scope: 'device-access' } };
      },
      readP2PAccess: async deviceId => {
        assert.equal(deviceId, rendezvousIntent.deviceId);
        if (++counts.p2p === 1) throw Object.assign(new Error('rate limited'), {
          code: 'owner_auth_broker_rate_limited', statusCode: 429, retryAfterMs: 1000,
        });
        return { roomId: 'test-room', secret: 'test-secret' };
      },
      buildBootstrap: async () => { counts.bootstrap++; return {}; },
    });
    assert.deepEqual(counts, { grant: 1, jwks: 2, local: 2, p2p: 2, bootstrap: 1, final: 1 });
    rendezvousCompleteBody = previousCompletion;
  });
  await check('rendezvous 结果显式包含 Bearer 凭据类型', async () => {
    assert.equal(rendezvousCompleteBody?.result?.credential?.type, 'Bearer');
    assert.equal(rendezvousCompleteBody?.result?.credential?.token, 'rda_runtime_credential');
    assert.equal(rendezvousCompleteBody?.result?.credential?.scope, 'device-access');
  });
  await check('rendezvous publishes a bounded quota denial without credentials or host startup', async () => {
    const previousCompletion = rendezvousCompleteBody;
    let hostCalls = 0;
    try {
      await pollOwnerAccountRendezvous({
        fetchImpl: mockFetch,
        clock: () => now,
        completeLocal: async () => ({ credential: { token: 'rda_must_not_publish',
          expiresAt: new Date(now + 900000).toISOString(), scope: 'device-access' } }),
        readP2PAccess: async () => ({ roomId: 'test-room', secret: 'must_not_publish' }),
        buildBootstrap: async () => { throw Object.assign(new Error('quota'), {
          code: 'turn_connection_quota_exceeded', statusCode: 503,
        }); },
        startP2PHost: async () => { hostCalls++; },
      });
      assert.deepEqual(rendezvousCompleteBody.result, { error: { code: 'turn_connection_quota_exceeded' } });
      assert.equal(hostCalls, 0);
    } finally { rendezvousCompleteBody = previousCompletion; }
  });
  await check('rendezvous 在 Accounts 完成回报前启动本地 P2P Host', async () => {
    assert.equal(rendezvousHostStart?.deviceId, rendezvousIntent.deviceId);
    assert.match(rendezvousHostStart?.p2p?.roomId || '', /^[a-f0-9]{40}$/);
    assert.deepEqual(rendezvousHostStart?.iceServers, [{ urls: 'turn:turn.example.test', username: 'u', password: 'p' }]);
    assert.equal(rendezvousHostStart?.relayOnly, true, 'account rendezvous must make the host match Android relay-only ICE policy');
    assert.equal(rendezvousHostStart?.expiresAt, new Date(now + 60000).toISOString());
  });

  async function failedDelivery(send, { signal, afterSetup } = {}) {
    const counts = { final: 0, grant: 0, local: 0, bootstrap: 0, host: 0 };
    const operation = pollOwnerAccountRendezvous({
      clock: () => now, signal,
      fetchImpl: async (url, options) => {
        const path = new URL(url).pathname;
        if (/\/account-intents\/[^/]+\/complete$/.test(path)) counts.grant++;
        if (/\/rendezvous\/[^/]+\/complete$/.test(path)) {
          counts.final++;
          return send(counts.final, options);
        }
        return mockFetch(url, options);
      },
      completeLocal: async () => {
        counts.local++;
        return { credential: { token: 'rda_fixture', expiresAt: new Date(now + 900000).toISOString(), scope: 'device-access' } };
      },
      buildBootstrap: async () => { counts.bootstrap++; return {}; },
      startP2PHost: async () => { counts.host++; afterSetup?.(); return { started: true }; },
    });
    return { counts, operation };
  }

  await check('final complete429 then503 sends exactly two physical POSTs and does not redo setup', async () => {
    const { counts, operation } = await failedDelivery(async attempt => attempt === 1
      ? { ...response(429, {}), headers: { get: () => '1' } }
      : response(503, {}));
    await assert.rejects(operation, { statusCode: 503 });
    assert.deepEqual(counts, { final: 2, grant: 1, local: 1, bootstrap: 1, host: 1 });
  });

  await check('final complete network outcome is not retried by the inner transport', async () => {
    const { counts, operation } = await failedDelivery(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    await assert.rejects(operation, { code: 'owner_auth_broker_unavailable' });
    assert.deepEqual(counts, { final: 1, grant: 1, local: 1, bootstrap: 1, host: 1 });
  });

  await check('cancelling final429 cooldown preserves caller reason and sends no second POST', async () => {
    const controller = new AbortController();
    const reason = new Error('runtime cancelled final delivery');
    const { counts, operation } = await failedDelivery(async () => {
      setTimeout(() => controller.abort(reason), 20);
      return { ...response(429, {}), headers: { get: () => '1' } };
    }, { signal: controller.signal });
    await assert.rejects(operation, e => e === reason);
    assert.deepEqual(counts, { final: 1, grant: 1, local: 1, bootstrap: 1, host: 1 });
  });

  await check('the original intent deadline blocks a late successful final response', async () => {
    const before = now;
    try {
      const { counts, operation } = await failedDelivery(async () => {
        now = Date.parse(rendezvousIntent.expiresAt) + 1;
        return response(200, { status: 'rendezvous_completed' });
      });
      await assert.rejects(operation, { code: 'owner_auth_rendezvous_expired' });
      assert.deepEqual(counts, { final: 1, grant: 1, local: 1, bootstrap: 1, host: 1 });
    } finally { now = before; }
  });

  await check('expiry during Host setup makes no final POST or repeated reservation', async () => {
    const before = now;
    try {
      const { counts, operation } = await failedDelivery(async () => response(200, {}), {
        afterSetup: () => { now = Date.parse(rendezvousIntent.expiresAt) + 1; },
      });
      await assert.rejects(operation, { code: 'owner_auth_rendezvous_expired' });
      assert.deepEqual(counts, { final: 0, grant: 1, local: 1, bootstrap: 1, host: 1 });
    } finally { now = before; }
  });

  await check('429 限流响应识别为 owner_auth_broker_rate_limited 并携带 Retry-After', async () => {
    for (const seconds of [9, 600]) {
      await assert.rejects(
        () => pollOwnerAccountRendezvous({
          fetchImpl: async () => ({
            ok: false,
            status: 429,
            json: async () => ({}),
            headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? String(seconds) : null) },
          }),
          buildBootstrap: async () => ({}),
          clock: () => now,
        }),
        (error) => {
          assert.equal(error.code, 'owner_auth_broker_rate_limited');
          assert.equal(error.statusCode, 429);
          assert.equal(error.retryAfterMs, seconds * 1000);
          assert.match(error.message, /rendezvous-inbox/);
          assert.doesNotMatch(error.message, /https?:|acct_|rda_/);
          return true;
        },
      );
    }
  });

  await check('HTTP-date Retry-After is preserved for broker cooldown', async () => {
    const deadline = Date.now() + 10 * 60_000;
    await assert.rejects(
      () => pollOwnerAccountRendezvous({
        fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}),
          headers: { get: name => String(name).toLowerCase() === 'retry-after' ? new Date(deadline).toUTCString() : null } }),
        buildBootstrap: async () => ({}), clock: () => now,
      }),
      error => error.code === 'owner_auth_broker_rate_limited' && error.retryAfterMs > 598_000 && error.retryAfterMs <= 600_000,
    );
  });

  await check('同 requestId 的重试请求幂等（网络层不重复绑定）', async () => {
    const before = redeemRequests.length;
    stopOwnerAuthPollers();
    attachOwnerAuthPoller(bindStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
    await runOwnerAuthPollTick(bindStart.transactionId);
    // 已 completed 的事务直接停止，不再发请求。
    assert.equal(redeemRequests.length, before);
    assert.equal(transactionFile().entries[bindStart.transactionId].pollState, 'completed');
    assert.equal(getActiveOwnerAuthPollerCount(), 0);
  });

  await check('completed 状态查询不泄露 accountId', async () => {
    const status = await getOwnerAccountTransactionStatus(bindStart.transactionId);
    assert.equal(status.status, 'completed');
    assert.equal(JSON.stringify(status).includes('acct_owner_1'), false);
  });

  const noPublicRoute = responseRecorder();
  await handleGoogleOwnerAuthRoutes({
    req: { method: 'GET', url: '/api/auth/google/bind/redirect', headers: {} },
    res: noPublicRoute,
    pathname: '/api/auth/google/bind/redirect',
    authSession: { role: 'owner' },
    writeJson: (res, statusCode, value) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    },
  });
  await check('无公网 URL 时 router 仍进入 Accounts instance_poll 而非 legacy', async () => {
    assert.equal(noPublicRoute.statusCode, 302, noPublicRoute.body);
    assert.match(noPublicRoute.headers.Location, /^https:\/\/accounts\.example\.test\/owner\/google\?tx=/);
    assert.equal(noPublicRoute.headers['Set-Cookie'], undefined);
  });

  const routeTransactionId = new URL(noPublicRoute.headers.Location).searchParams.get('tx');
  const statusRoute = responseRecorder();
  await handleGoogleOwnerAuthRoutes({
    req: { method: 'GET', url: `/api/auth/google/transactions/${encodeURIComponent(routeTransactionId)}`, headers: {} },
    res: statusRoute,
    pathname: `/api/auth/google/transactions/${encodeURIComponent(routeTransactionId)}`,
    authSession: null,
    writeJson: (res, statusCode, value) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    },
  });
  await check('实例安全状态路由返回 pending 且只含非敏感字段', async () => {
    const body = JSON.parse(statusRoute.body);
    assert.equal(statusRoute.statusCode, 200);
    assert.deepEqual(body.deliveryMode, 'instance_poll');
    assert.equal(body.status, 'pending');
    assert.equal(Object.hasOwn(body, 'accountId'), false);
    assert.equal(Object.hasOwn(body, 'assertion'), false);
  });

  // login 场景：已绑定账号完成登录收敛。
  accountsCompleted = false;
  const loginStart = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
  await check('无公网 URL 时 login 同样走 instance_poll', async () => {
    assert.equal(loginStart.deliveryMode, 'instance_poll');
    assert.match(loginStart.stateCookie, /^agentoc_owner_account_state=/);
    assert.equal(/grant|assertion|idToken|Bearer/i.test(loginStart.stateCookie), false);
  });

  // 错误账号断言 → fail closed，不写绑定。
  accountsCompleted = true;
  const record = created.get(loginStart.transactionId);
  const originalAud = record.instance.instanceId;
  record.instance = { ...record.instance, instanceId: 'inst_other' };
  stopOwnerAuthPollers();
  attachOwnerAuthPoller(loginStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
  await runOwnerAuthPollTick(loginStart.transactionId);
  await check('断言 audience 不匹配时 fail closed', async () => {
    assert.equal(transactionFile().entries[loginStart.transactionId].pollState, 'failed');
    assert.equal(transactionFile().entries[loginStart.transactionId].pollError, 'owner_auth_assertion_invalid');
    // 既有绑定未被破坏
    assert.equal((await getOwnerAccountBinding()).accountId, 'acct_owner_1');
  });
  record.instance = { ...record.instance, instanceId: originalAud };

  // 成功 login：轮询完成后，只有持有该事务 opaque cookie 的浏览器能领取
  // 当前 owner session；响应体仍不包含 token、accountId 或 assertion。
  const handoffStart = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
  stopOwnerAuthPollers();
  attachOwnerAuthPoller(handoffStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
  await runOwnerAuthPollTick(handoffStart.transactionId);
  const unauthorizedHandoffRoute = responseRecorder();
  await handleGoogleOwnerAuthRoutes({
    req: {
      method: 'GET',
      url: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
      headers: {},
    },
    res: unauthorizedHandoffRoute,
    pathname: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
    authSession: null,
    writeJson: (res, statusCode, value) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    },
  });
  await check('login 状态接口没有 opaque cookie 时不泄露事务状态', async () => {
    assert.equal(unauthorizedHandoffRoute.statusCode, 404);
    assert.equal(JSON.stringify(unauthorizedHandoffRoute.body).includes('completed'), false);
  });
  const handoffRoute = responseRecorder();
  const handoffCookie = String(handoffStart.stateCookie).split(';')[0];
  await handleGoogleOwnerAuthRoutes({
    req: {
      method: 'GET',
      url: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
      headers: { cookie: handoffCookie },
    },
    res: handoffRoute,
    pathname: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
    authSession: null,
    writeJson: (res, statusCode, value) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    },
  });
  await check('login completed 通过安全状态接口一次性交接 owner session', async () => {
    const body = JSON.parse(handoffRoute.body);
    assert.equal(handoffRoute.statusCode, 200, handoffRoute.body);
    assert.deepEqual(body, {
      status: 'completed',
      expiresAt: new Date(now + 300000).toISOString(),
      deliveryMode: 'instance_poll',
    });
    assert.ok(String(handoffRoute.headers['Set-Cookie']).includes('session_token='));
    assert.equal(transactionFile().entries[handoffStart.transactionId].sessionHandoffState, 'issued');
    assert.equal(/acct_owner_1|assertion|grant/i.test(handoffRoute.body), false);
  });

  const repeatedHandoffRoute = responseRecorder();
  await handleGoogleOwnerAuthRoutes({
    req: {
      method: 'GET',
      url: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
      headers: { cookie: handoffCookie },
    },
    res: repeatedHandoffRoute,
    pathname: `/api/auth/google/transactions/${encodeURIComponent(handoffStart.transactionId)}`,
    authSession: null,
    writeJson: (res, statusCode, value) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    },
  });
  await check('重复状态查询不重复签发 owner session', async () => {
    assert.equal(repeatedHandoffRoute.statusCode, 200);
    assert.equal(String(repeatedHandoffRoute.headers['Set-Cookie'] || '').includes('session_token='), false);
    assert.deepEqual(JSON.parse(repeatedHandoffRoute.body), {
      status: 'completed',
      expiresAt: new Date(now + 300000).toISOString(),
      deliveryMode: 'instance_poll',
    });
  });

  // 事务过期 → expired
  accountsCompleted = false;
  const expireStart = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
  stopOwnerAuthPollers();
  attachOwnerAuthPoller(expireStart.transactionId, { fetchImpl: mockFetch, clock: () => now });
  now += 6 * 60 * 1000;
  await runOwnerAuthPollTick(expireStart.transactionId);
  await check('事务过期后投影 expired 且停止轮询', async () => {
    assert.equal(transactionFile().entries[expireStart.transactionId].pollState, 'expired');
    assert.equal((await getOwnerAccountTransactionStatus(expireStart.transactionId)).status, 'expired');
    assert.equal(getActiveOwnerAuthPollerCount(), 0);
  });

  await check('未知事务状态查询返回 null', async () => {
    assert.equal(await getOwnerAccountTransactionStatus('otx_missing'), null);
  });

  await check('十五分钟 poll 事务在六分钟后仍有效，浏览器状态期限与服务端一致', async () => {
    transactionTtlMs = 900000;
    const started = await startOwnerAccountAuth({ purpose: 'login', fetchImpl: mockFetch, clock: () => now });
    assert.match(started.stateCookie, /Max-Age=900/);
    const expectedExpiry = started.expiresAt;
    now += 6 * 60 * 1000;
    const pending = await getOwnerAccountTransactionStatus(started.transactionId, { clock: () => now });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.expiresAt, expectedExpiry);
    now += 10 * 60 * 1000;
    assert.equal((await getOwnerAccountTransactionStatus(started.transactionId, { clock: () => now })).status, 'expired');
  });

  await check('登录页 instance_poll 使用新窗口与安全状态接口交接', async () => {
    const loginTemplate = readFileSync(join(repoRoot, 'templates', 'login.html'), 'utf8');
    assert.match(loginTemplate, /deliveryMode === 'instance_poll'/);
    assert.match(loginTemplate, /window\.open\('about:blank'/);
    assert.match(loginTemplate, /api\/auth\/google\/transactions\//);
    assert.match(loginTemplate, /credentials: 'same-origin'/);
    assert.equal(/sessionStorage\.setItem|deliveryGrant|assertion/.test(loginTemplate), false);
  });

  console.log(`test-owner-auth-instance-poll-runtime: ${passed} assertions passed`);
} finally {
  stopOwnerAuthPollers();
  const { closeAuthSessionStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href);
  closeAuthSessionStore();
  rmSync(home, { recursive: true, force: true });
}
