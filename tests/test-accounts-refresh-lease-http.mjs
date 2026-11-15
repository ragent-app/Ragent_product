#!/usr/bin/env node
// 跨设备 provider refresh lease 的 HTTP 集成测试。
// 模拟两台已绑定设备通过真实 Accounts HTTP 服务器交互：
// - acquire / heartbeat / complete / status / release 路由均通过 HTTP 验证
// - fencing token 单调递增（接管后旧 holder heartbeat 被 fence 拒绝）
// - 错误签名、越权请求返回正确 HTTP 状态码

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

// 动态导入（与 test-accounts-server.mjs 相同的模式，避免模块缓存污染）
const { createAccountsServer } = await import(
  pathToFileURL(join(root, 'accounts/server.mjs')).href
);
const identityModule = await import(
  pathToFileURL(join(root, 'lib/instance-identity.mjs')).href
);

const dir = await mkdtemp(join(tmpdir(), 'ragent-lease-http-'));

// 生成两个设备 identity（+ 越权测试用设备）
const deviceA = await identityModule.loadOrCreateInstanceIdentity({
  filePath: join(dir, 'deviceA.json'),
});
const deviceB = await identityModule.loadOrCreateInstanceIdentity({
  filePath: join(dir, 'deviceB.json'),
});
const rogue = await identityModule.loadOrCreateInstanceIdentity({
  filePath: join(dir, 'rogue.json'),
});

// 可控时钟
let now = Date.parse('2026-08-27T00:00:00.000Z');
const clock = () => now;

// 内存 store（带预设 instanceBindings）：两台设备绑定 acct_main，rogue 绑定 acct_other
const storeState = {
  instanceBindings: [
    { instanceId: deviceA.instanceId, accountId: 'acct_main', revokedAt: '' },
    { instanceId: deviceB.instanceId, accountId: 'acct_main', revokedAt: '' },
    { instanceId: rogue.instanceId, accountId: 'acct_other', revokedAt: '' },
  ],
};
let storeQueue = Promise.resolve();
const memoryStore = {
  async ping() { return true; },
  mutate(mutator) {
    const run = storeQueue.then(async () => mutator(storeState));
    storeQueue = run.catch(() => {});
    return run;
  },
};

const auditLog = [];

const app = await createAccountsServer({
  signingKeyFile: join(dir, 'signing-key.json'),
  publicBaseUrl: 'http://127.0.0.1:0/accounts',
  googleWebClientId: 'test.apps.googleusercontent.com',
  allowInsecurePublicBaseUrl: true,
  clock,
  store: memoryStore,
  audit: (fields) => auditLog.push(fields),
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
});

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  const handled = await app.handler(req, res, port);
  if (!handled && !res.writableEnded) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// HTTP POST helper
function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// proof 构建辅助（与 broker 单测一致，显式传 operation）
const CRED = {
  accountId: 'acct_main',
  providerFamily: 'agy',
  accountKey: 'account:agy:test-profile',
  credentialInstanceId: 'cred-inst-http-1',
};

function makeProof(device, fields = {}) {
  const issuedAt = new Date(now).toISOString();
  const base = {
    requestId: fields.requestId || `rl_${Math.random().toString(36).slice(2)}`,
    accountId: CRED.accountId,
    providerFamily: CRED.providerFamily,
    accountKey: CRED.accountKey,
    credentialInstanceId: CRED.credentialInstanceId,
    ...fields,
    issuedAt,
    audience: 'ragent-provider-refresh-lease',
    instance: identityModule.publicInstanceIdentity(device),
  };
  return {
    ...base,
    signature: identityModule.signProviderRefreshLeaseProof(device, base).signature,
  };
}

let passed = 0;
let failed = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`ok - ${name}`);
    passed++;
  } else {
    console.error(`FAIL - ${name}${extra ? ' :: ' + extra : ''}`);
    failed++;
  }
}

const BASE = '/accounts/v1/owner-auth/refresh-leases';

// ── 1. 基本 acquire ──────────────────────────────────────────────────────────
const acqA = await post(`${BASE}/acquire`, makeProof(deviceA, {
  requestId: 'http_req_a1',
  operation: 'acquire',
}));
check('acquire 返回 200', acqA.status === 200, acqA.text);
// 响应结构: { acquired, lease: { leaseId, fencingToken, holderInstanceId, ... }, credential, priorOutcome }
check('acquire 含 leaseId', typeof acqA.json?.lease?.leaseId === 'string', acqA.text);
check('acquire 含 fencingToken', typeof acqA.json?.lease?.fencingToken === 'number', acqA.text);
check('acquire holder 是 deviceA', acqA.json?.lease?.holderInstanceId === deviceA.instanceId, acqA.text);
const leaseId = acqA.json?.lease?.leaseId;
const ftA = acqA.json?.lease?.fencingToken;

// ── 2. status 查询 ───────────────────────────────────────────────────────────
// statusOfRefreshLease 返回: { accountId, identities: [{ identityKey, credential, heldByOther? }] }
const stat1 = await post(`${BASE}/status`, makeProof(deviceB, {
  requestId: 'http_req_b_stat1',
  operation: 'status',
}));
check('status 返回 200', stat1.status === 200, stat1.text);
// 至少有一个 identity 且 heldByOther.holderInstanceId 指向 deviceA
const heldByOther = stat1.json?.identities?.[0]?.heldByOther;
check('status 显示 heldByOther.holder=deviceA',
  heldByOther?.holderInstanceId === deviceA.instanceId, stat1.text);

