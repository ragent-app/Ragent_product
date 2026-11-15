#!/usr/bin/env node
// instance_poll 交付协议的 Accounts broker 契约测试（阶段 2）。
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'ragent-owner-auth-poll-broker-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signInstanceProof,
  signOwnerAuthPollProof,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-identity.mjs')).href);
const { createOwnerAuthBroker, deriveDesktopReplayValues, OWNER_AUTH_TRANSACTION_TTL_MS } = await import(pathToFileURL(join(repoRoot, 'accounts', 'owner-auth-broker.mjs')).href);

let now = Date.parse('2026-08-21T12:00:00.000Z');
let state = {};
const store = { mutate: async (mutator) => mutator(state) };
const identity = await loadOrCreateInstanceIdentity();
const secondIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'other.json') });

const issuedAt = () => new Date(now).toISOString();
const REQUEST_PATH = (tx) => `/v1/owner-auth/transactions/${tx}/instance-redeem`;

function startPollProof({ actor = identity, transactionId = 'poll_tx_1', purpose = 'bind' } = {}) {
  const signature = signInstanceProof(actor, {
    transactionId, purpose, returnUrl: '', issuedAt: issuedAt(), audience: 'ragent-owner-auth-poll',
  });
  return {
    transactionId, purpose, deliveryMode: 'instance_poll',
    instance: publicInstanceIdentity(actor), issuedAt: issuedAt(),
    audience: 'ragent-owner-auth-poll', signature: signature.signature,
  };
}

function pollRedeemProof({ actor = identity, transactionId = 'poll_tx_1', requestId = 'opll_request_1', purpose = 'bind', deliveryMode = 'instance_poll', issuedAtMs = now, requestPath } = {}) {
  const at = new Date(issuedAtMs).toISOString();
  const signature = signOwnerAuthPollProof(actor, {
    transactionId, requestId, purpose, deliveryMode, issuedAt: at, requestPath: requestPath || REQUEST_PATH(transactionId),
  });
  return {
    requestId, purpose, deliveryMode,
    instance: publicInstanceIdentity(actor), issuedAt: at,
    audience: 'ragent-owner-auth-poll', signature: signature.signature,
  };
}

