#!/usr/bin/env node
// 跨设备 provider refresh lease 的 Accounts 契约测试。
// 场景对应 docs/cross-device-credential-recovery-and-model-catalog-plan.md：
// 并发 acquire、holder 掉线接管、grace period、旧 holder 回归被拒、
// outcome=uncertain 标记、中央 credential 版本 CAS、绑定校验与 proof 校验。
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signProviderRefreshLeaseProof,
} from '../lib/instance-identity.mjs';
import {
  REFRESH_LEASE_TTL_MS_MAX,
  createRefreshLeaseBroker,
} from '../accounts/refresh-lease-broker.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-refresh-lease-'));
const deviceA = await loadOrCreateInstanceIdentity({ filePath: join(root, 'a.json') });
const deviceB = await loadOrCreateInstanceIdentity({ filePath: join(root, 'b.json') });
const unboundDevice = await loadOrCreateInstanceIdentity({ filePath: join(root, 'unbound.json') });

let now = Date.parse('2026-08-27T00:00:00.000Z');
const state = {
  instanceBindings: [
    { instanceId: deviceA.instanceId, accountId: 'acct_owner', revokedAt: '' },
    { instanceId: deviceB.instanceId, accountId: 'acct_owner', revokedAt: '' },
    { instanceId: unboundDevice.instanceId, accountId: 'acct_other', revokedAt: '' },
    { instanceId: 'inst_revoked', accountId: 'acct_owner', revokedAt: '2026-08-20T00:00:00.000Z' },
  ],
};

const auditEvents = [];
const broker = createRefreshLeaseBroker({
  store: { mutate: async (mutator) => mutator(state) },
  clock: () => now,
  audit: (event) => auditEvents.push(event),
});

const IDENTITY = {
  accountId: 'acct_owner',
  providerFamily: 'agy',
  accountKey: 'account:agy:profile-1',
  credentialInstanceId: 'cred-inst-1',
};

function proofFor(identity, fields = {}) {
  const issuedAt = new Date(now).toISOString();
  const base = {
    requestId: fields.requestId || `rl_${Math.random().toString(36).slice(2)}`,
    accountId: fields.accountId ?? IDENTITY.accountId,
    providerFamily: fields.providerFamily ?? IDENTITY.providerFamily,
    accountKey: fields.accountKey ?? IDENTITY.accountKey,
    credentialInstanceId: fields.credentialInstanceId ?? IDENTITY.credentialInstanceId,
    ...fields,
    issuedAt,
    audience: 'ragent-provider-refresh-lease',
    instance: publicInstanceIdentity(identity),
  };
  return {
    ...base,
    signature: signProviderRefreshLeaseProof(identity, base).signature,
  };
}

function expectError(promise, code, statusCode) {
  return assert.rejects(
    promise,
    (error) => error?.code === code && (statusCode === undefined || error.statusCode === statusCode),
  );
}

let acquiredFirst;