// ── 3. heartbeat（持有者续租）───────────────────────────────────────────────
// heartbeatRefreshLease 返回: { renewed, lease: { fencingToken, ... }, credential }
const hb1 = await post(`${BASE}/heartbeat`, makeProof(deviceA, {
  requestId: 'http_req_a_hb1',
  leaseId,
  fencingToken: ftA,
  operation: 'heartbeat',
}));
check('heartbeat 返回 200', hb1.status === 200, hb1.text);
check('heartbeat fencingToken 不变', hb1.json?.lease?.fencingToken === ftA, hb1.text);

// ── 4. 非持有者 heartbeat 被拒绝 ─────────────────────────────────────────────
const hbRejected = await post(`${BASE}/heartbeat`, makeProof(deviceB, {
  requestId: 'http_req_b_hb',
  leaseId,
  fencingToken: ftA,
  operation: 'heartbeat',
}));
check('非持有者 heartbeat 返回 4xx', hbRejected.status >= 400 && hbRejected.status < 500,
  `status=${hbRejected.status}`);

// ── 5. 接管（deviceA 离线，TTL 到期后 deviceB 接管）─────────────────────────
// 推进时钟超出 TTL（默认 60s）+ grace（默认 30s）
now += 120_000;

const acqB = await post(`${BASE}/acquire`, makeProof(deviceB, {
  requestId: 'http_req_b1',
  operation: 'acquire',
}));
check('TTL 到期后 deviceB 接管返回 200', acqB.status === 200, acqB.text);
check('接管后 holder=deviceB', acqB.json?.lease?.holderInstanceId === deviceB.instanceId, acqB.text);
const ftB = acqB.json?.lease?.fencingToken;
check('接管后 fencingToken 递增', typeof ftB === 'number' && ftB > ftA, `ftB=${ftB} ftA=${ftA}`);
const leaseIdB = acqB.json?.lease?.leaseId;

// ── 6. 旧持有者 (deviceA) heartbeat 被 fence 拒绝 ────────────────────────────
const oldHb = await post(`${BASE}/heartbeat`, makeProof(deviceA, {
  requestId: 'http_req_a_old_hb',
  leaseId,          // 已失效的旧 leaseId
  fencingToken: ftA, // 旧 fencingToken
  operation: 'heartbeat',
}));
check('旧 holder 被 fence 拒绝 (4xx)', oldHb.status >= 400 && oldHb.status < 500,
  `status=${oldHb.status}`);

// ── 7. deviceB complete（正常完成）──────────────────────────────────────────
// completeRefreshLease 返回: { completed, outcome, lease, credential }
// 有效 outcome: 'success' | 'failed' | 'uncertain' | 'released'
const done = await post(`${BASE}/complete`, makeProof(deviceB, {
  requestId: 'http_req_b_complete',
  leaseId: leaseIdB,
  fencingToken: ftB,
  outcome: 'success',
  operation: 'complete',
}));
check('complete 返回 200', done.status === 200, done.text);
check('complete outcome=success', done.json?.outcome === 'success', done.text);

// ── 8. release（主动放弃，走 /release 路由）──────────────────────────────────
// 先 acquire 一个新 lease
const acqA2 = await post(`${BASE}/acquire`, makeProof(deviceA, {
  requestId: 'http_req_a2',
  operation: 'acquire',
}));
check('二次 acquire 成功', acqA2.status === 200, acqA2.text);
const leaseId2 = acqA2.json?.lease?.leaseId;
const ftA2 = acqA2.json?.lease?.fencingToken;

// /release 路由：body 不传 outcome，路由层补填 'released'
const releaseBody = makeProof(deviceA, {
  requestId: 'http_req_a_release',
  leaseId: leaseId2,
  fencingToken: ftA2,
  operation: 'complete',  // release 路由在内部将 operation 设为 'complete'
});
// 删除 operation 字段（让路由层补填）以测试路由层 outcome 补填逻辑
const rel = await post(`${BASE}/release`, releaseBody);
check('release 返回 200', rel.status === 200, rel.text);
check('release outcome=released', rel.json?.outcome === 'released', rel.text);

// ── 9. 签名错误 → 401 ────────────────────────────────────────────────────────
const badProof = makeProof(deviceA, { requestId: 'http_req_bad', operation: 'acquire' });
badProof.signature = badProof.signature.slice(0, -4) + 'XXXX'; // 篡改签名
const badSig = await post(`${BASE}/acquire`, badProof);
check('错误签名返回 401', badSig.status === 401, `status=${badSig.status} body=${badSig.text}`);

// ── 10. 跨账户越权 → 4xx ─────────────────────────────────────────────────────
// rogue 属于 acct_other，但 proof 里声明的是 acct_main → binding 校验失败
const rogueProof = makeProof(rogue, { requestId: 'http_req_rogue', operation: 'acquire' });
const rogueResp = await post(`${BASE}/acquire`, rogueProof);
check('跨账户越权返回 4xx', rogueResp.status >= 400 && rogueResp.status < 500,
  `status=${rogueResp.status}`);

// ── 11. 不存在的 action 路由不匹配（由外层返回 404）────────────────────────
const unknownResp = await post(`${BASE}/unknown-action`, {});
check('未知 lease action 返回 404', unknownResp.status === 404, `status=${unknownResp.status}`);

server.close();

// ── 结果汇报 ─────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(
  `\ntest-accounts-refresh-lease-http: ${passed} assertions passed (dual-device HTTP simulation OK)`,
);