const auditEvents = [];
const signedClaims = [];
const broker = createOwnerAuthBroker({
  store,
  clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'google-subject-poll' }),
  resolveAccount: async () => ({ accountId: 'acct_poll_1' }),
  signAssertion: async (claims) => {
    signedClaims.push(claims);
    return `poll-signed:${claims.sub}:${claims.purpose}:${claims.tx}:${claims.jti}`;
  },
  audit: (event) => auditEvents.push(event),
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const started = await broker.start(startPollProof());
  await check('instance_poll 事务不需要 returnUrl 即可创建', async () => {
    assert.equal(started.deliveryMode, 'instance_poll');
    assert.match(started.bootstrap, /^ob_/);
    const record = state.ownerAuthTransactions.find((item) => item.id === 'poll_tx_1');
    assert.equal(record.deliveryMode, 'instance_poll');
    assert.equal(Object.hasOwn(record, 'returnUrl'), false);
  });

  await check('browser_callback 事务缺 returnUrl 仍被拒绝', async () => {
    const signature = signInstanceProof(identity, {
      transactionId: 'cb_tx_no_url', purpose: 'bind', returnUrl: '', issuedAt: issuedAt(), audience: 'ragent-owner-auth',
    });
    await assert.rejects(() => broker.start({
      transactionId: 'cb_tx_no_url', purpose: 'bind', deliveryMode: 'browser_callback',
      instance: publicInstanceIdentity(identity), issuedAt: issuedAt(),
      audience: 'ragent-owner-auth', signature: signature.signature,
    }), { code: 'owner_auth_request_invalid' });
  });

  // 手机侧完成流程与 callback 模式共用（QR → phone GIS）
  const desktopReplay = deriveDesktopReplayValues({
    transactionId: 'poll_tx_1',
    bootstrap: started.bootstrap,
    deliveryMode: 'instance_poll',
  });
  const desktop = await broker.beginDesktop({ transactionId: 'poll_tx_1', bootstrap: started.bootstrap, desktopState: desktopReplay.desktopState });
  await check('poll 模式电脑页不签发 delivery grant', async () => {
    assert.match(desktop.phoneTicket, /^opt_/);
    assert.equal(desktop.deliveryGrant, undefined);
    assert.equal(state.ownerAuthTransactions.find((item) => item.id === 'poll_tx_1').grantHash, '');
  });

  const phone = await broker.beginPhone({ transactionId: 'poll_tx_1', phoneTicket: desktop.phoneTicket, phoneState: 'phone_state_1' });
  await check('手机 ticket 在 poll 模式下仍一次性有效', async () => {
    assert.match(phone.nonce, /^nonce_/);
  });

  const pending = await broker.instanceRedeem(
    { transactionId: 'poll_tx_1', ...pollRedeemProof() },
    { requestPath: REQUEST_PATH('poll_tx_1') },
  );
  await check('未完成时返回 pending 与 retryAfterMs', async () => {
    assert.deepEqual(pending, { status: 'pending', expiresAt: started.expiresAt, retryAfterMs: 2000 });
  });

  await broker.completePhoneGoogleCredential({ transactionId: 'poll_tx_1', phoneState: 'phone_state_1', idToken: 'google-id-token' });

  const completed = await broker.instanceRedeem(
    { transactionId: 'poll_tx_1', ...pollRedeemProof() },
    { requestPath: REQUEST_PATH('poll_tx_1') },
  );
  await check('完成后原实例 proof 领取短时断言', async () => {
    assert.equal(completed.status, 'completed');
    assert.match(completed.assertion, /^poll-signed:acct_poll_1:bind:poll_tx_1:/);
    assert.ok(Date.parse(completed.expiresAt) > now);
  });

  const replay = await broker.instanceRedeem(
    { transactionId: 'poll_tx_1', ...pollRedeemProof() },
    { requestPath: REQUEST_PATH('poll_tx_1') },
  );
  await check('同 requestId 重试在保留窗口内返回同一断言（幂等）', async () => {
    assert.equal(replay.assertion, completed.assertion);
    assert.equal(signedClaims.filter((claims) => claims.tx === 'poll_tx_1').length, 1);
  });

  await check('不同 requestId 在首次领取后被拒绝', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof({ requestId: 'opll_request_other' }) },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_request_id_conflict' },
    );
  });

  await check('错误实例 proof 被拒绝', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof({ actor: secondIdentity }) },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_instance_mismatch' },
    );
  });

  await check('错误 audience 的 canonical message 被拒绝', async () => {
    const signature = signOwnerAuthPollProof(identity, {
      transactionId: 'poll_tx_1', requestId: 'opll_request_1', purpose: 'bind', deliveryMode: 'instance_poll',
      issuedAt: issuedAt(), requestPath: REQUEST_PATH('poll_tx_1'), audience: 'ragent-owner-auth',
    });
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', requestId: 'opll_request_1', purpose: 'bind', deliveryMode: 'instance_poll', instance: publicInstanceIdentity(identity), issuedAt: issuedAt(), audience: 'ragent-owner-auth', signature: signature.signature },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_request_invalid' },
    );
  });

  await check('篡改请求路径破坏签名', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof() },
        { requestPath: `/v1/owner-auth/transactions/poll_tx_1/other-path` },
      ),
      { code: 'owner_auth_proof_invalid' },
    );
  });

  await check('过期 issuedAt proof 被拒绝', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof({ issuedAtMs: now - 3 * 60 * 1000 }) },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_proof_expired' },
    );
  });

  await check('错误 purpose 被拒绝', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof({ purpose: 'login' }) },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_request_invalid' },
    );
  });

  await check('事务不存在返回 transaction_invalid', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_missing', ...pollRedeemProof({ transactionId: 'poll_tx_missing' }) },
        { requestPath: REQUEST_PATH('poll_tx_missing') },
      ),
      { code: 'owner_auth_transaction_invalid' },
    );
  });

  // callback 事务不能走 poll 端点
  const callbackTx = 'cb_tx_1';
  const callbackReturn = `https://instance.example.test/api/auth/google/complete?tx=${callbackTx}`;
  const cbSignature = signInstanceProof(identity, {
    transactionId: callbackTx, purpose: 'bind', returnUrl: callbackReturn, issuedAt: issuedAt(), audience: 'ragent-owner-auth',
  });
  await broker.start({
    transactionId: callbackTx, purpose: 'bind', returnUrl: callbackReturn,
    instance: publicInstanceIdentity(identity), issuedAt: issuedAt(),
    audience: 'ragent-owner-auth', signature: cbSignature.signature,
  });
  await check('callback 事务访问 poll 端点被拒绝（delivery mode 不匹配）', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: callbackTx, ...pollRedeemProof({ transactionId: callbackTx }) },
        { requestPath: REQUEST_PATH(callbackTx) },
      ),
      { code: 'owner_auth_delivery_mode_mismatch' },
    );
  });

  await check('callback 事务记录保持 browser_callback 语义（旧路径回归）', async () => {
    const record = state.ownerAuthTransactions.find((item) => item.id === callbackTx);
    assert.equal((record.deliveryMode || 'browser_callback'), 'browser_callback');
    assert.equal(record.returnUrl, callbackReturn);
  });

  // 断言保留窗口过期
  now += 61 * 1000;
  await check('断言保留窗口过后不再可领取', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof() },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_assertion_expired' },
    );
  });

  // 事务过期
  now += OWNER_AUTH_TRANSACTION_TTL_MS;
  await check('事务过期后拒绝领取', async () => {
    await assert.rejects(
      () => broker.instanceRedeem(
        { transactionId: 'poll_tx_1', ...pollRedeemProof() },
        { requestPath: REQUEST_PATH('poll_tx_1') },
      ),
      { code: 'owner_auth_transaction_invalid' },
    );
  });

  await check('审计事件不含断言或账户身份', async () => {
    const pollEvents = auditEvents.filter((item) => item.event === 'instance_poll.redeemed');
    assert.ok(pollEvents.length >= 1);
    for (const event of pollEvents) {
      assert.equal(JSON.stringify(event).includes('poll-signed:'), false);
      assert.equal(event.accountId, undefined);
      assert.equal(event.sub, undefined);
    }
  });

  console.log(`test-owner-auth-instance-poll-broker: ${passed} assertions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