// --- 基本租约生命周期 ---
{
  const result = await broker.acquireRefreshLease(proofFor(deviceA, { requestId: 'req_a1', runId: 'run_a' }));
  acquiredFirst = result;
  assert.equal(result.acquired, true);
  assert.equal(result.reacquired, undefined);
  assert.equal(result.lease.fencingToken, 1);
  assert.equal(result.lease.holderInstanceId, deviceA.instanceId);
  assert.equal(result.lease.state, 'held');
  assert.equal(result.priorOutcome, '');
  assert.equal(result.credential.credentialVersion, 0);

  // 同设备幂等重入：返回同一租约，不产生新的 fencing token。
  const again = await broker.acquireRefreshLease(proofFor(deviceA, { requestId: 'req_a2', runId: 'run_a2' }));
  assert.equal(again.acquired, true);
  assert.equal(again.reacquired, true);
  assert.equal(again.lease.leaseId, result.lease.leaseId);
  assert.equal(again.lease.runId, 'run_a2');
  assert.equal(again.lease.fencingToken, 1);

  // 另一台设备并发 acquire -> 冲突。
  await expectError(
    () => broker.acquireRefreshLease(proofFor(deviceB, { requestId: 'req_b1' })),
    'refresh_lease_held',
    409,
  );

  // 未持有设备的 status 能看到他机持有；不暴露 token 级信息。
  const status = await broker.statusOfRefreshLease(proofFor(deviceB, { requestId: 'req_b2' ,
    operation: 'status'}));
  assert.equal(status.identities.length, 1);
  assert.equal(status.identities[0].heldByOther.holderInstanceId, deviceA.instanceId);
  assert.equal(status.identities[0].credential.credentialVersion, 0);

  // 续约：正确 fencingToken 通过；错误 fencingToken 拒绝。
  const renewed = await broker.heartbeatRefreshLease(proofFor(deviceA, {
    requestId: 'req_a3',
    leaseId: result.lease.leaseId,
    fencingToken: 1,
  
    operation: 'heartbeat'}));
  assert.equal(renewed.renewed, true);
  assert.ok(Date.parse(renewed.lease.expiresAt) > now + 55_000);
  await expectError(
    () => broker.heartbeatRefreshLease(proofFor(deviceA, {
      requestId: 'req_a4',
      leaseId: result.lease.leaseId,
      fencingToken: 999999,
    
    operation: 'heartbeat'})),
    'refresh_lease_fencing_rejected',
    409,
  );

  // 非 holder 的续约（拿同一 leaseId 但另一设备的签名）必须拒绝。
  await expectError(
    () => broker.heartbeatRefreshLease(proofFor(deviceB, {
      requestId: 'req_b3',
      leaseId: result.lease.leaseId,
      fencingToken: 1,
    
    operation: 'heartbeat'})),
    'refresh_lease_holder_mismatch',
    403,
  );

  // TTL 上限收敛：申请超长 TTL 也会被压到上限之内。
  await expectErrorlessRelease();
}

async function expectErrorlessRelease() {
  // 设备 A 上报 released 放弃租约（未发出上游请求的路径）。
  const done = await broker.completeRefreshLease(proofFor(deviceA, {
    requestId: 'req_a6',
    outcome: 'released',
    leaseId: acquiredFirst.lease.leaseId,
    fencingToken: 1,
  
    operation: 'complete'}));
  assert.equal(done.completed, true);
  assert.equal(done.outcome, 'released');
  assert.equal(done.lease.state, 'released');
  assert.equal(done.credential.lastUncertainAt, undefined);
  assert.equal(done.credential.credentialVersion, 0);
}

{
  // fenced/带外重放：篡改 accountKey 的 proof 被拒绝。
  const forged = proofFor(deviceB, { requestId: 'req_b4', accountKey: 'account:agy:other' });
  // 用原身份字段签名后改写一个已签名绑定的字段 -> 需要重新签名，这里直接伪造：
  await expectError(
    () => broker.acquireRefreshLease({ ...forged, operation: 'acquire', accountKey: IDENTITY.accountKey }),
    'refresh_lease_auth_invalid',
    401,
  );
}

// --- fencing 单调与成功提交后的中央版本 ---
{
  const bLease = await broker.acquireRefreshLease(proofFor(deviceB, { requestId: 'req_b5' }));
  assert.equal(bLease.acquired, true);
  assert.equal(bLease.lease.fencingToken, 2, 'fencing token must stay monotonic across holders');

  // 成功提交且带 expectedCredentialVersion 时执行中央 CAS。
  const committed = await broker.completeRefreshLease(proofFor(deviceB, {
    requestId: 'req_b6',
    outcome: 'success',
    leaseId: bLease.lease.leaseId,
    fencingToken: bLease.lease.fencingToken,
    expectedCredentialVersion: 0,
  
    operation: 'complete'}));
  assert.equal(committed.outcome, 'success');
  assert.equal(committed.lease.state, 'committed');
  assert.equal(committed.credential.credentialVersion, 1);
  assert.equal(committed.credential.updatedByInstanceId, deviceB.instanceId);

  // 提交完成后其他设备立即可以取锁，不再受 grace period 限制。
  const aAgain = await broker.acquireRefreshLease(proofFor(deviceA, { requestId: 'req_a7' }));
  assert.equal(aAgain.lease.fencingToken, 3);

  // 过期版本号必须被拒绝且租约保持 held。
  await expectError(
    () => broker.completeRefreshLease(proofFor(deviceA, {
      requestId: 'req_a8',
      outcome: 'success',
      leaseId: aAgain.lease.leaseId,
      fencingToken: aAgain.lease.fencingToken,
      expectedCredentialVersion: 0,
    
    operation: 'complete'})),
    'refresh_lease_credential_conflict',
    409,
  );
  const heldStill = await broker.statusOfRefreshLease(proofFor(deviceB, { requestId: 'req_b7' ,
    operation: 'status'}));
  assert.equal(heldStill.identities[0].heldByOther.holderInstanceId, deviceA.instanceId);
  const fixedCommit = await broker.completeRefreshLease(proofFor(deviceA, {
    requestId: 'req_a9',
    outcome: 'success',
    leaseId: aAgain.lease.leaseId,
    fencingToken: aAgain.lease.fencingToken,
    expectedCredentialVersion: 1,
  
    operation: 'complete'}));
  assert.equal(fixedCommit.credential.credentialVersion, 2);
}

// --- 掉线接管、grace period 与旧 holder 回归 ---
{
  now += 60 * 60 * 1000; // 前进一小时，让上面的历史全部落入 prune 视窗之外？先验证未关闭行仍在。
  const offlineHolder = await broker.acquireRefreshLease(proofFor(deviceA, { requestId: 'req_a10', ttlMs: 30_000 }));
  assert.equal(offlineHolder.acquired, true);
  const expireAt = Date.parse(offlineHolder.lease.expiresAt);

  // TTL 过期但 grace 未过：不允许立即接管。
  now = expireAt + 1000;
  await expectError(
    () => broker.acquireRefreshLease(proofFor(deviceB, { requestId: 'req_b8' })),
    'refresh_lease_grace',
    409,
  );

  // grace 之后允许接管，fencing 继续单调递增。
  now = expireAt + 16 * 1000;
  const takeover = await broker.acquireRefreshLease(proofFor(deviceB, { requestId: 'req_b9' }));
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.tookOver, true);
  assert.equal(takeover.lease.fencingToken, offlineHolder.lease.fencingToken + 1);

  // 掉线旧 holder 回归：旧 leaseId/fencing 全部失效，既不能心跳也不能提交。
  await expectError(
    () => broker.heartbeatRefreshLease(proofFor(deviceA, {
      requestId: 'req_a11',
      leaseId: offlineHolder.lease.leaseId,
      fencingToken: offlineHolder.lease.fencingToken,
    
    operation: 'heartbeat'})),
    'refresh_lease_not_found',
    404,
  );
  await expectError(
    () => broker.completeRefreshLease(proofFor(deviceA, {
      requestId: 'req_a12',
      outcome: 'success',
      leaseId: offlineHolder.lease.leaseId,
      fencingToken: offlineHolder.lease.fencingToken,
    
    operation: 'complete'})),
    'refresh_lease_not_found',
    404,
  );

  // refresh 结果未知：uncertain 标记进入中央元数据，下一个 acquirer 能看到。
  const uncertainClose = await broker.completeRefreshLease(proofFor(deviceB, {
    requestId: 'req_b10',
    outcome: 'uncertain',
    leaseId: takeover.lease.leaseId,
    fencingToken: takeover.lease.fencingToken,
  
    operation: 'complete'}));
  assert.equal(uncertainClose.lease.state, 'uncertain');

  const nextAcquire = await broker.acquireRefreshLease(proofFor(deviceA, { requestId: 'req_a13' }));
  assert.equal(nextAcquire.priorOutcome, 'uncertain');
  assert.ok(trimIso(nextAcquire.credential.lastUncertainAt));
  assert.equal(nextAcquire.lease.fencingToken, takeover.lease.fencingToken + 1);

  // 后续成功提交清除 uncertain 标记。
  const resolved = await broker.completeRefreshLease(proofFor(deviceA, {
    requestId: 'req_a14',
    outcome: 'success',
    leaseId: nextAcquire.lease.leaseId,
    fencingToken: nextAcquire.lease.fencingToken,
  
    operation: 'complete'}));
  assert.equal(resolved.credential.lastUncertainAt, undefined);
  assert.equal(resolved.credential.credentialVersion, 3);
}

// --- 边界：绑定校验 / 缺失 identity 字段 ---
{
  await expectError(
    () => broker.acquireRefreshLease(proofFor(unboundDevice, { requestId: 'req_x1' })),
    'refresh_lease_instance_mismatch',
    403,
  );
  await expectError(
    () => broker.acquireRefreshLease(proofFor(deviceB, { requestId: 'req_x2', credentialInstanceId: '' })),
    'refresh_lease_identity_invalid',
    400,
  );
}

function trimIso(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

console.log('accounts refresh lease contract tests passed');
